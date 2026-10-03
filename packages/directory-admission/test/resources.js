import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import level from 'level'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  contentHash,
  directorySignatureDigest,
  encodeFrame,
  previewDirectoryContext,
  validateFrame,
} from '@frank/codec'
import { openNodeDirectoryStore } from '../src/node'
import {
  anchor,
  candidate,
  context,
  corpus,
  equal,
  assert,
  rejects,
} from './shared'

const template = validateFrame(
  candidate('bootstrap').statement,
  previewDirectoryContext(),
).payload
const privateKey = new Uint8Array(32)
privateKey[31] = 1 // Published synthetic subject, no live credentials.
function signed(revision, predecessor, padding = 0, entropy = 0) {
  const payload = new Map(template)
  payload.set(2n, BigInt(revision))
  payload.set(13n, predecessor)
  payload.set(100n, new Uint8Array(padding))
  const statement = encodeFrame(
    { typeId: 4, schemaVersion: 5, minReaderVersion: 4 },
    payload,
  )
  const extraEntropy = new Uint8Array(32)
  new DataView(extraEntropy.buffer).setUint32(28, entropy)
  const signature = secp256k1
    .sign(directorySignatureDigest(corpus.network, statement), privateKey, {
      lowS: true,
      extraEntropy,
    })
    .toDERRawBytes()
  const attestation = encodeFrame(
    { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
    new Map([
      [0n, statement],
      [
        1n,
        [
          new Map([
            [0n, 1n],
            [1n, template.get(1n)],
            [2n, signature],
          ]),
        ],
      ],
    ]),
  )
  const hash = contentHash(validateFrame(statement, previewDirectoryContext()))
  return { statement, attestation, hash }
}
const charge = record => record.statement.length + record.attestation.length
async function inspect(location, expectedRows, expectedBytes) {
  const db = level(location, { valueEncoding: 'utf8' })
  await db.open()
  let rows = 0
  let evidence = 0
  let bytes = 0
  try {
    for await (const row of db.createReadStream()) {
      rows++
      bytes += row.key.length + row.value.length
      if (row.key.startsWith('e:')) evidence++
    }
  } finally {
    await db.close()
  }
  equal(
    evidence,
    expectedRows,
    'real retained history has one physical row per statement',
  )
  equal(rows, expectedRows + 3, 'linear fixed metadata plus evidence layout')
  assert(
    bytes < expectedBytes * 4 + 10000,
    'no nested history snapshots or quadratic retained encoding',
  )
}
async function exercise(root, name, history, expectedBytes) {
  const location = path.join(root, name)
  const installed = anchor()
  installed.revisionZero = history[0].hash
  let store = await openNodeDirectoryStore({
    location,
    anchor: installed,
    mode: { kind: 'new' },
  })
  const started = Date.now()
  await store.enroll(history, context())
  const before = await store.status()
  equal(before.accepted, history.length, 'actual retained statement count')
  equal(
    before.chargedBytes,
    expectedBytes,
    'actual exact bare plus baseline wrapper charge',
  )
  // Invalid signatures deliberately ensure the cap check wins before cryptographic work.
  const invalid = {
    statement: new Uint8Array(1),
    attestation: new Uint8Array(1),
  }
  await rejects(
    () => store.advance([invalid], context()),
    'resource',
    'retained cap preflights before signature verification',
  )
  await rejects(
    () => store.advance([history[history.length - 1]], context()),
    'resource',
    'duplicate current still counted at retained cap',
  )
  equal(
    await store.status(),
    before,
    'cap failure preserves exact head/stamp/time/counters',
  )
  await store.close()
  await inspect(location, history.length, expectedBytes)
  store = await openNodeDirectoryStore({
    location,
    anchor: installed,
    mode: { kind: 'reopen', checkpoint: before.checkpoint },
  })
  equal(
    await store.status(),
    before,
    'actual capped history reopens without pruning or counter reset',
  )
  await store.close()
  console.log(
    JSON.stringify({
      gate: name,
      accepted: history.length,
      chargedBytes: expectedBytes,
      elapsedMs: Date.now() - started,
    }),
  )
}
async function wrapperBaseline(root) {
  const location = path.join(root, 'wrapper-baseline')
  const first = signed(0, null, 0, 1)
  const alternate = signed(0, null, 0, 2)
  equal(
    first.statement,
    alternate.statement,
    'alternate wrapper attests same exact statement',
  )
  assert(
    first.attestation.some((byte, i) => byte !== alternate.attestation[i]),
    'fixture contains distinct valid signature wrappers',
  )
  const installed = anchor()
  installed.revisionZero = first.hash
  const store = await openNodeDirectoryStore({
    location,
    anchor: installed,
    mode: { kind: 'new' },
  })
  try {
    await store.enroll([first], context())
    const before = await store.status()
    await store.advance([alternate], context())
    equal(
      await store.status(),
      before,
      'alternate wrapper cannot change charge/counters/expiry/grace',
    )
    equal(
      (await store.historicalEvidence(first.hash)).attestation,
      first.attestation,
      'first validating wrapper stays retained baseline',
    )
  } finally {
    await store.close()
  }
}
async function main() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'frank-admission-resources-')),
  )
  try {
    await wrapperBaseline(root)
    const countHistory = []
    for (let i = 0; i < corpus.statement_limit; i++)
      countHistory.push(signed(i, countHistory[i - 1]?.hash ?? null))
    await exercise(
      root,
      'actual-statement-cap',
      countHistory,
      countHistory.reduce((n, record) => n + charge(record), 0),
    )
    const byteHistory = []
    let total = 0
    while (corpus.charged_byte_limit - total > 400000) {
      const record = signed(
        byteHistory.length,
        byteHistory.at(-1)?.hash ?? null,
        100000,
      )
      byteHistory.push(record)
      total += charge(record)
    }
    const remainder = corpus.charged_byte_limit - total
    const base = signed(byteHistory.length, byteHistory.at(-1).hash)
    const estimate = Math.floor((remainder - charge(base)) / 2) - 10
    let final
    for (let padding = estimate; padding < estimate + 20 && !final; padding++) {
      for (let entropy = 0; entropy < 10 && !final; entropy++) {
        const record = signed(
          byteHistory.length,
          byteHistory.at(-1).hash,
          padding,
          entropy,
        )
        if (charge(record) === remainder) final = record
      }
    }
    assert(final, 'construct actual exact byte-cap history')
    byteHistory.push(final)
    assert(
      byteHistory.every(
        record =>
          Math.max(record.statement.length, record.attestation.length) <=
          corpus.frame_limit,
      ),
      'actual frames individually within codec limits',
    )
    await exercise(
      root,
      'actual-byte-cap',
      byteHistory,
      corpus.charged_byte_limit,
    )
    console.log(
      JSON.stringify({
        ok: true,
        retainedStatementCap: corpus.statement_limit,
        retainedByteCap: corpus.charged_byte_limit,
        stableAlternateWrapper: true,
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
