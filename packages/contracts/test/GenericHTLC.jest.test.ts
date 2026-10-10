/**
 * GenericHTLC, deployed to and executed by a local anvil node.
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

const LOCK_NATIVE = 'lock(bytes32,address,address,bytes32,uint256)'
const LOCK_NATIVE_DEFAULT_REFUND = 'lock(bytes32,address,bytes32,uint256)'
const LOCK_TOKEN = 'lock(bytes32,address,address,address,uint256,bytes32,uint256)'
const ONE_HOUR = 3600
const AMOUNT = ethers.parseEther('1')

describe('GenericHTLC on a local EVM node', () => {
  let anvil: Anvil
  let htlc: ethers.Contract
  let token: ethers.Contract
  let sender: ethers.HDNodeWallet
  let recipient: ethers.HDNodeWallet
  let refundTo: ethers.HDNodeWallet
  let stranger: ethers.HDNodeWallet
  let htlcAddress: string
  let counter = 0

  const preimage = ethers.hexlify(ethers.randomBytes(32))
  const sha256Lock = ethers.sha256(preimage)
  const wrongPreimage = ethers.hexlify(ethers.randomBytes(32))
  const newLockId = () => ethers.id(`lock-${counter++}`)
  const balance = (who: { address: string } | string) =>
    anvil.provider.getBalance(typeof who === 'string' ? who : who.address)
  const as = (who: ethers.Signer) => htlc.connect(who) as ethers.Contract

  async function lockNative(
    opts: {
      lockId?: string
      to?: string
      hashLock?: string
      amount?: bigint
      duration?: number
    } = {},
  ): Promise<string> {
    const lockId = opts.lockId ?? newLockId()
    await mined(
      as(sender)[LOCK_NATIVE](
        lockId,
        opts.to ?? recipient.address,
        refundTo.address,
        opts.hashLock ?? sha256Lock,
        opts.duration ?? ONE_HOUR,
        { value: opts.amount ?? AMOUNT },
      ),
    )
    return lockId
  }

  async function lockToken(amount = AMOUNT, to = recipient.address): Promise<string> {
    const lockId = newLockId()
    await mined((token.connect(sender) as ethers.Contract).mint(sender.address, amount))
    await mined((token.connect(sender) as ethers.Contract).approve(htlcAddress, amount))
    await mined(
      as(sender)[LOCK_TOKEN](
        lockId,
        to,
        refundTo.address,
        await token.getAddress(),
        amount,
        sha256Lock,
        ONE_HOUR,
      ),
    )
    return lockId
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

  describe('lock', () => {
    it('holds native coin and records the lock', async () => {
      const before = await balance(htlcAddress)
      const lockId = await lockNative()
      expect((await balance(htlcAddress)) - before).toBe(AMOUNT)

      const lock = await htlc.locks(lockId)
      expect(lock.sender).toBe(sender.address)
      expect(lock.recipient).toBe(recipient.address)
      expect(lock.refundAddress).toBe(refundTo.address)
      expect(lock.token).toBe(ethers.ZeroAddress)
      expect(lock.hashLock).toBe(sha256Lock)
      expect(lock.amount).toBe(AMOUNT)
      expect(lock.withdrawn).toBe(false)
      expect(lock.refunded).toBe(false)
    })

    it('pulls an ERC-20 from the sender', async () => {
      const before = await token.balanceOf(htlcAddress)
      const lockId = await lockToken()
      expect((await token.balanceOf(htlcAddress)) - before).toBe(AMOUNT)
      expect(await token.balanceOf(sender.address)).toBe(0n)
      expect((await htlc.locks(lockId)).token).toBe(await token.getAddress())
    })

    it('refunds to the sender when no refund address is given', async () => {
      const lockId = newLockId()
      await mined(
        as(sender)[LOCK_NATIVE_DEFAULT_REFUND](lockId, recipient.address, sha256Lock, ONE_HOUR, {
          value: AMOUNT,
        }),
      )
      expect((await htlc.locks(lockId)).refundAddress).toBe(sender.address)
    })

    it('refuses a lock id that is taken, a zero amount, a zero recipient and a zero duration', async () => {
      const lockId = await lockNative()
      const lock = as(sender)[LOCK_NATIVE]
      await expectRevert(
        lock(lockId, recipient.address, refundTo.address, sha256Lock, ONE_HOUR, { value: AMOUNT }),
        'LockAlreadyExists',
      )
      await expectRevert(
        lock(newLockId(), recipient.address, refundTo.address, sha256Lock, ONE_HOUR, { value: 0 }),
        'ZeroAmount',
      )
      await expectRevert(
        lock(newLockId(), ethers.ZeroAddress, refundTo.address, sha256Lock, ONE_HOUR, {
          value: AMOUNT,
        }),
        'InvalidZeroAddress',
      )
      await expectRevert(
        lock(newLockId(), recipient.address, refundTo.address, sha256Lock, 0, { value: AMOUNT }),
        'LockExpired',
      )
    })

    it('refuses native coin sent along with a token lock, and a token lock without allowance', async () => {
      const tokenAddress = await token.getAddress()
      await mined((token.connect(sender) as ethers.Contract).mint(sender.address, AMOUNT))
      await mined((token.connect(sender) as ethers.Contract).approve(htlcAddress, AMOUNT))
      await expectRevert(
        as(sender)[LOCK_TOKEN](
          newLockId(),
          recipient.address,
          refundTo.address,
          tokenAddress,
          AMOUNT,
          sha256Lock,
          ONE_HOUR,
          { value: 1 },
        ),
        'TransferFailed',
      )
      await mined((token.connect(sender) as ethers.Contract).approve(htlcAddress, 0))
      await expect(
        as(sender)[LOCK_TOKEN](
          newLockId(),
          recipient.address,
          refundTo.address,
          tokenAddress,
          AMOUNT,
          sha256Lock,
          ONE_HOUR,
        ),
      ).rejects.toThrow()
      // Leave the sender with no tokens for the other tests.
      await mined((token.connect(sender) as ethers.Contract).transfer(stranger.address, AMOUNT))
    })
  })

  describe('withdraw', () => {
    it('pays the recipient for the right preimage, whoever sends the transaction', async () => {
      const lockId = await lockNative()
      const before = await balance(recipient)
      const receipt = await mined(as(stranger).withdraw(lockId, preimage))
      expect((await balance(recipient)) - before).toBe(AMOUNT)
      expect((await htlc.locks(lockId)).withdrawn).toBe(true)

      const event = receipt.logs
        .map(log => htlc.interface.parseLog(log))
        .find(parsed => parsed?.name === 'Withdrawn')
      expect(event?.args.preimage).toBe(preimage)
    })

    it('accepts a keccak256 hash lock as well as a sha256 one', async () => {
      const lockId = await lockNative({ hashLock: ethers.keccak256(preimage) })
      const before = await balance(recipient)
      await mined(as(stranger).withdraw(lockId, preimage))
      expect((await balance(recipient)) - before).toBe(AMOUNT)
    })

    it('pays an ERC-20 lock to the recipient', async () => {
      const lockId = await lockToken()
      const before = await token.balanceOf(recipient.address)
      await mined(as(stranger).withdraw(lockId, preimage))
      expect((await token.balanceOf(recipient.address)) - before).toBe(AMOUNT)
    })

    it('refuses a wrong preimage and an unknown lock, and keeps the money', async () => {
      const lockId = await lockNative()
      const held = await balance(htlcAddress)
      await expectRevert(as(recipient).withdraw(lockId, wrongPreimage), 'InvalidPreimage')
      await expectRevert(as(recipient).withdraw(newLockId(), preimage), 'LockNotFound')
      expect(await balance(htlcAddress)).toBe(held)
      expect((await htlc.locks(lockId)).withdrawn).toBe(false)
    })

    it('pays a lock once: no second withdraw and no refund after a withdraw', async () => {
      const lockId = await lockNative()
      await mined(as(stranger).withdraw(lockId, preimage))
      const held = await balance(htlcAddress)
      await expectRevert(as(stranger).withdraw(lockId, preimage), 'AlreadyWithdrawn')
      await anvil.advanceTime(ONE_HOUR + 1)
      await expectRevert(as(stranger).refund(lockId), 'AlreadyWithdrawn')
      expect(await balance(htlcAddress)).toBe(held)
    })

    it('does not let a recipient contract take a second lock from inside its payment', async () => {
      const attacker = await deploy(testContract('ReentrantRecipient'), stranger, [htlcAddress])
      const attackerAddress = await attacker.getAddress()
      const first = await lockNative({ to: attackerAddress })
      const second = await lockNative({ to: attackerAddress })
      await mined((attacker.connect(stranger) as ethers.Contract).arm(second, preimage))

      await mined(as(stranger).withdraw(first, preimage))

      expect(await attacker.attempted()).toBe(true)
      expect(await attacker.reentrySucceeded()).toBe(false)
      expect(await balance(attackerAddress)).toBe(AMOUNT)
      expect((await htlc.locks(second)).withdrawn).toBe(false)
    })
  })

  describe('refund', () => {
    it('is refused before the timelock and pays only the refund address after it', async () => {
      const lockId = await lockNative()
      await expectRevert(as(sender).refund(lockId), 'LockNotExpired')
      await anvil.advanceTime(ONE_HOUR - 60)
      await expectRevert(as(refundTo).refund(lockId), 'LockNotExpired')

      await anvil.advanceTime(120)
      const refundBefore = await balance(refundTo)
      const senderBefore = await balance(sender)
      const recipientBefore = await balance(recipient)
      await mined(as(stranger).refund(lockId))

      expect((await balance(refundTo)) - refundBefore).toBe(AMOUNT)
      expect(await balance(sender)).toBe(senderBefore)
      expect(await balance(recipient)).toBe(recipientBefore)
      expect((await htlc.locks(lockId)).refunded).toBe(true)
    })

    it('refunds an ERC-20 lock to the refund address', async () => {
      const lockId = await lockToken()
      await anvil.advanceTime(ONE_HOUR + 1)
      const before = await token.balanceOf(refundTo.address)
      await mined(as(stranger).refund(lockId))
      expect((await token.balanceOf(refundTo.address)) - before).toBe(AMOUNT)
    })

    it('refunds a lock once: no second refund and no withdraw after a refund', async () => {
      const lockId = await lockNative()
      await anvil.advanceTime(ONE_HOUR + 1)
      await mined(as(stranger).refund(lockId))
      const held = await balance(htlcAddress)
      await expectRevert(as(stranger).refund(lockId), 'AlreadyRefunded')
      await expectRevert(as(recipient).withdraw(lockId, preimage), 'AlreadyRefunded')
      expect(await balance(htlcAddress)).toBe(held)
    })
  })

  describe('batchWithdraw', () => {
    it('pays each lock to its own recipient', async () => {
      const toRecipient = await lockNative()
      const toStranger = await lockNative({ to: stranger.address, amount: AMOUNT * 2n })
      const recipientBefore = await balance(recipient)
      const strangerBefore = await balance(stranger)

      await mined(as(sender).batchWithdraw([toRecipient, toStranger], preimage))

      expect((await balance(recipient)) - recipientBefore).toBe(AMOUNT)
      expect((await balance(stranger)) - strangerBefore).toBe(AMOUNT * 2n)
    })

    it('pays nothing when the batch is empty, the preimage is wrong, or one lock is spent', async () => {
      const a = await lockNative()
      const b = await lockNative()
      const held = await balance(htlcAddress)
      await expectRevert(as(sender).batchWithdraw([], preimage), 'EmptyBatch')
      await expectRevert(as(sender).batchWithdraw([a, b], wrongPreimage), 'InvalidPreimage')
      await expectRevert(as(sender).batchWithdraw([a, a], preimage), 'AlreadyWithdrawn')
      expect(await balance(htlcAddress)).toBe(held)
      expect((await htlc.locks(a)).withdrawn).toBe(false)
    })
  })

  describe('batchDistribute', () => {
    // A table pot: every player locks to the arbiter, who splits the pool.
    let arbiter: ethers.HDNodeWallet
    beforeAll(() => {
      arbiter = recipient
    })

    it('lets the locks\' recipient split the whole pool between winners', async () => {
      const a = await lockNative({ amount: AMOUNT })
      const b = await lockNative({ amount: AMOUNT * 3n })
      const winnerBefore = await balance(stranger)
      const secondBefore = await balance(refundTo)

      await mined(
        as(arbiter).batchDistribute(
          [a, b],
          [
            { recipient: stranger.address, amount: AMOUNT * 3n },
            { recipient: refundTo.address, amount: AMOUNT },
          ],
          preimage,
        ),
      )

      expect((await balance(stranger)) - winnerBefore).toBe(AMOUNT * 3n)
      expect((await balance(refundTo)) - secondBefore).toBe(AMOUNT)
      expect((await htlc.locks(a)).withdrawn).toBe(true)
      expect((await htlc.locks(b)).withdrawn).toBe(true)
      await expectRevert(as(stranger).withdraw(a, preimage), 'AlreadyWithdrawn')
    })

    it('splits an ERC-20 pool', async () => {
      const a = await lockToken(AMOUNT)
      const b = await lockToken(AMOUNT)
      const before = await token.balanceOf(refundTo.address)
      await mined(
        as(arbiter).batchDistribute(
          [a, b],
          [{ recipient: refundTo.address, amount: AMOUNT * 2n }],
          preimage,
        ),
      )
      expect((await token.balanceOf(refundTo.address)) - before).toBe(AMOUNT * 2n)
    })

    it('refuses anyone who is not the recipient of every lock, even with the preimage', async () => {
      const mine = await lockNative()
      const theirs = await lockNative({ to: stranger.address })
      const held = await balance(htlcAddress)
      const takeAll = [{ recipient: stranger.address, amount: AMOUNT }]

      // Someone who only learned the preimage, and the sender taking a lock back.
      await expectRevert(as(stranger).batchDistribute([mine], takeAll, preimage), 'Unauthorized')
      await expectRevert(as(sender).batchDistribute([mine], takeAll, preimage), 'Unauthorized')
      // The recipient of one lock pooling in a lock that pays someone else.
      await expectRevert(
        as(arbiter).batchDistribute(
          [mine, theirs],
          [{ recipient: arbiter.address, amount: AMOUNT * 2n }],
          preimage,
        ),
        'Unauthorized',
      )
      expect(await balance(htlcAddress)).toBe(held)
      expect((await htlc.locks(mine)).withdrawn).toBe(false)
    })

    it('needs the preimage', async () => {
      const lockId = await lockNative()
      await expectRevert(
        as(arbiter).batchDistribute(
          [lockId],
          [{ recipient: arbiter.address, amount: AMOUNT }],
          wrongPreimage,
        ),
        'InvalidPreimage',
      )
      expect((await htlc.locks(lockId)).withdrawn).toBe(false)
    })

    it('refuses payouts that do not add up to exactly the pool', async () => {
      const a = await lockNative()
      const b = await lockNative()
      const held = await balance(htlcAddress)
      const pay = (amount: bigint) =>
        as(arbiter).batchDistribute([a, b], [{ recipient: stranger.address, amount }], preimage)

      await expectRevert(pay(AMOUNT * 2n + 1n), 'InvalidPayoutSum')
      await expectRevert(pay(AMOUNT * 2n - 1n), 'InvalidPayoutSum')
      await expectRevert(pay(0n), 'ZeroAmount')
      await expectRevert(as(arbiter).batchDistribute([a, b], [], preimage), 'EmptyBatch')
      await expectRevert(
        as(arbiter).batchDistribute(
          [a, b],
          [{ recipient: ethers.ZeroAddress, amount: AMOUNT * 2n }],
          preimage,
        ),
        'InvalidZeroAddress',
      )
      expect(await balance(htlcAddress)).toBe(held)
    })

    it('refuses a lock listed twice, a spent lock, and locks of different tokens', async () => {
      const native = await lockNative()
      const spent = await lockNative()
      const erc20 = await lockToken()
      await mined(as(stranger).withdraw(spent, preimage))
      const one = [{ recipient: stranger.address, amount: AMOUNT * 2n }]

      await expectRevert(as(arbiter).batchDistribute([native, native], one, preimage), 'AlreadyWithdrawn')
      await expectRevert(as(arbiter).batchDistribute([native, spent], one, preimage), 'AlreadyWithdrawn')
      await expectRevert(as(arbiter).batchDistribute([native, erc20], one, preimage), 'TokenMismatch')
      expect((await htlc.locks(native)).withdrawn).toBe(false)
    })

    it('cannot distribute a refunded lock', async () => {
      const lockId = await lockNative()
      await anvil.advanceTime(ONE_HOUR + 1)
      await mined(as(stranger).refund(lockId))
      await expectRevert(
        as(arbiter).batchDistribute(
          [lockId],
          [{ recipient: arbiter.address, amount: AMOUNT }],
          preimage,
        ),
        'AlreadyRefunded',
      )
    })
  })

  it('holds exactly the native coin of the locks that are still open', async () => {
    // Every test above settles or leaves locks; the contract must never hold less than it owes.
    const filter = htlc.filters.Locked()
    const events = await htlc.queryFilter(filter, 0)
    let owed = 0n
    for (const event of events) {
      const lock = await htlc.locks((event as ethers.EventLog).args.lockId)
      if (lock.token === ethers.ZeroAddress && !lock.withdrawn && !lock.refunded) {
        owed += lock.amount
      }
    }
    expect(await balance(htlcAddress)).toBe(owed)
  })
})
