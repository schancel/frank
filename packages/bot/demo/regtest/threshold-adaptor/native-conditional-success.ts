/** Experimental local witness only. No malicious-security or production durability claim. */
import assert from 'assert/strict'
import { randomBytes, createHash } from 'crypto'
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readFileSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  type SignResult,
} from '@frank/threshold-ecdsa'
import {
  verifyAdaptorSignature,
  completeAdaptorSignature,
  extractAdaptorSecret,
  adaptorPointFromBytes,
  adaptorSecretProofFromBytes,
  adaptorSignatureFromBytes,
  compactEcdsaSignatureFromBytes,
} from '@frank/adaptor-signatures'
import { XEC_REGTEST, parseTransaction } from '@frank/nakamoto'
import {
  AbiCoder,
  Contract,
  ContractFactory,
  ZeroAddress,
  getBytes,
  hashMessage,
  id,
  keccak256,
  computeAddress,
  recoverAddress,
  Signature,
  type TransactionReceipt,
} from 'ethers'
import artifact from '../../../../contracts/artifacts/StateChannel.json'
import { ordinaryCltv as c } from '../cltv-consensus-fixture'
import {
  startOwnedTemplateFixture,
  type ReadyTemplateFixture,
} from '../owned-template-fixture'
import { startOwnedEvm, type OwnedEvm } from '../pair-recovery-clock-fixture'

