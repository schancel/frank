/** Ordinary single-chain CLTV evidence; no threshold/adaptor or cross-chain assurance. */
import assert from 'assert/strict'
import { createHash, randomBytes } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  XEC_REGTEST, encodeScriptNum, internalHashFromDisplay, displayTxidFromBytes,
  serializeTransaction, parseTransaction, sighash, transactionId, type Transaction,
} from '@frank/nakamoto'
import { startOwnedTemplateFixture, type ReadyTemplateFixture } from './owned-template-fixture'

const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
const concat = (...values: Uint8Array[]) => new Uint8Array(Buffer.concat(values.map(value => Buffer.from(value))))
function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`transaction API rejected: ${JSON.stringify(result.error)}`)
  return result.value
}
function push(value: Uint8Array): Uint8Array {
  if (value.length <= 75) return concat(bytes(value.length.toString(16).padStart(2, '0')), value)
  assert.ok(value.length <= 255)
  return concat(bytes('4c'), bytes(value.length.toString(16).padStart(2, '0')), value)
}
function hash160(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('ripemd160').update(createHash('sha256').update(value).digest()).digest())
}
const p2pkh = (pub: Uint8Array) => concat(bytes('76a914'), hash160(pub), bytes('88ac'))
const p2sh = (redeem: Uint8Array) => concat(bytes('a914'), hash160(redeem), bytes('87'))
const raw = (tx: Transaction) => hex(must(serializeTransaction(tx, XEC_REGTEST)))
const txid = (tx: Transaction) => hex(must(transactionId(tx, XEC_REGTEST)).slice().reverse())
const digest = (tx: Transaction, script: Uint8Array, value: bigint) => must(sighash(tx, 0, XEC_REGTEST, 0x41, { algorithm: 'forkid', scriptCode: script, amount: value }))
const makeTransaction = (prevTxid: string, vout: number, outputValue: bigint, script: Uint8Array, locktime = 0, sequence = 0xffffffff): Transaction => ({
    version: 2, inputs: [{ prevout: { txid: internalHashFromDisplay(must(displayTxidFromBytes(bytes(prevTxid)))), vout }, scriptSig: new Uint8Array(), sequence }],
    outputs: [{ value: outputValue, scriptPubKey: script }], locktime,
  })

function redeemScript(claimPub: Uint8Array, refundPub: Uint8Array, timestamp: number): Uint8Array {
  return concat(bytes('63'), push(claimPub), bytes('ac67'), push(encodeScriptNum(BigInt(timestamp))), bytes('b175'), push(refundPub), bytes('ac68'))
}
function signOrdinary(planned: Transaction, redeem: Uint8Array, inputValue: bigint, key: Uint8Array, branch: 'claim' | 'refund') {
  const hash = digest(planned, redeem, inputValue)
  const signer = secp256k1.getPublicKey(key, true)
  const signature = secp256k1.sign(hash, key, { prehash: false, lowS: true })
  assert.ok(secp256k1.verify(signature.toCompactRawBytes(), hash, signer, { prehash: false, lowS: true }))
  const der = signature.toDERRawBytes()
  const tx = { ...planned, inputs: [{ ...planned.inputs[0]!, scriptSig: concat(push(concat(der, bytes('41'))), bytes(branch === 'claim' ? '51' : '00'), push(redeem)) }] }
  const serialized = raw(tx)
  assert.equal(hex(digest(must(parseTransaction(bytes(serialized), XEC_REGTEST)), redeem, inputValue)), hex(hash))
  return { tx, raw: serialized, digest: hex(hash), signatureDer: hex(der), signerPublicKey: hex(signer) }
}
/** Pure ordinary test construction shared by native clock fixtures; no keys or nodes on import. */
export const ordinaryCltv = { hex, bytes, concat, push, p2pkh, p2sh, raw, txid, digest, transaction: makeTransaction, redeemScript, sign: signOrdinary }

