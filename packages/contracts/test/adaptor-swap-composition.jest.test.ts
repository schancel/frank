/** B0 experiment: real contract execution and XEC script interpretation; no live funded swap. */
import { randomBytes, createHash } from 'crypto'
import {
  mkdtempSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ethers } from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  startKeygen,
  keygenStep,
  describeKeyShare,
  destroyKeyShare,
  startSign,
  signStep,
  createPointLock,
  recoveryBit,
  type Step,
  type ThresholdResult,
} from '@frank/threshold-ecdsa'
import {
  completeAdaptorSignature,
  extractAdaptorSecret,
  verifyAdaptorSignature,
  adaptorSignatureFromBytes,
  adaptorPointFromBytes,
  adaptorSecretProofFromBytes,
  compactEcdsaSignatureFromBytes,
} from '@frank/adaptor-signatures'
import {
  XEC_REGTEST,
  sighash,
  internalHashFromBytes,
  encodeScriptNum,
  verifyScript,
  type Transaction,
} from '@frank/nakamoto'
import { StateChannel } from '../index'
import { startAnvil, deploy, mined, expectRevert, type Anvil } from './anvil'
const OPEN = 'openChannel(bytes32,address,uint256)',
  CLOSE =
    'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)'
const M = 1000000n,
  D = 100n,
  X = 99000n,
  INPUT = 100000n,
  TX = 500000500
const rng = (n: number) => new Uint8Array(randomBytes(n)),
  hex = (b: Uint8Array) => Buffer.from(b).toString('hex'),
  bytes = (s: string) => new Uint8Array(Buffer.from(s, 'hex'))
