const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const entry = require.resolve('./settlement-reorg.ts')
const snapshot = () =>
  readdirSync(tmpdir())
    .filter(name =>
      [
        'frank-owned-template-',
        'frank-pair-clock-anvil-',
        'frank-native-conditional-',
      ].some(prefix => name.startsWith(prefix)),
    )
    .sort()
const options = () => {
  assert.ok(process.env.ADAPTOR_ABC_ARCHIVE)
  assert.ok(process.env.FRANK_BITCOIN_ABC_BIN_DIR)
  return {
    archive: process.env.ADAPTOR_ABC_ARCHIVE,
    binaryDir: process.env.FRANK_BITCOIN_ABC_BIN_DIR,
  }
}
const find = (proof, label) => {
  const value = proof.observations.find(item => item.label === label)
  assert.ok(value, 'missing observation: ' + label)
  return value
}
function retainPublic(proof, name) {
  if (!process.env.SETTLEMENT_REORG_EVIDENCE_DIR) return
  const funding = proof.observations.find(
    value => value.fundingAnchor,
  )?.fundingAnchor
  assert.ok(funding)
  const compact = {
    ...proof,
    headers: proof.headers.filter(
      header => Number(header.height) >= funding.height,
    ),
  }
  assert.ok(compact.headers.length <= 33)
  writeFileSync(
    join(process.env.SETTLEMENT_REORG_EVIDENCE_DIR, name + '.json'),
    JSON.stringify(compact, null, 2) + '\n',
    { flag: 'wx' },
  )
}
test('ordinary settlement proof imports without key, filesystem, process or network effects', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const assert=require('node:assert/strict');
    for(const [name, methods] of Object.entries({fs:['mkdirSync','mkdtempSync','writeFileSync','openSync'],child_process:['spawn','execFileSync','spawnSync'],net:['createServer','connect'],crypto:['randomBytes','randomFillSync']})) {
      const module=require(name); for(const method of methods) module[method]=()=>{throw Error('import effect '+method)};
    }
    global.fetch=()=>{throw Error('import network')};
    const listeners=process.eventNames().map(name=>[name,process.listenerCount(name)]);
    const fixture=require(${JSON.stringify(entry)});
    assert.equal(typeof fixture.runSettlementReorgProof,'function');
    assert.equal(typeof fixture.runDelayedObserverProof,'function');
    assert.deepEqual(process.eventNames().map(name=>[name,process.listenerCount(name)]),listeners);
  `,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    },
  )
  assert.equal(result.status, 0, result.stderr)
})
test(
  'ordinary XEC and EVM settlements disconnect then reinclude original signed artifacts',
  { timeout: 240000 },
  async () => {
    const before = snapshot()
    const proof =
      await require('./settlement-reorg.ts').runSettlementReorgProof(options())
    const barrier = find(proof, 'functional release barrier')
    assert.equal(barrier.sequentialSessions, 2)
    assert.equal(barrier.shareHandlesDestroyed, true)
    assert.equal(barrier.fsyncAcknowledged, true)
    const xec = find(
      proof,
      'XEC settlement disconnected and exact claim reincluded',
    )
    assert.equal(xec.disconnectedProjection.state, 'observed/noncanonical')
    assert.equal(xec.disconnectedProjection.completionKnown, true)
    assert.equal(xec.canonicalFundingUnspentDespiteHistoricalClaim, true)
    assert.equal(xec.currentProjection.state, 'canonical')
    assert.ok(xec.currentProjection.depth >= 2)
    assert.notEqual(xec.original.hash, xec.reincluded.hash)
    assert.equal(xec.originalSecretOrJointHandlePassed, false)
    assert.equal(xec.missingAndMismatchedBindingsRejected, true)
    const evm = find(
      proof,
      'EVM settlement disconnected and same signed transaction reincluded',
    )
    assert.equal(evm.disconnected.state, 'observed/noncanonical')
    assert.equal(evm.disconnected.receipt, null)
    assert.equal(evm.restartedPublicObserver.state, 'observed/noncanonical')
    assert.equal(evm.restartedPublicObserver.completionKnown, true)
    assert.equal(evm.reincludedPublicObserver.state, 'canonical')
    assert.equal(evm.reincluded.hash, evm.originalReceipt.hash)
    assert.notEqual(evm.reincluded.blockHash, evm.originalReceipt.blockHash)
    assert.equal(evm.exactOriginalSignedRawReused, true)
    assert.equal(evm.originalNonceRemainedValid, true)
    assert.equal(evm.canonicalPrincipalWei, '10000000000000000')
    const settlement = find(
      proof,
      'EVM completion solely from public packages and native extraction',
    )
    assert.equal(
      settlement.jSignature,
      xec.freshPublicProcessCompletion.evmSignature,
    )
    assert.equal(settlement.receipt.hash, evm.reincluded.hash)
    assert.equal(settlement.receipt.feeWei, evm.canonicalRelayerFeeWei)
    assert.equal(settlement.relayerNetWei, '-' + evm.canonicalRelayerFeeWei)
    retainPublic(proof, 'settlement-reorg')
    assert.deepEqual(snapshot(), before)
  },
)
test(
  'late public observer discovers earlier claim after refund MTP and settles inside original envelope',
  { timeout: 240000 },
  async () => {
    const before = snapshot()
    const proof =
      await require('./settlement-reorg.ts').runDelayedObserverProof(options())
    const late = find(
      proof,
      'observer starts after refund maturity and discovers earlier claim',
    )
    assert.equal(late.receivedClaimNotification, false)
    assert.equal(late.originalSecretOrJointHandlePassed, false)
    assert.ok(late.started.mediantime > late.refundTimestamp)
    assert.ok(late.started.time <= late.refundFinalBound)
    assert.ok(
      late.remainingWindowSeconds > late.responseMargin + late.crossClockMargin,
    )
    const settlement = find(
      proof,
      'EVM completion solely from public packages and native extraction',
    )
    assert.equal(
      settlement.jSignature,
      late.freshPublicProcessCompletion.evmSignature,
    )
    assert.ok(settlement.timestamp > late.refundTimestamp)
    assert.ok(
      settlement.timestamp <=
        Math.max(late.started.time, late.evmTimestamp) +
          late.responseMargin +
          late.crossClockMargin,
    )
    assert.ok(settlement.timestamp < late.earliestFallback)
    assert.equal(settlement.receipt.status, 1)
    retainPublic(proof, 'delayed-observer')
    assert.deepEqual(snapshot(), before)
  },
)