const rng = (length: number) => new Uint8Array(randomBytes(length))
const hash = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
function must<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error('experimental crypto operation rejected')
  return result.value
}
interface PublicPackage {
  publicKey: string
  point: string
  proof: string
  signature: string
  digest: string
  sessionId: string
}
interface Binding {
  xecChainIdentifier: 'xec-regtest'
  evmChainIdentifier: 'monad-regtest'
  nativeChainId: string
  xecCheckpoint: { hash: string; height: number }
  evmCheckpoint: { hash: string; height: number }
  contract: string
  runtimeHash: string
  channelId: string
  participantB: string
  jointAddress: string
  publicKey: string
  point: string
  ownerProof: string
  keyId: string
  responderId: string
  payoutA: string
  payout1: string
  principalWei: string
  seq: number
  redeemScript: string
  refundPublicKey: string
  unsignedClaim: string
  fundingTxid: string
  vout: number
  inputSats: string
  principalSats: string
  claimFeeSats: string
  recipientScript: string
  openingTimestamp: number
  duration: number
  refundTimestamp: number
  refundFinalBound: number
  responseMargin: number
  crossClockMargin: number
  revealInclusionMargin: number
  gasLimit: string
  maxFeePerGas: string
  gasBudgetWei: string
}
export interface RecoveryPackage {
  binding: Binding
  evm: PublicPackage
  xec: PublicPackage
  bSignature: string
}
export interface ExpectedRecovery {
  binding: Binding
  evmSessionId: string
  xecSessionId: string
}
export interface ConditionalEvidence {
  scope: string
  hypotheses: string[]
  publicPackage: RecoveryPackage
  expected: ExpectedRecovery
  identities: Record<string, unknown>
  headers: Array<Record<string, unknown>>
  observations: Array<Record<string, unknown>>
  order: string[]
}
function context(value: PublicPackage) {
  return {
    publicKey: c.bytes(value.publicKey),
    adaptorPoint: must(adaptorPointFromBytes(c.bytes(value.point))),
    adaptorProof: must(adaptorSecretProofFromBytes(c.bytes(value.proof))),
    signature: must(adaptorSignatureFromBytes(c.bytes(value.signature))),
    digest: c.bytes(value.digest),
  }
}
function evmDigest(binding: Binding): string {
  const payload = keccak256(
    AbiCoder.defaultAbiCoder().encode(
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
        binding.channelId,
        binding.seq,
        [BigInt(binding.principalWei), 0n],
        binding.payoutA,
        binding.payout1,
        true,
        binding.contract,
        BigInt(binding.nativeChainId),
      ],
    ),
  )
  return hashMessage(getBytes(payload)).slice(2)
}
/** Public-only checks before the outgoing final frame can escape. */
export function validateRecoveryPackage(
  value: RecoveryPackage,
  expected: ExpectedRecovery,
): void {
  assert.equal(
    JSON.stringify(value.binding),
    JSON.stringify(expected.binding),
    'exact negotiated binding required',
  )
  const binding = value.binding
  assert.equal(value.evm.sessionId, expected.evmSessionId)
  assert.equal(value.xec.sessionId, expected.xecSessionId)
  assert.notEqual(value.evm.sessionId, value.xec.sessionId)
  assert.notEqual(value.evm.digest, value.xec.digest)
  assert.notEqual(
    value.evm.signature.slice(0, 66),
    value.xec.signature.slice(0, 66),
    'independent joint nonce required',
  )
  for (const pkg of [value.evm, value.xec]) {
    assert.equal(pkg.publicKey, binding.publicKey)
    assert.equal(pkg.point, binding.point)
    assert.equal(must(verifyAdaptorSignature(context(pkg))), true)
  }
  assert.equal(value.evm.digest, evmDigest(binding))
  const tx = must(parseTransaction(c.bytes(binding.unsignedClaim), XEC_REGTEST))
  assert.equal(tx.inputs.length, 1)
  assert.equal(tx.outputs.length, 1)
  assert.equal(tx.inputs[0]!.scriptSig.length, 0)
  assert.equal(
    c.hex(tx.inputs[0]!.prevout.txid.slice().reverse()),
    binding.fundingTxid,
  )
  assert.equal(tx.inputs[0]!.prevout.vout, binding.vout)
  assert.equal(tx.outputs[0]!.value, BigInt(binding.principalSats))
  assert.equal(c.hex(tx.outputs[0]!.scriptPubKey), binding.recipientScript)
  assert.equal(
    BigInt(binding.inputSats) - tx.outputs[0]!.value,
    BigInt(binding.claimFeeSats),
  )
  assert.equal(
    value.xec.digest,
    c.hex(
      c.digest(tx, c.bytes(binding.redeemScript), BigInt(binding.inputSats)),
    ),
  )
  assert.equal(
    recoverAddress(`0x${value.evm.digest}`, value.bSignature),
    binding.participantB,
  )
  assert.ok(
    binding.openingTimestamp + binding.duration >
      binding.refundFinalBound +
        binding.responseMargin +
        binding.crossClockMargin,
  )
}
/** A's completion input is only the public package plus observed chain bytes, never B's t or shares. */
export function completeEvmFromObserved(
  value: RecoveryPackage,
  expected: ExpectedRecovery,
  observedRaw: string,
) {
  validateRecoveryPackage(value, expected)
  const observed = must(parseTransaction(c.bytes(observedRaw), XEC_REGTEST))
  assert.equal(observed.inputs.length, 1)
  const script = observed.inputs[0]!.scriptSig,
    length = script[0]!
  assert.ok(length > 1 && length <= 75)
  assert.equal(script[length], 0x41)
  assert.equal(script[length + 1], 0x51)
  assert.equal(
    c.hex(script.subarray(length + 2)),
    c.hex(c.push(c.bytes(value.binding.redeemScript))),
  )
  const unsigned = {
    ...observed,
    inputs: [{ ...observed.inputs[0]!, scriptSig: new Uint8Array() }],
  }
  assert.equal(
    c.raw(unsigned),
    value.binding.unsignedClaim,
    'observed transaction intent differs',
  )
  const digest = c.digest(
    unsigned,
    c.bytes(value.binding.redeemScript),
    BigInt(value.binding.inputSats),
  )
  assert.equal(c.hex(digest), value.xec.digest)
  const signature = secp256k1.Signature.fromDER(
    script.subarray(1, length),
  ).toCompactRawBytes()
  assert.ok(
    secp256k1.verify(signature, digest, c.bytes(value.binding.publicKey), {
      prehash: false,
      lowS: true,
    }),
    'observed native signature rejected',
  )
  const extracted = must(
    extractAdaptorSecret({
      ...context(value.xec),
      completedSignature: must(compactEcdsaSignatureFromBytes(signature)),
    }),
  )
  try {
    assert.equal(
      c.hex(secp256k1.getPublicKey(extracted, true)),
      value.binding.point,
    )
    const completed = must(
      completeAdaptorSignature({ ...context(value.evm), secret: extracted }),
    )
    const parity = recoveryBit(
      c.bytes(value.binding.publicKey),
      c.bytes(value.evm.digest),
      completed,
    )
    assert.notEqual(parity, null)
    const evmSignature = Signature.from({
      r: `0x${c.hex(completed.subarray(0, 32))}`,
      s: `0x${c.hex(completed.subarray(32))}`,
      yParity: parity!,
    }).serialized
    assert.equal(
      recoverAddress(`0x${value.evm.digest}`, evmSignature),
      value.binding.jointAddress,
    )
    return {
      evmSignature,
      parity,
      observedCompactSignature: c.hex(signature),
      observedDigest: c.hex(digest),
      extractionVerified: true as const,
    }
  } finally {
    extracted.fill(0)
  }
}
function drive<S, R>(
  a: ThresholdResult<Step<S, R>>,
  b: ThresholdResult<Step<S, R>>,
  step: (session: S, message: Uint8Array) => ThresholdResult<Step<S, R>>,
  hold?: (result: R | null, message: Uint8Array) => boolean,
) {
  let left = must(a),
    right = must(b),
    message = left.outgoing,
    toRight = true
  const hashes: string[] = []
  while (message !== null) {
    assert.ok(hashes.length < 32)
    const sender = toRight ? left : right
    if (hold?.(sender.result, message)) {
      const frame = message.slice(),
        target = toRight ? right.session : left.session
      return {
        left,
        right,
        hashes,
        held: frame,
        release: () => must(step(target, frame)),
      }
    }
    hashes.push(hash(message))
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
    release: () => {
      throw new Error('no held frame')
    },
  }
}
export class PublicStorageRejected extends Error {
  constructor(readonly releaseCallbacks: number) {
    super('owned public package storage rejected before final frame release')
  }
}
export async function runNativeConditionalSuccess(
  options: Parameters<typeof startOwnedTemplateFixture>[0] & {
    rejectPublicStorage?: boolean
    scenario?: 'settlement-reorg' | 'delayed-observer'
  },
): Promise<ConditionalEvidence> {
  assert.ok(
    options.scenario === undefined ||
      options.scenario === 'settlement-reorg' ||
      options.scenario === 'delayed-observer',
    'unknown fixture scenario',
  )
  const abc = await startOwnedTemplateFixture(options)
  let evm: OwnedEvm | undefined
  let directory: string | undefined
  try {
    directory = mkdtempSync(join(tmpdir(), 'frank-native-conditional-'))
    const initial = await abc.rpc<{ time: number }>('getblockheader', [
      await abc.rpc<string>('getbestblockhash'),
    ])
    evm = await startOwnedEvm(initial.time + 1990)
    return await exercise(
      abc,
      evm,
      directory,
      options.rejectPublicStorage === true,
      options.scenario,
    )
  } finally {
    const results = await Promise.allSettled([
      abc.stop(),
      evm?.stop() ?? Promise.resolve(),
    ])
    if (directory) rmSync(directory, { recursive: true, force: true })
    for (const result of results)
      if (result.status === 'rejected') throw result.reason
  }
}
async function exercise(
  abc: ReadyTemplateFixture,
  evm: OwnedEvm,
  directory: string,
  rejectStorage: boolean,
  scenario?: 'settlement-reorg' | 'delayed-observer',
): Promise<ConditionalEvidence> {
  const rpc = abc.rpc,
    provider = evm.provider
  const [b, relayer, a] = evm.accounts
  assert.ok(b && relayer && a)
  const initial = await rpc<{ hash: string; height: number; time: number }>(
    'getblockheader',
    [await rpc<string>('getbestblockhash')],
  )
  const base = initial.time + 2000,
    refundTimestamp = base + 100,
    duration = 200
  const X = 10000n,
    FEE = 1000n,
    M = 10000000000000000n,
    GAS = 300000n,
    PRICE = 2000000000n
  const order: string[] = [],
    observations: Array<Record<string, unknown>> = [],
    headers: Array<Record<string, unknown>> = [initial]
  const tip = async () =>
    rpc<{
      hash: string
      height: number
      time: number
      mediantime: number
      previousblockhash?: string
    }>('getblockheader', [await rpc<string>('getbestblockhash')])
  const record = async () => {
    const t = await tip()
    assert.equal(t.previousblockhash, headers.at(-1)!.hash)
    headers.push(t)
    if (headers.length >= 11)
      assert.equal(
        t.mediantime,
        headers
          .slice(-11)
          .map(h => Number(h.time))
          .sort((x, y) => x - y)[5],
      )
    return t
  }
  const mine = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await rpc('generatetodescriptor', [1, 'raw(6a)'])
      await record()
    }
  }
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, b)
  const deployment = await factory.deploy({
    gasLimit: 3000000n,
    maxFeePerGas: PRICE,
    maxPriorityFeePerGas: 1n,
  })
  await deployment.waitForDeployment()
  const contractAddress = await deployment.getAddress(),
    contract = new Contract(contractAddress, artifact.abi, provider)
  const runtime = await provider.getCode(contractAddress)
  assert.equal(runtime, artifact.deployedBytecode)
  const genesis = await provider.getBlock(0)
  assert.ok(genesis?.hash)
  assert.equal(BigInt(await provider.send('eth_chainId', [])), 20143n)
  // Fresh dealerless J. No export/reconstruction of either private share occurs.
  const keygenId = rng(32),
    aId = rng(32),
    bId = rng(32)
  const keys = drive(
    startKeygen({
      role: 'initiator',
      sessionId: keygenId,
      localId: aId,
      peerId: bId,
      randomBytes: rng,
    }),
    startKeygen({
      role: 'responder',
      sessionId: keygenId,
      localId: bId,
      peerId: aId,
      randomBytes: rng,
    }),
    keygenStep,
  )
  const aShare = keys.left.result,
    bShare = keys.right.result
  assert.ok(aShare && bShare)
  let destroyed = false,
    releaseCallbacks = 0
  try {
    const info = must(describeKeyShare(aShare)),
      other = must(describeKeyShare(bShare))
    assert.equal(info.role, 'initiator')
    assert.equal(other.role, 'responder')
    assert.equal(c.hex(info.publicKey), c.hex(other.publicKey))
    const J = info.publicKey,
      jointAddress = computeAddress(`0x${c.hex(J)}`),
      lock = must(createPointLock({ keyShare: bShare, randomBytes: rng }))
    const refundKey = rng(32),
      refundPub = secp256k1.getPublicKey(refundKey, true),
      refundScript = c.p2pkh(refundPub),
      recipient = c.p2pkh(getBytes(b.signingKey.compressedPublicKey))
    const redeem = c.redeemScript(J, refundPub, refundTimestamp),
      channelId = id(`native-b1c-${initial.hash}-${c.hex(J)}`)
    const evmSessionId = c.hex(rng(32)),
      xecSessionId = c.hex(rng(32))
    assert.notEqual(evmSessionId, xecSessionId)
    let signingCount = 0
    const preSign = (
      digest: Uint8Array,
      sessionId: string,
      holdFinal: boolean,
    ) => {
      signingCount++
      assert.ok(signingCount <= 2)
      let stored: PublicPackage | undefined
      const common = {
        sessionId: c.bytes(sessionId),
        digest,
        lock: lock.lock,
        randomBytes: rng,
      }
      const trace = drive(
        startSign({ ...common, keyShare: aShare }),
        startSign({ ...common, keyShare: bShare, lockOpening: lock.opening }),
        signStep,
        (result: SignResult | null) => {
          if (result?.kind === 'adaptor-signature') {
            stored = {
              publicKey: c.hex(result.publicKey),
              point: c.hex(lock.lock.point),
              proof: c.hex(lock.lock.proof),
              signature: c.hex(result.adaptorSignature),
              digest: c.hex(digest),
              sessionId,
            }
            assert.equal(must(verifyAdaptorSignature(context(stored))), true)
            return holdFinal
          }
          return false
        },
      )
      assert.ok(stored)
      return { stored, trace }
    }
    const temporary: Binding = {
      xecChainIdentifier: 'xec-regtest',
      evmChainIdentifier: 'monad-regtest',
      nativeChainId: '20143',
      xecCheckpoint: { hash: initial.hash, height: initial.height },
      evmCheckpoint: { hash: genesis.hash, height: 0 },
      contract: contractAddress,
      runtimeHash: keccak256(runtime),
      channelId,
      participantB: b.address,
      jointAddress,
      publicKey: c.hex(J),
      point: c.hex(lock.lock.point),
      ownerProof: c.hex(lock.lock.ownerProof),
      keyId: c.hex(info.keyId),
      responderId: c.hex(other.localId),
      payoutA: a.address,
      payout1: ZeroAddress,
      principalWei: M.toString(),
      seq: 1,
      redeemScript: c.hex(redeem),
      refundPublicKey: c.hex(refundPub),
      unsignedClaim: '',
      fundingTxid: '',
      vout: 0,
      inputSats: (X + FEE).toString(),
      principalSats: X.toString(),
      claimFeeSats: FEE.toString(),
      recipientScript: c.hex(recipient),
      openingTimestamp: base,
      duration,
      refundTimestamp,
      refundFinalBound: refundTimestamp + 30,
      responseMargin: 10,
      crossClockMargin: 5,
      revealInclusionMargin: 8,
      gasLimit: GAS.toString(),
      maxFeePerGas: PRICE.toString(),
      gasBudgetWei: '100000000000000000',
    }
    assert.ok(
      base + duration >
        temporary.refundFinalBound +
          temporary.responseMargin +
          temporary.crossClockMargin,
    )
    const closeDigest = evmDigest(temporary)
    assert.equal(
      await contract
        .getFunction('getCloseDigest')
        .staticCall(channelId, 1, [M, 0n], a.address, ZeroAddress, true),
      `0x${closeDigest}`,
    )
    const bSignature = b.signingKey.sign(`0x${closeDigest}`).serialized
    const first = preSign(c.bytes(closeDigest), evmSessionId, false)
    assert.equal(first.trace.right.result?.kind, 'adaptor-signature')
    order.push('EVM public presignature and B signature verified')
    const evmOnlyBytes = Buffer.from(
      JSON.stringify({ binding: temporary, evm: first.stored, bSignature }),
    )
    const evmOnlyFile = join(directory, 'evm-success-before-funding.json')
    const evmOnlyFd = openSync(evmOnlyFile, 'wx', 0o600)
    try {
      writeFileSync(evmOnlyFd, evmOnlyBytes)
      fsyncSync(evmOnlyFd)
    } finally {
      closeSync(evmOnlyFd)
    }
    assert.deepEqual(readFileSync(evmOnlyFile), evmOnlyBytes)
    order.push('EVM-only public package fsynced and reloaded before B opening')
    const balanceA = await provider.getBalance(a.address),
      balanceB = await provider.getBalance(b.address),
      balanceRelay = await provider.getBalance(relayer.address)
    await provider.send('evm_setNextBlockTimestamp', [base])
    const opened = await b.sendTransaction({
      to: contractAddress,
      data: contract.interface.encodeFunctionData(
        'openChannel(bytes32,address,uint256)',
        [channelId, jointAddress, duration],
      ),
      value: M,
      gasLimit: GAS,
      maxFeePerGas: PRICE,
      maxPriorityFeePerGas: 1n,
    })
    const openReceipt = await opened.wait()
    assert.ok(openReceipt && openReceipt.status === 1)
    const openBlock = await provider.getBlock(openReceipt.blockNumber)
    assert.equal(openBlock!.timestamp, base)
    const openedEvent = openReceipt.logs
      .map(log =>
        contract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        }),
      )
      .find(log => log?.name === 'ChannelOpened')
    assert.ok(openedEvent)
    assert.equal(openedEvent.args.partyA, b.address)
    assert.equal(openedEvent.args.partyB, jointAddress)
    assert.equal(openedEvent.args.depositA, M)
    assert.equal(openedEvent.args.challengeDuration, BigInt(duration))
    assert.ok(balanceB >= M + GAS * PRICE)
    assert.ok(balanceRelay >= GAS * PRICE)
    const channel = await contract.getFunction('channels').staticCall(channelId)
    assert.equal(channel.currentSeq, 0n)
    assert.equal(channel.challengeExpiresAt, 0n)
    assert.equal(channel.settled, false)
    assert.equal(channel.token, ZeroAddress)
    assert.equal(await provider.getBalance(contractAddress), M)
    assert.equal(await provider.getBalance(jointAddress), 0n)
    order.push('native EVM opening and backing verified')
    await rpc('setmocktime', [initial.time + 100])
    const sourceHash = (
      await rpc<string[]>('generatetodescriptor', [
        1,
        `raw(${c.hex(refundScript)})`,
      ])
    )[0]!
    type NativeBlock = {
      height: number
      tx: Array<{
        txid: string
        hex: string
        vout: Array<{
          n: number
          value: number
          scriptPubKey: { hex: string }
        }>
      }>
    }
    const sourceBlock = await rpc<NativeBlock>('getblock', [sourceHash, 2])
    await record()
    await mine(1350)
    const source = sourceBlock.tx[0]!,
      sourceOutput = source.vout.find(
        out => out.scriptPubKey.hex === c.hex(refundScript),
      )!,
      sourceAmount = BigInt(Math.round(sourceOutput.value * 100))
    const sourceUtxo = await rpc<{ confirmations: number }>('gettxout', [
      source.txid,
      sourceOutput.n,
      false,
    ])
    assert.ok(sourceUtxo.confirmations >= 1351)
    const plan = c.transaction(
      source.txid,
      sourceOutput.n,
      X + FEE,
      c.p2sh(redeem),
    )
    const change = sourceAmount - X - FEE - FEE,
      fundingPlan = {
        ...plan,
        outputs: [
          ...plan.outputs,
          { value: change, scriptPubKey: refundScript },
        ],
      }
    const fundingDigest = c.digest(fundingPlan, refundScript, sourceAmount),
      fundingSig = secp256k1
        .sign(fundingDigest, refundKey, { prehash: false, lowS: true })
        .toDERRawBytes()
    const funding = {
      ...fundingPlan,
      inputs: [
        {
          ...fundingPlan.inputs[0]!,
          scriptSig: c.concat(
            c.push(c.concat(fundingSig, c.bytes('41'))),
            c.push(refundPub),
          ),
        },
      ],
    }
    const fundingRaw = c.raw(funding),
      fundingId = c.txid(funding)
    const fundingResult = await rpc<{ hash: string }>('generateblock', [
      'raw(6a)',
      [fundingRaw],
    ])
    const fundingBlock = await rpc<NativeBlock>('getblock', [
      fundingResult.hash,
      2,
    ])
    assert.equal(
      fundingBlock.tx.find(tx => tx.txid === fundingId)!.hex,
      fundingRaw,
    )
    await record()
    await mine(1)
    await rpc('setmocktime', [base + 10])
    for (let i = 0; (await tip()).mediantime < base + 10; i++) {
      assert.ok(i < 12)
      await mine(1)
    }
    await provider.send('evm_setNextBlockTimestamp', [base + 10])
    await provider.send('evm_mine', [])
    const claim = c.transaction(fundingId, 0, X, recipient),
      claimDigest = c.digest(claim, redeem, X + FEE)
    const binding: Binding = {
      ...temporary,
      unsignedClaim: c.raw(claim),
      fundingTxid: fundingId,
    }
    const second = preSign(claimDigest, xecSessionId, true)
    assert.ok(second.trace.held)
    assert.equal(second.trace.right.result, null)
    assert.equal(signingCount, 2)
    const pkg: RecoveryPackage = {
        binding,
        evm: first.stored,
        xec: second.stored,
        bSignature,
      },
      expected: ExpectedRecovery = {
        binding: JSON.parse(JSON.stringify(binding)) as Binding,
        evmSessionId,
        xecSessionId,
      }
    validateRecoveryPackage(pkg, expected)
    order.push('XEC final outgoing frame held; responder result absent')
    for (const [label, changePackage] of [
      [
        'wrong stored digest',
        (p: RecoveryPackage) => {
          p.xec.digest = hash(c.bytes(p.xec.digest))
        },
      ],
      [
        'wrong stored T',
        (p: RecoveryPackage) => {
          p.xec.point = c.hex(refundPub)
        },
      ],
      [
        'wrong stored session',
        (p: RecoveryPackage) => {
          p.xec.sessionId = p.evm.sessionId
        },
      ],
      [
        'wrong stored contract',
        (p: RecoveryPackage) => {
          p.binding.contract = relayer.address
        },
      ],
      [
        'wrong stored recipient',
        (p: RecoveryPackage) => {
          p.binding.recipientScript = c.hex(refundScript)
        },
      ],
    ] as const) {
      const modified = JSON.parse(JSON.stringify(pkg)) as RecoveryPackage
      changePackage(modified)
      assert.throws(() => validateRecoveryPackage(modified, expected))
      assert.equal(releaseCallbacks, 0)
      observations.push({
        label,
        rejectedBeforeRelease: true,
        releaseCallbacks,
      })
    }
    assert.ok((await provider.getBalance(relayer.address)) >= GAS * PRICE)
    assert.equal(
      await provider.getTransactionCount(relayer.address, 'pending'),
      await provider.getTransactionCount(relayer.address, 'latest'),
    )
    const checkpointNow = await tip(),
      evmNow = await provider.getBlock('latest')
    assert.ok(evmNow)
    assert.ok(
      Math.abs(checkpointNow.time - evmNow.timestamp) <=
        binding.crossClockMargin,
    )
    const beforeRelease = Math.max(checkpointNow.time, evmNow.timestamp)
    observations.push({
      label: 'pre-release native clocks and bounds verified',
      xecHeader: checkpointNow,
      evmHeader: {
        hash: evmNow.hash,
        number: evmNow.number,
        timestamp: evmNow.timestamp,
      },
      beforeRelease,
      earliestFallback: base + duration,
      refundTimestamp,
      crossClockMargin: binding.crossClockMargin,
      relayerNonceFree: true,
    })
    assert.ok(
      beforeRelease + binding.revealInclusionMargin < binding.refundTimestamp,
    )
    assert.ok(
      beforeRelease + binding.responseMargin + binding.crossClockMargin <
        base + duration,
    )
    assert.equal(await rpc('getbestblockhash'), checkpointNow.hash)
    assert.equal(
      (await contract.getFunction('channels').staticCall(channelId)).settled,
      false,
    )
    const publicBytes = Buffer.from(JSON.stringify(pkg)),
      file = join(directory, 'public-recovery.json')
    if (rejectStorage) mkdirSync(file)
    let fd: number
    try {
      fd = openSync(file, 'wx', 0o600)
    } catch {
      throw new PublicStorageRejected(releaseCallbacks)
    }
    try {
      writeFileSync(fd, publicBytes)
      order.push('public file written')
      fsyncSync(fd)
      order.push('public file fsynced')
    } finally {
      closeSync(fd)
    }
    const reloadedBytes = readFileSync(file)
    assert.deepEqual(reloadedBytes, publicBytes)
    const reloaded = JSON.parse(
      reloadedBytes.toString('utf8'),
    ) as RecoveryPackage
    validateRecoveryPackage(reloaded, expected)
    order.push('exact public bytes reloaded and verified')
    const delivered = second.trace.release()
    releaseCallbacks++
    order.push('held frame delivered to B exactly once')
    must(destroyKeyShare(aShare))
    must(destroyKeyShare(bShare))
    destroyed = true
    order.push('both J handles destroyed')
    assert.equal(must(describeKeyShare(aShare)).burned, true)
    assert.equal(must(describeKeyShare(bShare)).burned, true)
    assert.equal(delivered.result?.kind, 'adaptor-signature')
    if (delivered.result?.kind === 'adaptor-signature')
      assert.equal(
        c.hex(delivered.result.adaptorSignature),
        reloaded.xec.signature,
      )
    const compact = must(
      completeAdaptorSignature({
        ...context(reloaded.xec),
        secret: lock.secret,
      }),
    )
    const normalized = secp256k1.Signature.fromCompact(compact).normalizeS(),
      der = normalized.toDERRawBytes()
    const signedClaim = {
      ...claim,
      inputs: [
        {
          ...claim.inputs[0]!,
          scriptSig: c.concat(
            c.push(c.concat(der, c.bytes('41'))),
            c.bytes('51'),
            c.push(redeem),
          ),
        },
      ],
    }
    const claimRaw = c.raw(signedClaim),
      claimId = c.txid(signedClaim)
    assert.ok(claimRaw.length / 2 <= Number(FEE))
    assert.ok(FEE <= 2000n)
    lock.secret.fill(0)
    lock.opening.secret.fill(0)
    observations.push({
      label: 'B original t buffers wiped before A observation',
      originalSecretPassedToA: false,
    })
    const revealTip = await tip(),
      revealEvm = await provider.getBlock('latest')
    assert.ok(revealEvm)
    assert.ok(
      Math.abs(revealTip.time - revealEvm.timestamp) <=
        binding.crossClockMargin,
    )
    const revealNow = Math.max(revealTip.time, revealEvm.timestamp)
    assert.ok(
      revealNow + binding.revealInclusionMargin < refundTimestamp,
      'honest B reveal cutoff checked immediately before broadcast',
    )
    assert.ok(
      revealNow + binding.responseMargin + binding.crossClockMargin <
        base + duration,
    )
    assert.equal(
      (await contract.getFunction('channels').staticCall(channelId)).settled,
      false,
    )
    const policy = await rpc<Array<{ allowed: boolean }>>('testmempoolaccept', [
      [claimRaw],
    ])
    assert.equal(policy[0]!.allowed, true)
    const claimTxid = await rpc<string>('sendrawtransaction', [claimRaw])
    assert.equal(claimTxid, claimId)
    let claimBlockHash = (
      await rpc<{ hash: string }>('generateblock', ['raw(6a)', [claimRaw]])
    ).hash
    let native = await rpc<NativeBlock>('getblock', [claimBlockHash, 2]),
      observed = native.tx.find(tx => tx.txid === claimId)!
    assert.ok(observed)
    assert.equal(observed.hex, claimRaw)
    assert.equal(observed.vout[0]!.scriptPubKey.hex, c.hex(recipient))
    assert.equal(Math.round(observed.vout[0]!.value * 100), Number(X))
    assert.equal(await rpc('gettxout', [fundingId, 0, false]), null)
    await record()
    await mine(1)
    let confirmed = await rpc<{ confirmations: number }>('getblockheader', [
      claimBlockHash,
    ])
    assert.ok(confirmed.confirmations >= 2)
    order.push('actual ABC claim observed and verified')
    if (scenario === 'settlement-reorg') {
      const oldHeight = native.height
      const { exerciseXecSettlementReorg } = await import('./settlement-reorg')
      const reorg = await exerciseXecSettlementReorg(
        rpc,
        {
          version: 1,
          recovery: reloaded,
          expected,
          fundingAnchor: {
            hash: fundingResult.hash,
            height: fundingBlock.height,
          },
          claimAnchor: { hash: claimBlockHash, height: native.height },
          claimRaw: observed.hex,
        },
        directory,
      )
      claimBlockHash = reorg.anchor.hash
      native = reorg.block
      observed = reorg.claim
      confirmed = await rpc('getblockheader', [claimBlockHash])
      const oldIndex = headers.findIndex(
        header => Number(header.height) === oldHeight,
      )
      assert.ok(oldIndex >= 0)
      headers.splice(oldIndex)
      headers.push(
        ...reorg.observation.canonicalHeaders
          .filter(header => header.height >= oldHeight)
          .map(header => ({ ...header })),
      )
      observations.push(reorg.observation)
      order.push(
        'orphan claim retained as knowledge; same original bytes reincluded',
      )
    }
    const wrongIntent = {
      ...signedClaim,
      outputs: [{ ...signedClaim.outputs[0]!, value: X - 1n }],
    }
    assert.throws(() =>
      completeEvmFromObserved(reloaded, expected, c.raw(wrongIntent)),
    )
    const alteredCompact = normalized.toCompactRawBytes().slice()
    alteredCompact[63] ^= 1
    const alteredDer =
      secp256k1.Signature.fromCompact(alteredCompact).toDERRawBytes()
    const wrongSignature = {
      ...signedClaim,
      inputs: [
        {
          ...signedClaim.inputs[0]!,
          scriptSig: c.concat(
            c.push(c.concat(alteredDer, c.bytes('41'))),
            c.bytes('51'),
            c.push(redeem),
          ),
        },
      ],
    }
    assert.throws(() =>
      completeEvmFromObserved(reloaded, expected, c.raw(wrongSignature)),
    )
    let completion: ReturnType<typeof completeEvmFromObserved>
    if (scenario === 'delayed-observer') {
      const { discoverDelayedClaim } = await import('./settlement-reorg')
      const delayed = await discoverDelayedClaim(
        rpc,
        provider,
        reloaded,
        expected,
        { hash: fundingResult.hash, height: fundingBlock.height },
        directory,
      )
      completion = delayed.completion
      observations.push(delayed.observation)
      headers.push(
        ...delayed.observation.canonicalHeaders
          .filter(header => header.height > Number(headers.at(-1)!.height))
          .map(header => ({ ...header })),
      )
      order.push(
        'fresh delayed observer discovered claim from native block history',
      )
    } else
      completion = completeEvmFromObserved(reloaded, expected, observed.hex)
    order.push(
      'A extracted from native observed signature and completed EVM authorization',
    )
    const finalXec = await tip()
    let closeAt = finalXec.time + binding.crossClockMargin
    assert.ok(closeAt < base + duration)
    assert.ok(
      closeAt - finalXec.time <=
        binding.responseMargin + binding.crossClockMargin,
    )
    const settlementSnapshot =
      scenario === 'settlement-reorg'
        ? ((await provider.send('evm_snapshot', [])) as string)
        : undefined
    await provider.send('evm_setNextBlockTimestamp', [closeAt])
    const closeData = contract.interface.encodeFunctionData(
      'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)',
      [
        channelId,
        1,
        [M, 0n],
        a.address,
        ZeroAddress,
        reloaded.bSignature,
        completion.evmSignature,
      ],
    )
    const sent = await relayer.sendTransaction({
      to: contractAddress,
      data: closeData,
      gasLimit: GAS,
      maxFeePerGas: PRICE,
      maxPriorityFeePerGas: 1n,
    })
    let receipt = await sent.wait()
    assert.ok(receipt && receipt.status === 1)
    if (settlementSnapshot !== undefined) {
      const signedRaw = (await provider.send('eth_getRawTransactionByHash', [
        sent.hash,
      ])) as string
      assert.equal(typeof signedRaw, 'string')
      const { exerciseEvmSettlementReorg } = await import('./settlement-reorg')
      const reorg = await exerciseEvmSettlementReorg({
        provider,
        recovery: reloaded,
        expected,
        claimRaw: observed.hex,
        snapshot: settlementSnapshot,
        originalReceipt: receipt,
        signedRaw,
        directory,
        opening: {
          hash: openReceipt.blockHash,
          height: openReceipt.blockNumber,
        },
        relayer: relayer.address,
        balanceA,
        balanceRelay,
      })
      receipt = reorg.receipt
      closeAt = reorg.timestamp
      observations.push(reorg.observation)
      order.push(
        'orphan EVM settlement replaced only by original signed transaction',
      )
    }
    const block = await provider.getBlock(receipt.blockNumber)
    assert.equal(block!.timestamp, closeAt)
    const settled = receipt.logs
      .map(log =>
        contract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        }),
      )
      .find(log => log?.name === 'ChannelSettled')
    assert.ok(settled)
    assert.equal(settled.args.channelId, channelId)
    assert.equal(settled.args.cooperative, true)
    assert.equal(settled.args.finalBalances[0], M)
    assert.equal(settled.args.finalBalances[1], 0n)
    assert.equal(
      (await contract.getFunction('channels').staticCall(channelId)).settled,
      true,
    )
    assert.equal((await provider.getBalance(a.address)) - balanceA, M)
    assert.equal(
      (await provider.getBalance(b.address)) - balanceB,
      -M - openReceipt.fee,
    )
    assert.equal(
      (await provider.getBalance(relayer.address)) - balanceRelay,
      -receipt.fee,
    )
    assert.equal(await provider.getBalance(jointAddress), 0n)
    assert.equal(await provider.getBalance(contractAddress), 0n)
    for (const r of [openReceipt, receipt])
      assert.ok(r.gasUsed <= GAS && r.gasPrice <= PRICE)
    const deploymentReceipt = (await deployment
      .deploymentTransaction()!
      .wait())!
    assert.ok(
      deploymentReceipt.gasUsed <= 3000000n &&
        deploymentReceipt.gasPrice <= PRICE,
    )
    const aggregateGas = deploymentReceipt.fee + openReceipt.fee + receipt.fee
    assert.ok(aggregateGas <= BigInt(binding.gasBudgetWei))
    order.push(
      'independent relayer EVM receipt status1; fixed A payout verified',
    )
    const receiptPublic = (r: TransactionReceipt) => ({
      hash: r.hash,
      blockhash: r.blockHash,
      blockNumber: r.blockNumber,
      status: r.status,
      gasUsed: r.gasUsed.toString(),
      gasPrice: r.gasPrice.toString(),
      feeWei: r.fee.toString(),
      logs: r.logs.map(log => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      })),
    })
    observations.push({
      label: 'functional release barrier',
      releaseCallbacks,
      heldFrameHash: hash(second.trace.held),
      publicPackageHash: hash(publicBytes),
      evmOnlyPreFundingPackageHash: hash(evmOnlyBytes),
      evmOnlyPreFundingFsyncAcknowledged: true,
      reloadedExactBytes: true,
      fsyncAcknowledged: true,
      shareHandlesDestroyed: true,
      keygenTranscriptHashes: keys.hashes,
      sessionTranscriptHashes: {
        evm: first.trace.hashes,
        xec: [...second.trace.hashes, hash(second.trace.held)],
      },
      sequentialSessions: signingCount,
    })
    observations.push({
      label: 'native ABC conditional claim',
      raw: observed.hex,
      txid: claimId,
      broadcastRpcTxid: claimTxid,
      miningRpc: 'generateblock',
      blockhash: claimBlockHash,
      height: native.height,
      confirmations: confirmed.confirmations,
      principalSats: Number(X),
      feeSats: Number(FEE),
      size: claimRaw.length / 2,
      revealTip,
      revealNow,
      cutoff: refundTimestamp - binding.revealInclusionMargin,
      policy,
      normalizedLowS: normalized.s <= secp256k1.CURVE.n / 2n,
      observedCompactSignature: completion.observedCompactSignature,
      observedDigest: completion.observedDigest,
    })
    observations.push({
      label: 'wrong observed intent and wrong observed signature rejected',
      wrongIntentRejected: true,
      wrongSignatureRejected: true,
    })
    observations.push({
      label: 'EVM completion solely from public packages and native extraction',
      extractionVerified: completion.extractionVerified,
      originalSecretPassedToA: false,
      jSignature: completion.evmSignature,
      parity: completion.parity,
      calldata: closeData,
      timestamp: closeAt,
      receipt: receiptPublic(receipt),
      aPrincipalWei: M.toString(),
      bNetWei: (-M - openReceipt.fee).toString(),
      relayerNetWei: (-receipt.fee).toString(),
      jointBalanceWei: '0',
      contractBalanceWei: '0',
    })
    observations.push({
      label: 'native deposits and separated fees',
      openingTimestamp: base,
      earliestFallback: base + duration,
      refundFinalBound: binding.refundFinalBound,
      responseMargin: binding.responseMargin,
      crossClockMargin: binding.crossClockMargin,
      openReceipt: receiptPublic(openReceipt),
      deploymentReceipt: receiptPublic(deploymentReceipt),
      aggregateGasWei: aggregateGas.toString(),
      gasBudgetWei: binding.gasBudgetWei,
      funding: {
        raw: fundingRaw,
        txid: fundingId,
        blockhash: fundingResult.hash,
        inputSats: sourceAmount.toString(),
        lockedSats: (X + FEE).toString(),
        changeSats: change.toString(),
        feeSats: FEE.toString(),
        sourceCoinbaseRaw: source.hex,
        sourceCoinbaseTxid: source.txid,
        sourceConfirmations: sourceUtxo.confirmations,
      },
    })
    return {
      ...(scenario ? { scenario } : {}),
      scope: scenario
        ? `ordinary local ${scenario} witness; no malicious security, general reorg theorem, power-loss or production assurance`
        : 'one experimental dealerless J / owned T native conditional-success witness; no malicious security, restart, rollback, power-loss or production assurance',
      hypotheses: [
        'static at-most-one-party corruption theorem remains unproved',
        'custom joint DLEQ plus Paillier and two sequential same-J/T composition require external assurance',
        'fresh entropy and exclusive in-process J sessions; no export/reconstruction',
        'functional Node file fsync barrier only, not browser C0/C1 or antirollback durability',
        'fixed local clocks/fees, depth2 XEC, bounded honest reveal and EVM response; no censorship/reorg theorem',
      ],
      publicPackage: reloaded,
      expected,
      identities: {
        xec: {
          chainIdentifier: 'xec-regtest',
          client: (await rpc<{ subversion: string }>('getnetworkinfo'))
            .subversion,
          checkpoint: binding.xecCheckpoint,
        },
        evm: {
          chainIdentifier: 'monad-regtest',
          simulator: evm.version,
          clientVersion: await provider.send('web3_clientVersion', []),
          nativeChainId: '20143',
          checkpoint: binding.evmCheckpoint,
          contract: contractAddress,
          runtimeHash: binding.runtimeHash,
        },
        refundPublicKey: c.hex(refundPub),
      },
      headers,
      observations,
      order,
    }
  } finally {
    if (!destroyed) {
      must(destroyKeyShare(aShare))
      must(destroyKeyShare(bShare))
    }
  }
}
if (require.main === module) {
  ;(async () => {
    const archive = process.env.ADAPTOR_ABC_ARCHIVE,
      binaryDir = process.env.FRANK_BITCOIN_ABC_BIN_DIR
    if (!archive || !binaryDir)
      throw new Error('verified ABC archive and binary directory required')
    console.log(
      JSON.stringify(
        await runNativeConditionalSuccess({ archive, binaryDir }),
        null,
        2,
      ),
    )
  })().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