function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error('crypto rejected')
  return r.value
}
const concat = (...b: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(b.map((x) => Buffer.from(x))))
function p2pkh(publicKey: Uint8Array) {
  const hash = createHash('ripemd160')
    .update(createHash('sha256').update(publicKey).digest())
    .digest()
  return concat(
    new Uint8Array([0x76, 0xa9, 0x14]),
    new Uint8Array(hash),
    new Uint8Array([0x88, 0xac])
  )
}
function push(b: Uint8Array): Uint8Array {
  if (b.length <= 75) return concat(new Uint8Array([b.length]), b)
  if (b.length <= 255) return concat(new Uint8Array([0x4c, b.length]), b)
  throw new Error('push budget')
}
function drive<S, R>(
  a: ThresholdResult<Step<S, R>>,
  b: ThresholdResult<Step<S, R>>,
  step: (s: S, m: Uint8Array) => ThresholdResult<Step<S, R>>,
  before?: (r: R | null, m: Uint8Array) => boolean
) {
  let left = must(a),
    right = must(b),
    message = left.outgoing,
    toRight = true
  const hashes: string[] = []
  while (message !== null) {
    if (hashes.length >= 32) throw new Error('round budget')
    const sender = toRight ? left : right
    if (before && !before(sender.result, message))
      return {
        left,
        right,
        hashes,
        held: message,
        resume: () =>
          must(step(toRight ? right.session : left.session, message!)),
      }
    hashes.push(createHash('sha256').update(message).digest('hex'))
    const next = must(step(toRight ? right.session : left.session, message))
    if (toRight) right = next
    else left = next
    message = next.outgoing
    toRight = !toRight
  }
  return {
    left,
    right,
    hashes,
    held: null,
    resume: () => {
      throw new Error('not paused')
    },
  }
}
interface PublicPackage {
  publicKey: string
  point: string
  proof: string
  signature: string
  digest: string
  sessionId: string
}
function context(p: PublicPackage) {
  return {
    publicKey: bytes(p.publicKey),
    adaptorPoint: must(adaptorPointFromBytes(bytes(p.point))),
    adaptorProof: must(adaptorSecretProofFromBytes(bytes(p.proof))),
    signature: must(adaptorSignatureFromBytes(bytes(p.signature))),
    digest: bytes(p.digest),
  }
}
describe('experimental two-session StateChannel/XEC adaptor composition', () => {
  let node: Anvil,
    contract: ethers.Contract,
    b: ethers.HDNodeWallet,
    relayer: ethers.HDNodeWallet,
    payA: ethers.HDNodeWallet
  let address: string,
    chainId: bigint,
    snapshot: string,
    directory: string,
    publicKey: Uint8Array,
    jointAddress: string,
    redeem: Uint8Array,
    p2sh: Uint8Array,
    xec: Transaction,
    refund: Transaction
  let evmPackage: PublicPackage,
    xecPackage: PublicPackage,
    bSignature: string,
    jSignature: string,
    successSignature: Uint8Array,
    refundSignature: Uint8Array
  const evidence: Record<string, unknown> = {}
  const id = ethers.id('B0-fixed-experimental-channel'),
    balances: [bigint, bigint] = [M, 0n]
  const as = (who: ethers.Signer) => contract.connect(who) as ethers.Contract
  const close = () =>
    as(relayer)[CLOSE](
      id,
      1,
      balances,
      payA.address,
      ethers.ZeroAddress,
      bSignature,
      jSignature
    )
  const balance = (who: string) => node.provider.getBalance(who)
  function persist(packages: unknown) {
    const f = openSync(join(directory, 'public-packages.json'), 'w', 0o600)
    try {
      writeSync(f, JSON.stringify(packages))
      fsyncSync(f)
    } finally {
      closeSync(f)
    }
  }
  function inner(patch: { chainId?: bigint; contract?: string } = {}) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'bytes32',
          'uint256',
          'uint256[2]',
          'address',
          'address',
          'bool',
          'address',
          'uint256',
        ],
        [
          id,
          1,
          balances,
          payA.address,
          ethers.ZeroAddress,
          true,
          patch.contract ?? address,
          patch.chainId ?? chainId,
        ]
      )
    )
  }
  const open = () => mined(as(b)[OPEN](id, jointAddress, D, { value: M }))
  beforeAll(async () => {
    node = await startAnvil()
    ;[b, relayer, payA] = node.accounts
    contract = await deploy(StateChannel, b)
    address = await contract.getAddress()
    chainId = (await node.provider.getNetwork()).chainId
    expect(await node.provider.getCode(address)).toBe(
      StateChannel.deployedBytecode
    )
    directory = mkdtempSync(join(tmpdir(), 'frank-b0-public-packages-'))
    const sessionId = rng(32),
      aId = rng(32),
      bId = rng(32)
    const keys = drive(
      startKeygen({
        role: 'initiator',
        sessionId,
        localId: aId,
        peerId: bId,
        randomBytes: rng,
      }),
      startKeygen({
        role: 'responder',
        sessionId,
        localId: bId,
        peerId: aId,
        randomBytes: rng,
      }),
      keygenStep
    )
    if (!keys.left.result || !keys.right.result)
      throw new Error('keygen incomplete')
    evidence.keygenTranscriptHashes = keys.hashes
    evidence.fixture = {
      chainId: chainId.toString(),
      client: await node.provider.send('web3_clientVersion', []),
      contract: address,
      runtimeHash: ethers.keccak256(await node.provider.getCode(address)),
      channelId: id,
      participants: ['B_individual', 'J_zero_balance'],
      principalWei: M.toString(),
    }
    const aShare = keys.left.result,
      bShare = keys.right.result
    publicKey = must(describeKeyShare(aShare)).publicKey
    jointAddress = ethers.computeAddress(`0x${hex(publicKey)}`)
    evidence.participants = [b.address, jointAddress]
    evidence.payoutA = payA.address
    const lock = must(createPointLock({ keyShare: bShare, randomBytes: rng })),
      aRefund = ethers.Wallet.createRandom()
    redeem = concat(
      new Uint8Array([0x63]),
      push(publicKey),
      new Uint8Array([0xac, 0x67]),
      push(encodeScriptNum(BigInt(TX))),
      new Uint8Array([0xb1, 0x75]),
      push(bytes(aRefund.signingKey.compressedPublicKey.slice(2))),
      new Uint8Array([0xac, 0x68])
    )
    const redeemHash = createHash('ripemd160')
      .update(createHash('sha256').update(redeem).digest())
      .digest()
    p2sh = concat(
      new Uint8Array([0xa9, 0x14]),
      new Uint8Array(redeemHash),
      new Uint8Array([0x87])
    )
    xec = {
      version: 2,
      inputs: [
        {
          prevout: { txid: must(internalHashFromBytes(rng(32))), vout: 0 },
          scriptSig: new Uint8Array(),
          sequence: 0xffffffff,
        },
      ],
      outputs: [
        {
          value: X,
          scriptPubKey: p2pkh(bytes(b.signingKey.compressedPublicKey.slice(2))),
        },
      ],
      locktime: 0,
    }
    const xecDigest = must(
        sighash(xec, 0, XEC_REGTEST, 0x41, {
          algorithm: 'forkid',
          scriptCode: redeem,
          amount: INPUT,
        })
      ),
      evmDigest = bytes(ethers.hashMessage(ethers.getBytes(inner())).slice(2))
    expect(`0x${hex(evmDigest)}`).toBe(
      await contract.getCloseDigest(
        id,
        1,
        balances,
        payA.address,
        ethers.ZeroAddress,
        true
      )
    )
    bSignature = await b.signMessage(ethers.getBytes(inner()))
    let sessions = 0,
      firstSession = ''
    function signing(digest: Uint8Array, holdFinal: boolean) {
      const sessionId = rng(32)
      sessions++
      if (sessions === 1) firstSession = hex(sessionId)
      else expect(hex(sessionId)).not.toBe(firstSession)
      const common = { sessionId, digest, lock: lock.lock, randomBytes: rng }
      let stored: PublicPackage | undefined
      let finalFrame: Uint8Array | undefined
      const trace = drive(
        startSign({ ...common, keyShare: aShare }),
        startSign({ ...common, keyShare: bShare, lockOpening: lock.opening }),
        signStep,
        (result, outgoing) => {
          if (result?.kind === 'adaptor-signature') {
            finalFrame = outgoing.slice()
            stored = {
              publicKey: hex(result.publicKey),
              point: hex(lock.lock.point),
              proof: hex(lock.lock.proof),
              signature: hex(result.adaptorSignature),
              digest: hex(digest),
              sessionId: hex(sessionId),
            }
            expect(must(verifyAdaptorSignature(context(stored)))).toBe(true)
            if (holdFinal) {
              expect(evmPackage).toBeDefined()
              expect(bSignature).toHaveLength(132)
              persist({ evm: evmPackage, xec: stored, bSignature })
              return false
            }
          }
          return true
        }
      )
      if (!stored) throw new Error('initiator package unavailable')
      return { trace, stored, finalFrame }
    }
    const first = signing(evmDigest, false)
    evmPackage = first.stored
    expect(first.trace.right.result?.kind).toBe('adaptor-signature')
    persist({ evm: evmPackage, bSignature })
    const second = signing(xecDigest, true)
    xecPackage = second.stored
    evidence.sessionTranscriptHashes = {
      evm: first.trace.hashes,
      xec: [
        ...second.trace.hashes,
        createHash('sha256').update(second.trace.held!).digest('hex'),
      ],
    }
    expect(second.trace.held).not.toBeNull()
    expect(second.trace.right.result).toBeNull()
    expect(signStep(second.trace.right.session, first.finalFrame!).ok).toBe(
      false
    )
    // Exact final-frame interruption: responder lacks completion authority until persisted release.
    const reopened = JSON.parse(
      readFileSync(join(directory, 'public-packages.json'), 'utf8')
    ) as { evm: PublicPackage; xec: PublicPackage; bSignature: string }
    expect(reopened.evm).toEqual(evmPackage)
    expect(reopened.xec).toEqual(xecPackage)
    expect(second.trace.resume().result?.kind).toBe('adaptor-signature')
    expect(sessions).toBe(2)
    expect(evmPackage.digest).not.toBe(xecPackage.digest)
    expect(evmPackage.signature.slice(0, 66)).not.toBe(
      xecPackage.signature.slice(0, 66)
    )
    expect(evmPackage.point).toBe(xecPackage.point)
    expect(evmPackage.publicKey).toBe(xecPackage.publicKey)
    expect(
      must(
        verifyAdaptorSignature({ ...context(xecPackage), digest: evmDigest })
      )
    ).toBe(false)
    expect(
      must(
        verifyAdaptorSignature({
          ...context(evmPackage),
          signature: context(xecPackage).signature,
        })
      )
    ).toBe(false)
    must(destroyKeyShare(aShare))
    must(destroyKeyShare(bShare))
    expect(
      startSign({
        sessionId: rng(32),
        digest: xecDigest,
        keyShare: aShare,
        lock: lock.lock,
        randomBytes: rng,
      }).ok
    ).toBe(false)
    // Everything below uses reloaded public packages and the lock secret, never J handles.
    evmPackage = reopened.evm
    xecPackage = reopened.xec
    bSignature = reopened.bSignature
    successSignature = must(
      completeAdaptorSignature({ ...context(xecPackage), secret: lock.secret })
    )
    const extracted = must(
      extractAdaptorSecret({
        ...context(xecPackage),
        completedSignature: must(
          compactEcdsaSignatureFromBytes(successSignature)
        ),
      })
    )
    expect(hex(extracted)).toBe(hex(lock.secret))
    const low = secp256k1.Signature.fromCompact(successSignature),
      high = new secp256k1.Signature(
        low.r,
        secp256k1.CURVE.n - low.s
      ).toCompactRawBytes()
    expect(
      hex(
        must(
          extractAdaptorSecret({
            ...context(xecPackage),
            completedSignature: must(compactEcdsaSignatureFromBytes(high)),
          })
        )
      )
    ).toBe(hex(extracted))
    const completed = must(
        completeAdaptorSignature({ ...context(evmPackage), secret: extracted })
      ),
      parity = recoveryBit(publicKey, evmDigest, completed)
    if (parity === null) throw new Error('bad recovery')
    jSignature = ethers.Signature.from({
      r: `0x${hex(completed.subarray(0, 32))}`,
      s: `0x${hex(completed.subarray(32))}`,
      yParity: parity,
    }).serialized
    refund = {
      ...xec,
      locktime: TX,
      inputs: [{ ...xec.inputs[0]!, sequence: 0xfffffffe }],
      outputs: [
        {
          value: X,
          scriptPubKey: p2pkh(
            bytes(aRefund.signingKey.compressedPublicKey.slice(2))
          ),
        },
      ],
    }
    const refundDigest = must(
      sighash(refund, 0, XEC_REGTEST, 0x41, {
        algorithm: 'forkid',
        scriptCode: redeem,
        amount: INPUT,
      })
    )
    refundSignature = new Uint8Array(
      secp256k1
        .sign(refundDigest, bytes(aRefund.privateKey.slice(2)), {
          prehash: false,
          lowS: true,
        })
        .toDERRawBytes()
    )
    snapshot = await node.provider.send('evm_snapshot', [])
  }, 120000)
  afterEach(async () => {
    if (snapshot) {
      expect(await node.provider.send('evm_revert', [snapshot])).toBe(true)
      snapshot = await node.provider.send('evm_snapshot', [])
    }
  })
  afterAll(async () => {
    if (directory) {
      const file = openSync(join(directory, 'evidence.json'), 'w', 0o600)
      try {
        writeSync(
          file,
          JSON.stringify(
            {
              ...evidence,
              evmPackage,
              xecPackage,
              bSignature,
              jSignature,
              redeemScript: redeem && hex(redeem),
            },
            null,
            2
          )
        )
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      console.log(`B0 public evidence: ${directory}/evidence.json`)
    }
    await node?.stop()
  })
  it('executes fixed A payout after both J handles are destroyed', async () => {
    await open()
    const state = await contract.channels(id)
    expect(state.token).toBe(ethers.ZeroAddress)
    expect(state.currentSeq).toBe(0n)
    expect(state.settled).toBe(false)
    expect(await balance(address)).toBe(M)
    const before = await balance(payA.address),
      jointBefore = await balance(jointAddress),
      receipt = await mined(close())
    expect((await balance(payA.address)) - before).toBe(M)
    expect(await balance(jointAddress)).toBe(jointBefore)
    const event = receipt.logs
      .map((log) => {
        try {
          return contract.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((log) => log?.name === 'ChannelSettled')
    evidence.successReceipt = receipt.toJSON()
    expect(event?.args.cooperative).toBe(true)
    expect(event?.args.finalBalances).toEqual(balances)
    expect((await contract.channels(id)).settled).toBe(true)
    await expectRevert(as(b).startChallenge(id), 'ChannelAlreadySettled')
    await expectRevert(
      as(relayer).closeAfterChallenge(id),
      'ChannelAlreadySettled'
    )
  })
  it('binds payouts, amount, sequence, channel, native chain and contract; authorizes no checkpoint/join', async () => {
    await open()
    const call = (
      channel = id,
      seq = 1,
      amount: [bigint, bigint] = balances,
      payout = payA.address,
      sig = bSignature
    ) =>
      as(relayer)[CLOSE].staticCall(
        channel,
        seq,
        amount,
        payout,
        ethers.ZeroAddress,
        sig,
        jSignature
      )
    await expectRevert(
      call(id, 1, balances, relayer.address),
      'InvalidSignature'
    )
    await expectRevert(call(id, 1, [M - 1n, 0n]), 'InvalidBalanceSum')
    await expectRevert(call(id, 2), 'InvalidSignature')
    await expectRevert(call(ethers.id('another-channel')), 'ChannelNotFound')
    for (const altered of [
      { chainId: chainId + 1n },
      { contract: relayer.address },
    ])
      await expectRevert(
        call(
          id,
          1,
          balances,
          payA.address,
          await b.signMessage(ethers.getBytes(inner(altered)))
        ),
        'InvalidSignature'
      )
    const intended = contract.interface.encodeFunctionData(CLOSE, [
        id,
        1,
        balances,
        payA.address,
        ethers.ZeroAddress,
        bSignature,
        jSignature,
      ]),
      changed = contract.interface.encodeFunctionData(CLOSE, [
        id,
        1,
        balances,
        relayer.address,
        ethers.ZeroAddress,
        bSignature,
        jSignature,
      ])
    expect(ethers.keccak256(intended)).not.toBe(ethers.keccak256(changed))
    const native = {
      type: 2,
      chainId,
      nonce: 0,
      to: address,
      value: 0,
      gasLimit: 200000,
      maxFeePerGas: 1000000000,
      maxPriorityFeePerGas: 0,
    }
    expect(
      ethers.Transaction.from({ ...native, data: intended }).unsignedHash
    ).not.toBe(
      ethers.Transaction.from({ ...native, data: changed }).unsignedHash
    )
    await expectRevert(
      as(relayer).checkpoint(id, 1, balances, bSignature, jSignature),
      'InvalidSignature'
    )
    await expectRevert(
      as(relayer)['joinChannel(bytes32)'](id, { value: 1 }),
      'Unauthorized'
    )
  })
  it('refunds only B at exact expiry; refund-first blocks success, but XEC success remains valid', async () => {
    await open()
    const opened = await node.provider.getBlock('latest')
    await node.provider.send('evm_setNextBlockTimestamp', [opened!.timestamp])
    await mined(as(b).startChallenge(id))
    const expiry = Number((await contract.channels(id)).challengeExpiresAt)
    expect(expiry).toBe(opened!.timestamp + Number(D))
    await node.provider.send('evm_setNextBlockTimestamp', [expiry - 1])
    await node.provider.send('evm_mine', [])
    await expectRevert(
      as(relayer).closeAfterChallenge.staticCall(id),
      'ChallengeNotExpired'
    )
    const before = await balance(b.address),
      jointBefore = await balance(jointAddress)
    await node.provider.send('evm_setNextBlockTimestamp', [expiry])
    const receipt = await mined(as(relayer).closeAfterChallenge(id))
    evidence.refundReceipt = receipt.toJSON()
    expect((await node.provider.getBlock(receipt.blockNumber))?.timestamp).toBe(
      expiry
    )
    expect((await balance(b.address)) - before).toBe(M)
    expect(await balance(jointAddress)).toBe(jointBefore)
    await expectRevert(close(), 'ChannelAlreadySettled')
    const unlock = concat(
      push(
        concat(
          secp256k1.Signature.fromCompact(successSignature).toDERRawBytes(),
          new Uint8Array([0x41])
        )
      ),
      new Uint8Array([0x51]),
      push(redeem)
    )
    expect(
      verifyScript(unlock, p2sh, {
        chain: XEC_REGTEST,
        transaction: xec,
        inputIndex: 0,
        spent: [{ value: INPUT, scriptPubKey: p2sh }],
      })
    ).toEqual({ ok: true, value: true })
  })
  it('accepts success until just before expiry; success-first blocks refund', async () => {
    await open()
    await mined(as(b).startChallenge(id))
    const expiry = Number((await contract.channels(id)).challengeExpiresAt)
    await node.provider.send('evm_setNextBlockTimestamp', [expiry - 1])
    await mined(close())
    await expectRevert(
      as(relayer).closeAfterChallenge(id),
      'ChannelAlreadySettled'
    )
  })
  it('refuses success from expiry on; only the fallback settles', async () => {
    await open()
    await mined(as(b).startChallenge(id))
    const expiry = Number((await contract.channels(id)).challengeExpiresAt)
    await node.provider.send('evm_setNextBlockTimestamp', [expiry])
    await node.provider.send('evm_mine', [])
    await expectRevert(close(), 'ChallengeExpired')
    const before = await balance(b.address)
    await mined(as(relayer).closeAfterChallenge(id))
    expect((await balance(b.address)) - before).toBe(M)
  })
  it('interprets independent XEC refund CLTV without any J handle', () => {
    const unlock = concat(
        push(concat(refundSignature, new Uint8Array([0x41]))),
        new Uint8Array([0]),
        push(redeem)
      ),
      verify = (tx: Transaction) =>
        verifyScript(unlock, p2sh, {
          chain: XEC_REGTEST,
          transaction: tx,
          inputIndex: 0,
          spent: [{ value: INPUT, scriptPubKey: p2sh }],
        })
    expect(verify(refund)).toEqual({ ok: true, value: true })
    expect(verify({ ...refund, locktime: TX - 1 }).ok).toBe(false)
    expect(
      verify({
        ...refund,
        inputs: [{ ...refund.inputs[0]!, sequence: 0xffffffff }],
      }).ok
    ).toBe(false)
    // Interpreter only: actual ABC MTP/off-by-one inclusion is expressly a B1 gate.
  })
})
