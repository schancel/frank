const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const fixturePath = require.resolve('./cltv-consensus-fixture.ts')

test('both ordinary entrypoints are import-safe', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
    const assert = require('node:assert/strict');
    for (const [name, methods] of Object.entries({fs:['mkdirSync','mkdtempSync','writeFileSync'], child_process:['spawn','execFileSync'], net:['createServer','connect']})) {
      const module = require(name);
      for (const method of methods) module[method] = () => { throw new Error('import side effect: '+method) };
    }
    global.fetch = () => { throw new Error('import network') };
    const code = process.exitCode;
    const listeners = process.eventNames().map(name => [name, process.listenerCount(name)]);
    const fixture = require(${JSON.stringify(fixturePath)});
    assert.equal(typeof fixture.runCltvConsensusFixture, 'function');
    assert.equal(process.exitCode, code);
    assert.deepEqual(process.eventNames().map(name => [name, process.listenerCount(name)]), listeners);
  `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, TSX_DISABLE_CACHE: '1' } })
  assert.equal(result.status, 0, result.stderr)
})

test('real ordinary ABC CLTV/MTP, re-signed negatives, races, local accounting and cleanup', async () => {
  const { runCltvConsensusFixture } = require('./cltv-consensus-fixture.ts')
  assert.ok(process.env.ADAPTOR_ABC_ARCHIVE, 'verified pinned archive required')
  assert.ok(process.env.FRANK_BITCOIN_ABC_BIN_DIR, 'verified pinned binary required')
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort()
  const options = { archive: process.env.ADAPTOR_ABC_ARCHIVE, binaryDir: process.env.FRANK_BITCOIN_ABC_BIN_DIR }
  const evidence = await runCltvConsensusFixture(options)
  assert.match(evidence.scope, /not joint J/)
  assert.notEqual(evidence.publicKeys.claim, evidence.publicKeys.refund)
  assert.match(evidence.redeemScript, new RegExp('^6321' + evidence.publicKeys.claim + 'ac67.*b17521' + evidence.publicKeys.refund + 'ac68$'))
  const observation = label => {
    const item = evidence.observations.find(item => item.label === label)
    assert.ok(item, 'missing evidence: ' + label)
    return item
  }
  const minus = observation('previous-tip MTP T_X-1')
  const equal = observation('previous-tip MTP T_X equality')
  const plus = observation('previous-tip MTP T_X+1 independent refund positive control')
  assert.deepEqual([minus.previousTip.mediantime, equal.previousTip.mediantime, plus.previousTip.mediantime], [evidence.timestamp - 1, evidence.timestamp, evidence.timestamp + 1])
  assert.equal(minus.spend.raw, equal.spend.raw)
  assert.equal(equal.spend.raw, plus.spend.raw)
  assert.equal(minus.nativeRejection.code, -25)
  assert.equal(equal.nativeRejection.code, -25)
  assert.ok(plus.nativeInclusion.hash)
  assert.ok(minus.previousTip.height >= 1351)
  for (const label of ['final sequence cannot bypass CLTV', 'locktime below script timestamp', 'height versus timestamp mismatch', 'wrong independent refund key']) {
    const item = observation(label)
    assert.equal(item.nativeRejection.code, -25)
    assert.equal(item.tipUnchanged, true)
    assert.equal(item.outpointUnchanged, true)
    assert.notEqual(item.spend.digest, plus.spend.digest)
  }
  for (const label of ['refund after canonical claim', 'claim after canonical refund']) {
    assert.equal(observation(label).canonicalInputSpent, true)
    assert.match(observation(label).nativeRejection.message, /inputs-missingorspent/)
  }
  const late = observation('unspent claim remains valid after T_X; no claim expiry')
  assert.ok(late.previousTip.mediantime > evidence.timestamp)
  assert.ok(late.nativeInclusion.hash)
  const feeProbe = observation('zero fee policy rejected but native valid; deliberately outside fee envelope')
  assert.equal(feeProbe.mempoolPolicy.allowed, false)
  assert.match(feeProbe.mempoolPolicy['reject-reason'], /fee/)
  assert.ok(feeProbe.nativeInclusion.hash)
  const bump = observation('refund fee adjustment independently authorized; no replacement/finality claim')
  assert.equal(bump.original.signerPublicKey, evidence.publicKeys.refund)
  assert.equal(bump.adjusted.signerPublicKey, evidence.publicKeys.refund)
  assert.equal(bump.original.principalSats, bump.adjusted.principalSats)
  assert.ok(bump.adjusted.feeSats > bump.original.feeSats)
  const positives = evidence.observations.filter(item => item.nativeInclusion)
  assert.equal(positives.length, 7)
  for (const item of positives) assert.equal(item.recipientSats, 10000)
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort(), before)
  await assert.rejects(runCltvConsensusFixture({ ...options, timeoutMs: 1 }), /readiness timeout/)
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort(), before)
})

test('an exercise error after owned startup still removes both nodes and datadirs', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const {tmpdir} = require('node:os');
    const snapshot = () => fs.readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort();
    const before = snapshot();
    require('node:crypto').randomBytes = () => Buffer.alloc(32);
    const {runCltvConsensusFixture} = require(${JSON.stringify(fixturePath)});
    (async () => {
      await assert.rejects(runCltvConsensusFixture({archive:process.env.ADAPTOR_ABC_ARCHIVE,binaryDir:process.env.FRANK_BITCOIN_ABC_BIN_DIR}), /private key|privateKey/);
      assert.deepEqual(snapshot(), before);
    })().catch(error => {console.error(error.message);process.exitCode=1});
  `], { encoding: 'utf8', timeout: 45000 })
  assert.equal(result.status, 0, result.stderr)
})
