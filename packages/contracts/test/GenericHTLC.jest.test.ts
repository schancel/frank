/**
 * GenericHTLC v2, deployed to and executed by a local anvil node.
 */
import { ethers } from 'ethers'
import { GenericHTLC } from '../index'
import {
  deploy,
  expectRevert,
  mined,
  startAnvil,
  testContract,
  type Anvil,
} from './anvil'

const ONE_HOUR = 3600
const THIRTY_DAYS = 30 * 24 * ONE_HOUR
const AMOUNT = ethers.parseEther('1')
const NATIVE = ethers.ZeroAddress
const GAS = 1_000_000n

const State = { None: 0n, Open: 1n, Withdrawn: 2n, Refunded: 3n } as const

describe('GenericHTLC v2 on a local EVM node', () => {
  let anvil: Anvil
  let htlc: ethers.Contract
  let token: ethers.Contract
  let sender: ethers.HDNodeWallet
  let recipient: ethers.HDNodeWallet
  let refundTo: ethers.HDNodeWallet
  let stranger: ethers.HDNodeWallet
  let htlcAddress: string

  const preimage = ethers.hexlify(ethers.randomBytes(32))
  const hashLock = ethers.sha256(preimage)
  const wrongPreimage = ethers.hexlify(ethers.randomBytes(32))
  const balance = (who: { address: string } | string) =>
    anvil.provider.getBalance(typeof who === 'string' ? who : who.address)
  const as = (who: ethers.Signer) => htlc.connect(who) as ethers.Contract
  const latestTime = async () => (await anvil.provider.getBlock('latest'))!.timestamp
  // Default terms vary per lock (amount and a few seconds of expiry), so two locks of a test
  // never collide on an id even when blocks share a timestamp.
  let nonce = 0n
  const nextAmount = () => AMOUNT + ++nonce
  let skew = 0
  const nextSkew = () => ++skew % 600

  interface Terms {
    recipient: string
    refundAddress: string
    token: string
    amount: bigint
    hashLock: string
    expiresAt: bigint
  }
  const args = (t: Terms) =>
    [t.recipient, t.refundAddress, t.token, t.amount, t.hashLock, t.expiresAt] as const

  async function terms(opts: Partial<Terms> & { duration?: number } = {}): Promise<Terms> {
    return {
      recipient: opts.recipient ?? recipient.address,
      refundAddress: opts.refundAddress ?? refundTo.address,
      token: opts.token ?? NATIVE,
      amount: opts.amount ?? nextAmount(),
      hashLock: opts.hashLock ?? hashLock,
      expiresAt:
        opts.expiresAt ??
        BigInt((await latestTime()) + (opts.duration ?? ONE_HOUR) - nextSkew()),
    }
  }

  /** Opens a lock and returns its id, read from the Locked event and checked against lockIdOf. */
  async function open(
    t: Terms,
    from: ethers.Signer = sender,
  ): Promise<{ lockId: string; receipt: ethers.ContractTransactionReceipt }> {
    const value = t.token === NATIVE ? t.amount : 0n
    const receipt = await mined(as(from).lock(...args(t), { value }))
    const event = receipt.logs
      .map(log => htlc.interface.parseLog(log))
      .find(parsed => parsed?.name === 'Locked')!
    const lockId = event.args.lockId as string
    expect(lockId).toBe(
      await htlc.lockIdOf(await from.getAddress(), ...args(t)),
    )
    return { lockId, receipt }
  }

  async function lockNative(opts: Partial<Terms> & { duration?: number } = {}) {
    const t = await terms(opts)
    return { ...(await open(t)), terms: t }
  }

  async function lockToken(opts: Partial<Terms> = {}) {
    const t = await terms({ token: await token.getAddress(), ...opts })
    await mined((token.connect(sender) as ethers.Contract).mint(sender.address, t.amount))
    await mined((token.connect(sender) as ethers.Contract).approve(htlcAddress, t.amount))
    return { ...(await open(t)), terms: t }
  }

  const deferred = (receipt: ethers.ContractTransactionReceipt) =>
    receipt.logs
      .map(log => htlc.interface.parseLog(log))
      .filter(parsed => parsed?.name === 'PaymentDeferred')
      .map(parsed => ({
        to: parsed!.args.to as string,
        token: parsed!.args.token as string,
        amount: parsed!.args.amount as bigint,
      }))

  /** The next block is mined at exactly `timestamp`. */
  const setNextTimestamp = (timestamp: bigint | number) =>
    anvil.provider.send('evm_setNextBlockTimestamp', [Number(timestamp)])

  /**
   * Sends `method(...callArgs)` in a block mined at exactly `timestamp`, without estimating gas
   * first (an estimate runs at another time). Resolves with the receipt; a reverted call rejects
   * with the contract's revert data, read back by replaying it at the block it failed in.
   */
  async function sendAt(
    timestamp: bigint | number,
    from: ethers.Signer,
    method: string,
    callArgs: unknown[],
  ) {
    await setNextTimestamp(timestamp)
    const tx: ethers.ContractTransactionResponse = await as(from)[method](...callArgs, {
      gasLimit: GAS,
    })
    const receipt = await anvil.provider.waitForTransaction(tx.hash)
    expect((await anvil.provider.getBlock(receipt!.blockNumber))!.timestamp).toBe(
      Number(timestamp),
    )
    if (receipt!.status === 1) return receipt!
    // The failed transaction changed nothing, so the same call at its block shows why.
    await as(from)[method].staticCall(...callArgs, { blockTag: receipt!.blockNumber })
    throw new Error(`${method} reverted at ${timestamp} without revert data`)
  }

  beforeAll(async () => {
    anvil = await startAnvil()
    ;[sender, recipient, refundTo, stranger] = anvil.accounts
    htlc = await deploy(GenericHTLC, sender)
    htlcAddress = await htlc.getAddress()
    token = await deploy(testContract('TestToken'), sender)
  }, 60_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  it('runs the checked-in runtime bytecode', async () => {
    expect(await anvil.provider.getCode(htlcAddress)).toBe(GenericHTLC.deployedBytecode)
  })

  it('has exactly the v2 entry points: no keccak, no permit, no overloads', () => {
    const functions = new ethers.Interface(GenericHTLC.abi).fragments
      .filter(fragment => fragment.type === 'function')
      .map(fragment => fragment.format('sighash'))
      .sort()
    expect(functions).toEqual(
      [
        'MAX_LOCK_DURATION()',
        'PAYMENT_GAS()',
        'batchDistribute(bytes32[],(address,uint256)[],bytes32)',
        'batchWithdraw(bytes32[],bytes32)',
        'claimOwed(address,address)',
        'lock(address,address,address,uint256,bytes32,uint64)',
        'lockIdOf(address,address,address,address,uint256,bytes32,uint64)',
        'locks(bytes32)',
        'owed(address,address)',
        'refund(bytes32)',
        'withdraw(bytes32,bytes32)',
      ].sort(),
    )
  })

  describe('lock', () => {
    it('holds native coin and records the lock under the id derived from sender and terms', async () => {
      const before = await balance(htlcAddress)
      const { lockId, terms: t } = await lockNative()
      expect((await balance(htlcAddress)) - before).toBe(t.amount)
      expect(lockId).toBe(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'address', 'address', 'uint256', 'bytes32', 'uint64'],
            [sender.address, t.recipient, t.refundAddress, t.token, t.amount, t.hashLock, t.expiresAt],
          ),
        ),
      )

      const lock = await htlc.locks(lockId)
      expect(lock.sender).toBe(sender.address)
      expect(lock.recipient).toBe(recipient.address)
      expect(lock.refundAddress).toBe(refundTo.address)
      expect(lock.token).toBe(NATIVE)
      expect(lock.hashLock).toBe(hashLock)
      expect(lock.amount).toBe(t.amount)
      expect(lock.expiresAt).toBe(t.expiresAt)
      expect(lock.state).toBe(State.Open)
      expect(lock.preimage).toBe(ethers.ZeroHash)
    })

    it('pulls an ERC-20 from the sender', async () => {
      const before = await token.balanceOf(htlcAddress)
      const { lockId, terms: t } = await lockToken()
      expect((await token.balanceOf(htlcAddress)) - before).toBe(t.amount)
      expect(await token.balanceOf(sender.address)).toBe(0n)
      expect((await htlc.locks(lockId)).token).toBe(await token.getAddress())
    })

    it('cannot be squatted: another sender with the same terms gets another lock', async () => {
      const t = await terms()
      // The stranger sees the sender's terms (say, in the mempool) and locks them first.
      const squatted = await open(t, stranger)
      const mine = await open(t, sender)
      expect(mine.lockId).not.toBe(squatted.lockId)
      expect((await htlc.locks(mine.lockId)).sender).toBe(sender.address)
      expect((await htlc.locks(squatted.lockId)).sender).toBe(stranger.address)
    })

    it('refuses the same sender opening the same terms twice', async () => {
      const t = await terms({ duration: 2 * ONE_HOUR })
      await open(t)
      await expectRevert(as(sender).lock(...args(t), { value: t.amount }), 'LockAlreadyExists')
    })

    it('refuses zero addresses and a zero amount', async () => {
      const t = await terms()
      const lock = as(sender).lock
      await expectRevert(
        lock(...args({ ...t, recipient: NATIVE }), { value: t.amount }),
        'InvalidZeroAddress',
      )
      // No refund address defaulting: it must be given.
      await expectRevert(
        lock(...args({ ...t, refundAddress: NATIVE }), { value: t.amount }),
        'InvalidZeroAddress',
      )
      await expectRevert(lock(...args({ ...t, amount: 0n }), { value: 0n }), 'ZeroAmount')
    })

    it('needs msg.value equal to the amount for native coin, and zero for a token', async () => {
      const t = await terms()
      const lock = as(sender).lock
      await expectRevert(lock(...args(t), { value: t.amount - 1n }), 'InvalidValue')
      await expectRevert(lock(...args(t), { value: t.amount + 1n }), 'InvalidValue')
      const tokenTerms = await terms({ token: await token.getAddress() })
      await mined((token.connect(sender) as ethers.Contract).mint(sender.address, tokenTerms.amount))
      await mined((token.connect(sender) as ethers.Contract).approve(htlcAddress, tokenTerms.amount))
      await expectRevert(lock(...args(tokenTerms), { value: 1n }), 'InvalidValue')
      await mined((token.connect(sender) as ethers.Contract).approve(htlcAddress, 0))
      await expectRevert(lock(...args(tokenTerms)), 'TransferFailed')
      await mined((token.connect(sender) as ethers.Contract).transfer(stranger.address, tokenTerms.amount))
    })

    it('refuses a fee-on-transfer token and an address without code as the token', async () => {
      const fee = await deploy(testContract('FeeOnTransferToken'), sender)
      const feeAddress = await fee.getAddress()
      await mined((fee.connect(sender) as ethers.Contract).mint(sender.address, AMOUNT))
      await mined((fee.connect(sender) as ethers.Contract).approve(htlcAddress, AMOUNT))
      const t = await terms({ token: feeAddress, amount: AMOUNT })
      await expectRevert(as(sender).lock(...args(t)), 'UnsupportedToken')
      expect(await fee.balanceOf(htlcAddress)).toBe(0n)

      const eoa = await terms({ token: stranger.address })
      await expectRevert(as(sender).lock(...args(eoa)), 'UnsupportedToken')
    })

    it('takes an absolute deadline after the lock block and at most 30 days later', async () => {
      const now = BigInt(await latestTime()) + 10n
      let offset = 0n
      // Locks in a block mined at a known time, with `expiresAt` that far after it.
      const attempt = async (delta: bigint) => {
        const blockTime = now + offset++
        const t = await terms({ expiresAt: blockTime + delta })
        await setNextTimestamp(blockTime)
        const tx = await as(sender).lock(...args(t), { value: t.amount, gasLimit: GAS })
        const receipt = await anvil.provider.waitForTransaction(tx.hash)
        if (receipt!.status === 1) return 'locked'
        await as(sender).lock.staticCall(...args(t), {
          value: t.amount,
          blockTag: receipt!.blockNumber,
        })
        return 'reverted without data'
      }
      await expectRevert(attempt(0n), 'InvalidExpiry')
      await expectRevert(attempt(-1n), 'InvalidExpiry')
      await expectRevert(attempt(BigInt(THIRTY_DAYS) + 1n), 'InvalidExpiry')
      expect(await attempt(1n)).toBe('locked')
      expect(await attempt(BigInt(THIRTY_DAYS))).toBe('locked')
      expect(await htlc.MAX_LOCK_DURATION()).toBe(BigInt(THIRTY_DAYS))
    })
  })

  describe('withdraw', () => {
    it('pays the recipient for the right preimage, whoever sends it, and keeps the preimage readable', async () => {
      const { lockId, terms: t } = await lockNative()
      const before = await balance(recipient)
      const receipt = await mined(as(stranger).withdraw(lockId, preimage))
      expect((await balance(recipient)) - before).toBe(t.amount)

      const lock = await htlc.locks(lockId)
      expect(lock.state).toBe(State.Withdrawn)
      expect(lock.preimage).toBe(preimage)
      expect(ethers.sha256(lock.preimage)).toBe(lock.hashLock)

      const event = receipt.logs
        .map(log => htlc.interface.parseLog(log))
        .find(parsed => parsed?.name === 'Withdrawn')
      expect(event?.args.preimage).toBe(preimage)
      expect(deferred(receipt)).toEqual([])
    })

    it('accepts only a 32-byte preimage whose sha256 is the hash lock', async () => {
      // keccak256 locks are not supported any more.
      const keccak = await lockNative({ hashLock: ethers.keccak256(preimage) })
      await expectRevert(as(stranger).withdraw(keccak.lockId, preimage), 'InvalidPreimage')

      // A 31-byte secret cannot be presented: padded to 32 bytes it hashes differently.
      const short = ethers.hexlify(ethers.randomBytes(31))
      const shortLock = await lockNative({ hashLock: ethers.sha256(short) })
      await expectRevert(
        as(stranger).withdraw(shortLock.lockId, ethers.zeroPadBytes(short, 32)),
        'InvalidPreimage',
      )
      await expectRevert(
        as(stranger).withdraw(shortLock.lockId, ethers.zeroPadValue(short, 32)),
        'InvalidPreimage',
      )
      // Calldata carrying fewer than 32 bytes of preimage does not decode at all.
      const full = htlc.interface.encodeFunctionData('withdraw', [shortLock.lockId, preimage])
      const truncated = await stranger.sendTransaction({
        to: htlcAddress,
        data: full.slice(0, full.length - 2),
        gasLimit: GAS,
      })
      expect((await anvil.provider.waitForTransaction(truncated.hash))?.status).toBe(0)

      const wrong = await lockNative()
      const held = await balance(htlcAddress)
      await expectRevert(as(recipient).withdraw(wrong.lockId, wrongPreimage), 'InvalidPreimage')
      await expectRevert(as(recipient).withdraw(ethers.ZeroHash, preimage), 'LockNotFound')
      expect(await balance(htlcAddress)).toBe(held)
      expect((await htlc.locks(wrong.lockId)).state).toBe(State.Open)
    })

    it('pays an ERC-20 lock to the recipient', async () => {
      const { lockId, terms: t } = await lockToken()
      const before = await token.balanceOf(recipient.address)
      await mined(as(stranger).withdraw(lockId, preimage))
      expect((await token.balanceOf(recipient.address)) - before).toBe(t.amount)
    })

    it('pays a lock once: no second withdraw and no refund after a withdraw', async () => {
      const { lockId, terms: t } = await lockNative()
      await mined(as(stranger).withdraw(lockId, preimage))
      const held = await balance(htlcAddress)
      await expectRevert(as(stranger).withdraw(lockId, preimage), 'AlreadyWithdrawn')
      await sendAt(t.expiresAt + 1n, stranger, 'refund', [lockId]).then(
        () => {
          throw new Error('refund after withdraw succeeded')
        },
        err => expectRevert(Promise.reject(err), 'AlreadyWithdrawn'),
      )
      expect(await balance(htlcAddress)).toBe(held)
    })

    it('works at expiresAt - 1 and is refused at expiresAt', async () => {
      const early = await lockNative()
      const late = await lockNative({ expiresAt: early.terms.expiresAt + 1n })

      await sendAt(early.terms.expiresAt - 1n, stranger, 'withdraw', [early.lockId, preimage])
      expect((await htlc.locks(early.lockId)).state).toBe(State.Withdrawn)

      // Otherwise a recipient could reveal the preimage after the sender's leg refunded.
      const held = await balance(htlcAddress)
      await expectRevert(
        sendAt(late.terms.expiresAt, recipient, 'withdraw', [late.lockId, preimage]),
        'LockExpired',
      )
      await expectRevert(as(recipient).batchWithdraw([late.lockId], preimage), 'LockExpired')
      expect(await balance(htlcAddress)).toBe(held)
      expect((await htlc.locks(late.lockId)).state).toBe(State.Open)

      const refundBefore = await balance(refundTo)
      await mined(as(stranger).refund(late.lockId))
      expect((await balance(refundTo)) - refundBefore).toBe(late.terms.amount)
    })

    it('is refused long after the expiry', async () => {
      const { lockId } = await lockNative()
      await anvil.advanceTime(10 * ONE_HOUR)
      await expectRevert(as(recipient).withdraw(lockId, preimage), 'LockExpired')
      expect((await htlc.locks(lockId)).state).toBe(State.Open)
    })

    it('does not let a recipient contract take a second lock from inside its payment', async () => {
      const attacker = await deploy(testContract('ReentrantRecipient'), stranger, [htlcAddress])
      const attackerAddress = await attacker.getAddress()
      const first = await lockNative({ recipient: attackerAddress })
      const second = await lockNative({ recipient: attackerAddress })
      await mined((attacker.connect(stranger) as ethers.Contract).arm(second.lockId, preimage))

      const receipt = await mined(as(stranger).withdraw(first.lockId, preimage))

      expect(await attacker.attempted()).toBe(true)
      expect(await attacker.reentrySucceeded()).toBe(false)
      expect(deferred(receipt)).toEqual([])
      expect(await balance(attackerAddress)).toBe(first.terms.amount)
      expect((await htlc.locks(second.lockId)).state).toBe(State.Open)
    })

    it('defers the payment to a recipient that refuses coin, which collects it with claimOwed', async () => {
      const rejecting = await deploy(testContract('RejectingRecipient'), stranger)
      const rejectingAddress = await rejecting.getAddress()
      const { lockId, terms: t } = await lockNative({ recipient: rejectingAddress })

      // The withdraw lands: the recipient's refusal does not block it.
      const receipt = await mined(as(stranger).withdraw(lockId, preimage))
      expect(deferred(receipt)).toEqual([{ to: rejectingAddress, token: NATIVE, amount: t.amount }])
      expect((await htlc.locks(lockId)).state).toBe(State.Withdrawn)
      expect((await htlc.locks(lockId)).preimage).toBe(preimage)
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(t.amount)
      expect(await balance(rejectingAddress)).toBe(0n)

      // Still refusing: claiming fails and keeps the credit.
      const claim = (rejecting.connect(stranger) as ethers.Contract).claim
      await expectRevert(claim(htlcAddress, NATIVE), 'TransferFailed')
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(t.amount)

      await mined((rejecting.connect(stranger) as ethers.Contract).setAccepting(true))
      await mined(claim(htlcAddress, NATIVE))
      expect(await balance(rejectingAddress)).toBe(t.amount)
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(0n)
      await expectRevert(claim(htlcAddress, NATIVE), 'NothingOwed')
    })

    it('lets a creditor that cannot take coin direct its credit to another address', async () => {
      const rejecting = await deploy(testContract('RejectingRecipient'), stranger)
      const rejectingAddress = await rejecting.getAddress()
      const { lockId, terms: t } = await lockNative({ recipient: rejectingAddress })
      await mined(as(stranger).withdraw(lockId, preimage))
      const claimTo = (rejecting.connect(stranger) as ethers.Contract).claimTo

      // Directed to itself (still refusing) it fails and keeps the credit; to nowhere is refused.
      await expectRevert(claimTo(htlcAddress, NATIVE, rejectingAddress), 'TransferFailed')
      await expectRevert(claimTo(htlcAddress, NATIVE, NATIVE), 'InvalidZeroAddress')
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(t.amount)

      const elsewhere = ethers.Wallet.createRandom().address
      const receipt = await mined(claimTo(htlcAddress, NATIVE, elsewhere))
      expect(await balance(elsewhere)).toBe(t.amount)
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(0n)
      const claimed = receipt.logs
        .filter(log => log.address === htlcAddress)
        .map(log => htlc.interface.parseLog(log))
        .find(parsed => parsed?.name === 'OwedClaimed')
      expect([...claimed!.args]).toEqual([rejectingAddress, NATIVE, elsewhere, t.amount])
      // Someone else cannot spend that credit.
      await expectRevert(as(stranger).claimOwed(NATIVE, stranger.address), 'NothingOwed')
    })

    it('defers a token payment the token refuses', async () => {
      const tokenAddress = await token.getAddress()
      const { lockId, terms: t } = await lockToken()
      await mined((token.connect(sender) as ethers.Contract).setBlocked(recipient.address, true))
      const receipt = await mined(as(stranger).withdraw(lockId, preimage))
      expect(deferred(receipt)).toEqual([{ to: recipient.address, token: tokenAddress, amount: t.amount }])
      expect(await htlc.owed(recipient.address, tokenAddress)).toBe(t.amount)

      await expectRevert(as(recipient).claimOwed(tokenAddress, recipient.address), 'TransferFailed')
      await mined((token.connect(sender) as ethers.Contract).setBlocked(recipient.address, false))
      const before = await token.balanceOf(recipient.address)
      await mined(as(recipient).claimOwed(tokenAddress, recipient.address))
      expect((await token.balanceOf(recipient.address)) - before).toBe(t.amount)
      expect(await htlc.owed(recipient.address, tokenAddress)).toBe(0n)
    })
  })

  describe('refund', () => {
    it('is refused before expiresAt and pays only the refund address from expiresAt on', async () => {
      const { lockId, terms: t } = await lockNative()
      await expectRevert(as(sender).refund(lockId), 'LockNotExpired')
      await expectRevert(sendAt(t.expiresAt - 1n, refundTo, 'refund', [lockId]), 'LockNotExpired')

      const refundBefore = await balance(refundTo)
      const senderBefore = await balance(sender)
      const recipientBefore = await balance(recipient)
      await sendAt(t.expiresAt, stranger, 'refund', [lockId])

      expect((await balance(refundTo)) - refundBefore).toBe(t.amount)
      expect(await balance(sender)).toBe(senderBefore)
      expect(await balance(recipient)).toBe(recipientBefore)
      const lock = await htlc.locks(lockId)
      expect(lock.state).toBe(State.Refunded)
      expect(lock.preimage).toBe(ethers.ZeroHash)
    })

    it('refunds an ERC-20 lock to the refund address', async () => {
      const { lockId, terms: t } = await lockToken()
      await anvil.advanceTime(ONE_HOUR + 1)
      const before = await token.balanceOf(refundTo.address)
      await mined(as(stranger).refund(lockId))
      expect((await token.balanceOf(refundTo.address)) - before).toBe(t.amount)
    })

    it('refunds a lock once: no second refund and no withdraw after a refund', async () => {
      const { lockId } = await lockNative()
      await anvil.advanceTime(ONE_HOUR + 1)
      await mined(as(stranger).refund(lockId))
      const held = await balance(htlcAddress)
      await expectRevert(as(stranger).refund(lockId), 'AlreadyRefunded')
      await expectRevert(as(recipient).withdraw(lockId, preimage), 'AlreadyRefunded')
      await expectRevert(as(stranger).refund(ethers.ZeroHash), 'LockNotFound')
      expect(await balance(htlcAddress)).toBe(held)
    })

    it('defers a refund to a refund address that refuses coin, which collects it with claimOwed', async () => {
      const rejecting = await deploy(testContract('RejectingRecipient'), stranger)
      const rejectingAddress = await rejecting.getAddress()
      const { lockId, terms: t } = await lockNative({ refundAddress: rejectingAddress })
      await anvil.advanceTime(ONE_HOUR + 1)

      const receipt = await mined(as(stranger).refund(lockId))
      expect(deferred(receipt)).toEqual([{ to: rejectingAddress, token: NATIVE, amount: t.amount }])
      expect((await htlc.locks(lockId)).state).toBe(State.Refunded)
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(t.amount)

      await mined((rejecting.connect(stranger) as ethers.Contract).setAccepting(true))
      await mined((rejecting.connect(stranger) as ethers.Contract).claim(htlcAddress, NATIVE))
      expect(await balance(rejectingAddress)).toBe(t.amount)
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(0n)
    })
  })

  describe('batchWithdraw', () => {
    it('pays each lock to its own recipient', async () => {
      const toRecipient = await lockNative()
      const toStranger = await lockNative({ recipient: stranger.address, amount: AMOUNT * 2n })
      const recipientBefore = await balance(recipient)
      const strangerBefore = await balance(stranger)

      await mined(as(sender).batchWithdraw([toRecipient.lockId, toStranger.lockId], preimage))

      expect((await balance(recipient)) - recipientBefore).toBe(toRecipient.terms.amount)
      expect((await balance(stranger)) - strangerBefore).toBe(AMOUNT * 2n)
      expect((await htlc.locks(toStranger.lockId)).preimage).toBe(preimage)
    })

    it('defers the payout of a refusing recipient and still pays the others', async () => {
      const rejecting = await deploy(testContract('RejectingRecipient'), stranger)
      const rejectingAddress = await rejecting.getAddress()
      const refused = await lockNative({ recipient: rejectingAddress })
      const paid = await lockNative()
      const before = await balance(recipient)

      const receipt = await mined(as(stranger).batchWithdraw([refused.lockId, paid.lockId], preimage))

      expect(deferred(receipt)).toEqual([
        { to: rejectingAddress, token: NATIVE, amount: refused.terms.amount },
      ])
      expect((await balance(recipient)) - before).toBe(paid.terms.amount)
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(refused.terms.amount)
      await mined((rejecting.connect(stranger) as ethers.Contract).setAccepting(true))
      await mined((rejecting.connect(stranger) as ethers.Contract).claim(htlcAddress, NATIVE))
      expect(await balance(rejectingAddress)).toBe(refused.terms.amount)
    })

    it('pays nothing when the batch is empty, the preimage is wrong, or one lock is spent', async () => {
      const a = await lockNative()
      const b = await lockNative()
      const held = await balance(htlcAddress)
      await expectRevert(as(sender).batchWithdraw([], preimage), 'EmptyBatch')
      await expectRevert(as(sender).batchWithdraw([a.lockId, b.lockId], wrongPreimage), 'InvalidPreimage')
      await expectRevert(as(sender).batchWithdraw([a.lockId, a.lockId], preimage), 'AlreadyWithdrawn')
      expect(await balance(htlcAddress)).toBe(held)
      expect((await htlc.locks(a.lockId)).state).toBe(State.Open)
    })
  })

  describe('batchDistribute', () => {
    // A table pot: every player locks to the arbiter, who splits the pool.
    let arbiter: ethers.HDNodeWallet
    beforeAll(() => {
      arbiter = recipient
    })

    it("lets the locks' recipient split the whole pool between winners", async () => {
      const a = await lockNative({ amount: AMOUNT })
      const b = await lockNative({ amount: AMOUNT * 3n })
      const winnerBefore = await balance(stranger)
      const secondBefore = await balance(refundTo)

      const receipt = await mined(
        as(arbiter).batchDistribute(
          [a.lockId, b.lockId],
          [
            { recipient: stranger.address, amount: AMOUNT * 3n },
            { recipient: refundTo.address, amount: AMOUNT },
          ],
          preimage,
        ),
      )

      // Each lock reports its withdraw like the other withdraw paths, then the split.
      const events = receipt.logs
        .map(log => htlc.interface.parseLog(log))
        .filter(parsed => parsed?.name === 'Withdrawn' || parsed?.name === 'BatchDistributed')
      expect(events.map(e => e!.name)).toEqual(['Withdrawn', 'Withdrawn', 'BatchDistributed'])
      expect(events.slice(0, 2).map(e => [...e!.args])).toEqual([
        [a.lockId, arbiter.address, preimage],
        [b.lockId, arbiter.address, preimage],
      ])

      expect((await balance(stranger)) - winnerBefore).toBe(AMOUNT * 3n)
      expect((await balance(refundTo)) - secondBefore).toBe(AMOUNT)
      for (const lock of [a, b]) {
        const state = await htlc.locks(lock.lockId)
        expect(state.state).toBe(State.Withdrawn)
        expect(state.preimage).toBe(preimage)
      }
      await expectRevert(as(stranger).withdraw(a.lockId, preimage), 'AlreadyWithdrawn')
    })

    it('defers the share of a winner that refuses coin', async () => {
      const rejecting = await deploy(testContract('RejectingRecipient'), stranger)
      const rejectingAddress = await rejecting.getAddress()
      const a = await lockNative({ amount: AMOUNT * 2n })
      const before = await balance(stranger)

      const receipt = await mined(
        as(arbiter).batchDistribute(
          [a.lockId],
          [
            { recipient: rejectingAddress, amount: AMOUNT },
            { recipient: stranger.address, amount: AMOUNT },
          ],
          preimage,
        ),
      )
      expect(deferred(receipt)).toEqual([{ to: rejectingAddress, token: NATIVE, amount: AMOUNT }])
      expect((await balance(stranger)) - before).toBe(AMOUNT)
      expect(await htlc.owed(rejectingAddress, NATIVE)).toBe(AMOUNT)
      await mined((rejecting.connect(stranger) as ethers.Contract).setAccepting(true))
      await mined((rejecting.connect(stranger) as ethers.Contract).claim(htlcAddress, NATIVE))
      expect(await balance(rejectingAddress)).toBe(AMOUNT)
    })

    it('splits an ERC-20 pool', async () => {
      const a = await lockToken({ amount: AMOUNT })
      const b = await lockToken({ amount: AMOUNT * 2n })
      const before = await token.balanceOf(refundTo.address)
      await mined(
        as(arbiter).batchDistribute(
          [a.lockId, b.lockId],
          [{ recipient: refundTo.address, amount: AMOUNT * 3n }],
          preimage,
        ),
      )
      expect((await token.balanceOf(refundTo.address)) - before).toBe(AMOUNT * 3n)
    })

    it('refuses anyone who is not the recipient of every lock, even with the preimage', async () => {
      const mine = await lockNative({ amount: AMOUNT })
      const theirs = await lockNative({ recipient: stranger.address, amount: AMOUNT })
      const held = await balance(htlcAddress)
      const takeAll = [{ recipient: stranger.address, amount: AMOUNT }]

      // Someone who only learned the preimage, and the sender taking a lock back.
      await expectRevert(as(stranger).batchDistribute([mine.lockId], takeAll, preimage), 'Unauthorized')
      await expectRevert(as(sender).batchDistribute([mine.lockId], takeAll, preimage), 'Unauthorized')
      // The recipient of one lock pooling in a lock that pays someone else.
      await expectRevert(
        as(arbiter).batchDistribute(
          [mine.lockId, theirs.lockId],
          [{ recipient: arbiter.address, amount: AMOUNT * 2n }],
          preimage,
        ),
        'Unauthorized',
      )
      expect(await balance(htlcAddress)).toBe(held)
      expect((await htlc.locks(mine.lockId)).state).toBe(State.Open)
    })

    it('needs the preimage', async () => {
      const { lockId, terms: t } = await lockNative()
      await expectRevert(
        as(arbiter).batchDistribute(
          [lockId],
          [{ recipient: arbiter.address, amount: t.amount }],
          wrongPreimage,
        ),
        'InvalidPreimage',
      )
      expect((await htlc.locks(lockId)).state).toBe(State.Open)
    })

    it('refuses payouts that do not add up to exactly the pool', async () => {
      const a = await lockNative({ amount: AMOUNT })
      const b = await lockNative({ amount: AMOUNT })
      const ids = [a.lockId, b.lockId]
      const held = await balance(htlcAddress)
      const pay = (amount: bigint) =>
        as(arbiter).batchDistribute(ids, [{ recipient: stranger.address, amount }], preimage)

      await expectRevert(pay(AMOUNT * 2n + 1n), 'InvalidPayoutSum')
      await expectRevert(pay(AMOUNT * 2n - 1n), 'InvalidPayoutSum')
      await expectRevert(pay(0n), 'ZeroAmount')
      await expectRevert(as(arbiter).batchDistribute(ids, [], preimage), 'EmptyBatch')
      await expectRevert(
        as(arbiter).batchDistribute(
          ids,
          [{ recipient: ethers.ZeroAddress, amount: AMOUNT * 2n }],
          preimage,
        ),
        'InvalidZeroAddress',
      )
      expect(await balance(htlcAddress)).toBe(held)
    })

    it('refuses a lock listed twice, a spent lock, and locks of different tokens', async () => {
      const native = await lockNative({ amount: AMOUNT })
      const spent = await lockNative({ amount: AMOUNT })
      const erc20 = await lockToken({ amount: AMOUNT })
      await mined(as(stranger).withdraw(spent.lockId, preimage))
      const one = [{ recipient: stranger.address, amount: AMOUNT * 2n }]

      await expectRevert(
        as(arbiter).batchDistribute([native.lockId, native.lockId], one, preimage),
        'AlreadyWithdrawn',
      )
      await expectRevert(
        as(arbiter).batchDistribute([native.lockId, spent.lockId], one, preimage),
        'AlreadyWithdrawn',
      )
      await expectRevert(
        as(arbiter).batchDistribute([native.lockId, erc20.lockId], one, preimage),
        'TokenMismatch',
      )
      expect((await htlc.locks(native.lockId)).state).toBe(State.Open)
    })

    it('cannot distribute once a lock has expired, nor a refunded lock', async () => {
      const fresh = await lockNative({ amount: AMOUNT, duration: 10 * ONE_HOUR })
      const expiring = await lockNative({ amount: AMOUNT })
      await anvil.advanceTime(ONE_HOUR)
      await expectRevert(
        as(arbiter).batchDistribute(
          [fresh.lockId, expiring.lockId],
          [{ recipient: arbiter.address, amount: AMOUNT * 2n }],
          preimage,
        ),
        'LockExpired',
      )
      expect((await htlc.locks(fresh.lockId)).state).toBe(State.Open)

      await mined(as(stranger).refund(expiring.lockId))
      await expectRevert(
        as(arbiter).batchDistribute(
          [expiring.lockId],
          [{ recipient: arbiter.address, amount: AMOUNT }],
          preimage,
        ),
        'AlreadyRefunded',
      )
    })
  })

  it('holds exactly the native coin of the open locks plus what it owes', async () => {
    // Every test above settles or leaves locks; the contract must never hold less than it owes.
    const events = await htlc.queryFilter(htlc.filters.Locked(), 0)
    let held = 0n
    for (const event of events) {
      const lock = await htlc.locks((event as ethers.EventLog).args.lockId)
      if (lock.token === NATIVE && lock.state === State.Open) held += lock.amount
    }
    const creditors = new Set(
      (await htlc.queryFilter(htlc.filters.PaymentDeferred(), 0)).map(
        event => (event as ethers.EventLog).args.to as string,
      ),
    )
    for (const creditor of creditors) held += await htlc.owed(creditor, NATIVE)
    expect(await balance(htlcAddress)).toBe(held)
  })
})