const PRINCIPAL = 10000n
const FEE = 1000n
const BUMPED_FEE = 1500n
const FEE_ENVELOPE = { minimumSatsPerKb: 1000, maximumSats: 2000, normalSats: Number(FEE), bumpedSats: Number(BUMPED_FEE), principalSats: Number(PRINCIPAL) }
interface Header { hash: string; height: number; time: number; mediantime: number; previousblockhash?: string; confirmations: number }
interface Output { value: number; scriptPubKey: { hex: string } }
interface Block { hash: string; height: number; confirmations: number; tx: Array<{ txid: string; hex: string; vout: Array<Output & { n: number }> }> }
interface Policy { txid: string; allowed: boolean; 'reject-reason'?: string }
interface SignedSpend {
  tx: Transaction
  raw: string
  txid: string
  digest: string
  signatureDer: string
  signerPublicKey: string
  branch: 'claim' | 'refund'
  input: { txid: string; vout: number; valueSats: number }
  principalSats: number
  feeSats: number
  size: number
  locktime: number
  sequence: number
}
export interface CltvEvidence {
  scope: string
  chainIdentifier: 'xec-regtest'
  version: string
  checkpoint: { height: number; hash: string }
  timingAssumptions: { finality: string; confirmationDepth: number; clock: string; activationHeights: { bip113: number; cltv: number } }
  feeEnvelope: typeof FEE_ENVELOPE
  publicKeys: { claim: string; refund: string }
  refundDestinationScript: string
  redeemScript: string
  timestamp: number
  funding: unknown
  headers: Header[]
  observations: Array<Record<string, unknown>>
}
/** All effects occur after an explicit call; all keys are newly created disposable fixture keys. */
export async function runCltvConsensusFixture(options: Parameters<typeof startOwnedTemplateFixture>[0]): Promise<CltvEvidence> {
  const fixture = await startOwnedTemplateFixture(options)
  try { return await exercise(fixture) } finally { await fixture.stop() }
}
async function exercise(fixture: ReadyTemplateFixture): Promise<CltvEvidence> {
  const rpc = fixture.rpc
  const claimKey = new Uint8Array(randomBytes(32))
  const refundKey = new Uint8Array(randomBytes(32))
  const claimPub = secp256k1.getPublicKey(claimKey, true)
  const refundPub = secp256k1.getPublicKey(refundKey, true)
  assert.notEqual(hex(claimPub), hex(refundPub))
  const tip = async (): Promise<Header> => {
    const { hash, height, time, mediantime, previousblockhash, confirmations } = await rpc<Header>('getblockheader', [await rpc<string>('getbestblockhash')])
    return { hash, height, time, mediantime, previousblockhash, confirmations }
  }
  const initial = await tip()
  const timestamp = initial.time + 3000
  assert.ok(timestamp >= 500000000)
  const redeem = redeemScript(claimPub, refundPub, timestamp)
  const contractScript = p2sh(redeem)
  const recipient = p2pkh(claimPub)
  const refundDestination = p2pkh(refundPub)
  const evidence: CltvEvidence = {
    scope: 'ordinary local CLTV only; K_claim is not joint J; no threshold/adaptor/cross-chain evidence',
    chainIdentifier: 'xec-regtest', version: (await rpc<{ subversion: string }>('getnetworkinfo')).subversion,
    checkpoint: { height: initial.height, hash: initial.hash },
    timingAssumptions: { finality: 'nLockTime must be strictly below previous-tip MTP with non-final sequence; claim has no expiry', confirmationDepth: 2, clock: 'controlled node mocktime; observed native headers and previous-tip median only', activationHeights: { bip113: 576, cltv: 1351 } },
    feeEnvelope: FEE_ENVELOPE, publicKeys: { claim: hex(claimPub), refund: hex(refundPub) },
    refundDestinationScript: hex(refundDestination), redeemScript: hex(redeem), timestamp,
    funding: null, headers: [initial], observations: [],
  }
  const recordTip = async () => {
    const header = await tip()
    assert.equal(header.previousblockhash, evidence.headers.at(-1)!.hash)
    evidence.headers.push(header)
    if (evidence.headers.length >= 11) {
      const times = evidence.headers.slice(-11).map(item => item.time).sort((a, b) => a - b)
      assert.equal(header.mediantime, times[5], 'independent median of actual last eleven header timestamps')
    }
    return header
  }
  const mineEmpty = async (count: number) => {
    for (let i = 0; i < count; i++) { await rpc('generatetodescriptor', [1, 'raw(6a)']); await recordTip() }
  }
  const moveMtp = async (target: number) => {
    assert.ok((await tip()).mediantime <= target, 'clock must move forward')
    await rpc('setmocktime', [target])
    for (let i = 0; (await tip()).mediantime < target; i++) { assert.ok(i < 12, 'MTP advancement bound'); await mineEmpty(1) }
    assert.equal((await tip()).mediantime, target)
  }
  const signed = (vout: number, branch: 'claim' | 'refund', overrides: { locktime?: number; sequence?: number; wrongKey?: boolean; fee?: bigint } = {}): SignedSpend => {
    const fee = overrides.fee ?? FEE
    const transaction = makeTransaction(fundingId, vout, PRINCIPAL, branch === 'claim' ? recipient : refundDestination,
      overrides.locktime ?? (branch === 'refund' ? timestamp : 0), overrides.sequence ?? (branch === 'refund' ? 0xfffffffe : 0xffffffff))
    const inputValue = amounts[vout]!
    const changeValue = inputValue - PRINCIPAL - fee
    assert.ok(changeValue >= 0n)
    const planned = changeValue === 0n ? transaction : { ...transaction, outputs: [...transaction.outputs, { value: changeValue, scriptPubKey: refundDestination }] }
    // Every modified timing/sequence variant is signed again over its actual final fields.
    const key = overrides.wrongKey ? claimKey : branch === 'claim' ? claimKey : refundKey
    const result = signOrdinary(planned, redeem, inputValue, key, branch)
    const { tx, raw: serialized } = result
    assert.equal(inputValue - tx.outputs.reduce((sum, output) => sum + output.value, 0n), fee)
    const size = serialized.length / 2
    if (fee !== 0n) assert.ok(fee >= BigInt(size) && fee <= BigInt(FEE_ENVELOPE.maximumSats), 'declared local fee envelope')
    return { ...result, txid: txid(tx), branch,
      input: { txid: fundingId, vout, valueSats: Number(inputValue) }, principalSats: Number(PRINCIPAL), feeSats: Number(fee), size, locktime: tx.locktime, sequence: tx.inputs[0]!.sequence }
  }
  const publicSpend = ({ tx: _tx, ...publicFields }: SignedSpend) => publicFields
  const unspent = (spend: SignedSpend) => rpc<Output | null>('gettxout', [fundingId, spend.input.vout, false])
  const policy = async (spend: SignedSpend) => (await rpc<Policy[]>('testmempoolaccept', [[spend.raw]]))[0]!
  const reject = async (label: string, spend: SignedSpend, reason: RegExp) => {
    const before = await tip()
    const output = await unspent(spend)
    assert.ok(output, 'negative must have an unspent input')
    assert.equal(output.scriptPubKey.hex, hex(contractScript))
    assert.equal(Math.round(output.value * 100), spend.input.valueSats)
    const mempool = await policy(spend)
    assert.equal(mempool.allowed, false)
    let failure: { code: number; message: string } | undefined
    try { await rpc('generateblock', ['raw(6a)', [spend.raw]]) } catch (error) {
      assert.ok(error instanceof Error && 'code' in error)
      failure = { code: Number(error.code), message: error.message }
    }
    assert.ok(failure, `${label}: native rejection required`)
    assert.equal(failure.code, -25)
    assert.match(failure.message, reason)
    assert.equal((await tip()).hash, before.hash)
    assert.deepEqual(await unspent(spend), output)
    evidence.observations.push({ label, spend: publicSpend(spend), previousTip: before, mempoolPolicy: mempool, nativeRejection: failure, tipUnchanged: true, outpointUnchanged: true })
  }
  const includedBlocks: string[] = []
  const include = async (label: string, spend: SignedSpend) => {
    const before = await tip()
    const available = await unspent(spend)
    assert.ok(available)
    assert.equal(available.scriptPubKey.hex, hex(contractScript))
    assert.equal(Math.round(available.value * 100), spend.input.valueSats)
    const mempool = await policy(spend)
    if (spend.feeSats > 0) assert.equal(mempool.allowed, true, `${label}: normal policy positive control`)
    const result = await rpc<{ hash: string }>('generateblock', ['raw(6a)', [spend.raw]])
    const block = await rpc<Block>('getblock', [result.hash, 2])
    const observed = block.tx.find(tx => tx.txid === spend.txid)
    assert.ok(observed)
    assert.equal(observed.hex, spend.raw)
    assert.equal(await unspent(spend), null)
    const destination = spend.branch === 'claim' ? recipient : refundDestination
    assert.equal(observed.vout[0]!.scriptPubKey.hex, hex(destination))
    assert.equal(Math.round(observed.vout[0]!.value * 100), Number(PRINCIPAL))
    const payout = await rpc<Output>('gettxout', [spend.txid, 0, false])
    assert.equal(Math.round(payout.value * 100), Number(PRINCIPAL))
    await recordTip()
    includedBlocks.push(result.hash)
    evidence.observations.push({ label, spend: publicSpend(spend), previousTip: before, mempoolPolicy: mempool, nativeInclusion: { hash: result.hash, height: block.height, txid: observed.txid }, recipientSats: Number(PRINCIPAL), feeSats: spend.feeSats })
    return result.hash
  }
  // Mine directly to a public-key descriptor; no wallet or existing key material is used.
  await rpc('setmocktime', [timestamp - 1000])
  const coinbaseHash = (await rpc<string[]>('generatetodescriptor', [1, `raw(${hex(recipient)})`]))[0]!
  const coinbaseBlock = await rpc<Block>('getblock', [coinbaseHash, 2])
  await recordTip()
  // Default ABC regtest activates BIP113 at 576 and BIP65 at 1351. No overrides.
  await mineEmpty(1350)
  assert.ok((await tip()).height >= evidence.timingAssumptions.activationHeights.cltv)
  const coinbase = coinbaseBlock.tx[0]!
  const sourceOutput = coinbase.vout.find(output => output.scriptPubKey.hex === hex(recipient))!
  assert.ok(sourceOutput)
  const sourceValue = BigInt(Math.round(sourceOutput.value * 100))
  assert.ok(sourceValue > 100000n)
  const source = await rpc<Output & { confirmations: number }>('gettxout', [coinbase.txid, sourceOutput.n, false])
  assert.ok(source.confirmations >= 101)
  const amounts = [PRINCIPAL + FEE, PRINCIPAL + FEE, PRINCIPAL + FEE, PRINCIPAL + FEE, PRINCIPAL + FEE, PRINCIPAL + 3000n, PRINCIPAL]
  const totalLocked = amounts.reduce((sum, amount) => sum + amount, 0n)
  const funding = makeTransaction(coinbase.txid, sourceOutput.n, amounts[0]!, contractScript)
  const change = sourceValue - totalLocked - FEE
  const unsignedFunding = { ...funding, outputs: [...amounts.map(value => ({ value, scriptPubKey: contractScript })), { value: change, scriptPubKey: recipient }] }
  const fundingDigest = digest(unsignedFunding, recipient, sourceValue)
  const fundingSignature = secp256k1.sign(fundingDigest, claimKey, { prehash: false, lowS: true }).toDERRawBytes()
  const funded: Transaction = { ...unsignedFunding, inputs: [{ ...unsignedFunding.inputs[0]!, scriptSig: concat(push(concat(fundingSignature, bytes('41'))), push(claimPub)) }] }
  const fundingRaw = raw(funded)
  const fundingId = txid(funded)
  assert.ok(fundingRaw.length / 2 <= Number(FEE), 'funding fee at least 1 sat/byte')
  const fundingBlock = await rpc<{ hash: string }>('generateblock', ['raw(6a)', [fundingRaw]])
  const confirmedFunding = await rpc<Block>('getblock', [fundingBlock.hash, 2])
  assert.equal(confirmedFunding.tx.find(tx => tx.txid === fundingId)!.hex, fundingRaw)
  await recordTip()
  evidence.funding = { coinbase: { blockhash: coinbaseHash, txid: coinbase.txid, vout: sourceOutput.n, valueSats: sourceValue.toString(), confirmationsBeforeSpend: source.confirmations }, raw: fundingRaw, txid: fundingId, digest: hex(fundingDigest), signatureDer: hex(fundingSignature), lockedOutputSats: amounts.map(String), changeSats: change.toString(), feeSats: Number(FEE), size: fundingRaw.length / 2, blockhash: fundingBlock.hash }
  await include('ordinary claim positive control before refund maturity', signed(0, 'claim'))
  const refund = signed(1, 'refund')
  await moveMtp(timestamp - 1)
  await reject('previous-tip MTP T_X-1', refund, /bad-txns-nonfinal/)
  await moveMtp(timestamp)
  await reject('previous-tip MTP T_X equality', refund, /bad-txns-nonfinal/)
  await moveMtp(timestamp + 1)
  await include('previous-tip MTP T_X+1 independent refund positive control', refund)
  // Dedicated funded outpoint: all negative variants have a valid freshly recomputed signature.
  await reject('final sequence cannot bypass CLTV', signed(5, 'refund', { sequence: 0xffffffff, fee: BUMPED_FEE }), /mandatory-script-verify-flag-failed \(Locktime requirement not satisfied\)/)
  await reject('locktime below script timestamp', signed(5, 'refund', { locktime: timestamp - 1, fee: BUMPED_FEE }), /mandatory-script-verify-flag-failed \(Locktime requirement not satisfied\)/)
  await reject('height versus timestamp mismatch', signed(5, 'refund', { locktime: 100, fee: BUMPED_FEE }), /mandatory-script-verify-flag-failed \(Locktime requirement not satisfied\)/)
  await reject('wrong independent refund key', signed(5, 'refund', { wrongKey: true, fee: BUMPED_FEE }), /mandatory-script-verify-flag-failed \(Signature must be zero/)
  const claimFirst = signed(2, 'claim'), refundAfterClaim = signed(2, 'refund')
  await include('race claim first', claimFirst)
  await spentRace('refund after canonical claim', refundAfterClaim)
  const refundFirst = signed(3, 'refund'), claimAfterRefund = signed(3, 'claim')
  await include('race refund first', refundFirst)
  await spentRace('claim after canonical refund', claimAfterRefund)
  await include('unspent claim remains valid after T_X; no claim expiry', signed(4, 'claim'))
  const originalFee = signed(5, 'refund')
  const bumped = signed(5, 'refund', { fee: BUMPED_FEE })
  assert.notEqual(originalFee.digest, bumped.digest)
  assert.equal(originalFee.signerPublicKey, hex(refundPub))
  assert.equal(bumped.signerPublicKey, hex(refundPub))
  evidence.observations.push({ label: 'refund fee adjustment independently authorized; no replacement/finality claim', original: publicSpend(originalFee), adjusted: publicSpend(bumped), originalPolicy: await policy(originalFee), adjustedPolicy: await policy(bumped) })
  await include('independent refund key signs higher local fee', bumped)
  const free = signed(6, 'refund', { fee: 0n })
  const freePolicy = await policy(free)
  assert.equal(freePolicy.allowed, false)
  assert.match(freePolicy['reject-reason'] ?? '', /fee/)
  await include('zero fee policy rejected but native valid; deliberately outside fee envelope', free)
  await mineEmpty(1)
  for (const hash of includedBlocks) assert.ok((await rpc<Header>('getblockheader', [hash])).confirmations >= 2)
  evidence.observations.push({ label: 'positive inclusions confirmed', blocks: await Promise.all(includedBlocks.map(hash => rpc<Header>('getblockheader', [hash]))) })
  return evidence

  async function spentRace(label: string, loser: SignedSpend) {
    const before = await tip()
    assert.equal(await unspent(loser), null)
    const mempool = await policy(loser)
    assert.equal(mempool.allowed, false)
    let failure: { code: number; message: string } | undefined
    try { await rpc('generateblock', ['raw(6a)', [loser.raw]]) } catch (error) {
      assert.ok(error instanceof Error && 'code' in error)
      failure = { code: Number(error.code), message: error.message }
    }
    assert.ok(failure)
    assert.equal(failure.code, -25)
    assert.match(failure.message, /inputs-missingorspent/)
    assert.equal((await tip()).hash, before.hash)
    assert.equal(await unspent(loser), null)
    evidence.observations.push({ label, spend: publicSpend(loser), previousTip: before, mempoolPolicy: mempool, nativeRejection: failure, tipUnchanged: true, canonicalInputSpent: true })
  }
}
if (require.main === module) {
  const archive = process.env.ADAPTOR_ABC_ARCHIVE
  const binaryDir = process.env.FRANK_BITCOIN_ABC_BIN_DIR
  ;(async () => {
    if (!archive || !binaryDir) throw new Error('verified ABC archive and binary directory required')
    console.log(JSON.stringify(await runCltvConsensusFixture({ archive, binaryDir }), null, 2))
  })().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
