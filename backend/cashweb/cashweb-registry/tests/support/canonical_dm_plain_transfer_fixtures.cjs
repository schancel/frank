// Regenerates the canonical direct-message request fixtures embedded in
// src/http/monad_message_cbor_tests.rs so that every signed stamp payment is a plain value
// transfer with empty calldata (#826).
//
// The sealed recipient payload, the crypto context and the multipart boundary of each fixture
// are kept byte for byte. Only the signed transactions are re-signed (same funding test key,
// nonce, fees, destination and value; no calldata; 21000 gas) and the transaction hashes listed
// in the type-1 delivery frame are updated to match. It also derives REPLAY_T_BODY_HEX: the
// genuine fixture with one ciphertext byte changed, listing the very same signed payment.
//
// The run is deterministic and idempotent (RFC 6979 signatures), so running it again on the
// checked-in file must leave it unchanged:
//
//   node backend/cashweb/cashweb-registry/tests/support/canonical_dm_plain_transfer_fixtures.cjs
//
// Offline test keys only (secp256k1 scalars 1 and 2). No chain, relay or directory is contacted.
const fs = require('fs'), path = require('path')
const repo = path.resolve(__dirname, '../../../../..')
const Module = require('module'), resolve = Module._resolveFilename
Module._resolveFilename = function (name, parent, ...args) {
  if (name === '@frank/crypto-box') name = repo + '/packages/crypto-box/src/index.ts'
  else if (name === '@frank/codec') name = repo + '/packages/frank-codec/src/index.ts'
  else if (name === '@frank/nakamoto') name = repo + '/packages/nakamoto/src/index.ts'
  else if (name.startsWith('@frank/nakamoto/'))
    name = repo + '/packages/nakamoto/src/' + name.slice('@frank/nakamoto/'.length)
  else if (name.startsWith('@frank/cashweb/'))
    name = repo + '/packages/cashweb/' + name.slice('@frank/cashweb/'.length)
  return resolve.call(this, name, parent, ...args)
}
require(repo + '/node_modules/tsx/dist/cjs/index.cjs')
const { Wallet, Transaction, keccak256 } = require(repo + '/node_modules/ethers')
const codec = require(repo + '/packages/frank-codec/src/index.ts')
const transport = require(repo + '/packages/cashweb/relay/canonical-dm-transport.ts')

const target = path.join(__dirname, '../../src/http/monad_message_cbor_tests.rs')
const funding = new Map(
  [1, 2].map(scalar => {
    const wallet = new Wallet('0x' + scalar.toString(16).padStart(64, '0'))
    return [wallet.address.toLowerCase(), wallet]
  }),
)
const boundaryOf = contentType => contentType.slice('multipart/form-data; boundary='.length)
const deliveryFields = delivery => {
  const frame = codec.validateFrame(delivery, codec.defaultContext())
  if (frame.kind !== 'parsed') throw Error('delivery frame did not parse')
  return new Map(frame.payload)
}
const encodeDelivery = fields =>
  codec.encodeFrame({ typeId: 1, schemaVersion: 1, minReaderVersion: 1 }, fields)

async function plainTransfers(bodyHex, contentType) {
  const request = transport.restoreCanonicalRequest({ body: codec.fromHex(bodyHex), contentType })
  const fields = deliveryFields(request.parts.delivery)
  const payments = fields.get(4n).map(payment => new Map(payment))
  if (payments.length !== request.parts.transactions.length) throw Error('member count')
  const transactions = []
  for (const [index, raw] of request.parts.transactions.entries()) {
    const old = Transaction.from('0x' + codec.toHex(raw))
    const wallet = funding.get(old.from.toLowerCase())
    if (!wallet || old.type !== 2) throw Error('unknown fixture funding key or type')
    const signed = await wallet.signTransaction({
      type: 2,
      chainId: old.chainId,
      nonce: old.nonce,
      maxPriorityFeePerGas: old.maxPriorityFeePerGas,
      maxFeePerGas: old.maxFeePerGas,
      gasLimit: 21000,
      to: old.to,
      value: old.value,
      accessList: old.accessList,
    })
    if (Transaction.from(signed).data !== '0x') throw Error('calldata survived')
    payments[index].set(1n, codec.fromHex(keccak256(signed).slice(2)))
    transactions.push(codec.fromHex(signed.slice(2)))
  }
  fields.set(4n, payments)
  return transport.freezeCanonicalRequest(
    { delivery: encodeDelivery(fields), context: request.parts.context, transactions },
    boundaryOf(contentType),
  )
}

/** Same signed payment, same ephemeral key, shared point and proof; different sealed body. */
function replayOf(request) {
  const fields = deliveryFields(request.parts.delivery)
  const sealed = codec.validateFrame(fields.get(2n), codec.defaultContext())
  if (sealed.kind !== 'parsed') throw Error('payload frame did not parse')
  const inner = new Map(sealed.payload)
  const box = Uint8Array.from(inner.get(4n))
  box[box.length - 1] ^= 1
  inner.set(4n, box)
  const payload = codec.encodeFrame({ typeId: 5, schemaVersion: 2, minReaderVersion: 2 }, inner)
  const digest = codec.recipientPayloadDigest(fields.get(0n), payload)
  fields.set(2n, payload)
  fields.set(3n, digest)
  fields.set(
    4n,
    fields.get(4n).map((payment, index) => {
      const next = new Map(payment)
      next.set(4n, codec.paymentCommitment(digest, index))
      return next
    }),
  )
  return transport.freezeCanonicalRequest(
    {
      delivery: encodeDelivery(fields),
      context: request.parts.context,
      transactions: request.parts.transactions,
    },
    'frank-replay-826',
  )
}

;(async () => {
  let source = fs.readFileSync(target, 'utf8')
  const hexOf = request => Buffer.from(request.body).toString('hex')
  const identities = []
  const constant = name => {
    const match = source.match(new RegExp(`const ${name}: &str = "([0-9a-f]*)";`))
    if (!match) throw Error(`missing ${name}`)
    return match
  }
  let genuine
  for (const [name, contentType] of [
    ['T_BODY_HEX', 'multipart/form-data; boundary=frank-fixture-777'],
    ['GENUINE_T_BODY_HEX', 'multipart/form-data; boundary=frank-genuine-777'],
    ['PREFIX_T_BODY_HEX', 'multipart/form-data; boundary=frank-prefix-777'],
  ]) {
    const [line, bodyHex] = constant(name)
    const before = transport.restoreCanonicalRequest({ body: codec.fromHex(bodyHex), contentType })
    const after = await plainTransfers(bodyHex, contentType)
    identities.push([before.identity.submission_identity, after.identity.submission_identity])
    // A test may also pin a member's exact raw bytes.
    before.parts.transactions.forEach((raw, index) =>
      identities.push([codec.toHex(raw), codec.toHex(after.parts.transactions[index])]),
    )
    source = source.replace(line, `const ${name}: &str = "${hexOf(after)}";`)
    if (name === 'GENUINE_T_BODY_HEX') genuine = after
    console.log(name, after.identity.submission_identity)
  }
  const replay = replayOf(genuine)
  source = source.replace(
    constant('REPLAY_T_BODY_HEX')[0],
    `const REPLAY_T_BODY_HEX: &str = "${hexOf(replay)}";`,
  )
  console.log('REPLAY_T_BODY_HEX', replay.identity.submission_identity)
  // Asserted submission identities and pinned raw members follow the re-signed transactions.
  for (const [before, after] of identities) source = source.split(before).join(after)
  fs.writeFileSync(target, source)
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
