const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const fixturePath = require.resolve('./pair-recovery-clock-fixture.ts')
const snapshot = () =>
  readdirSync(tmpdir())
    .filter(
      name =>
        name.startsWith('frank-owned-template-') ||
        name.startsWith('frank-pair-clock-anvil-'),
    )
    .sort()
const options = () => {
  assert.ok(process.env.ADAPTOR_ABC_ARCHIVE, 'verified pinned archive required')
  assert.ok(
    process.env.FRANK_BITCOIN_ABC_BIN_DIR,
    'verified pinned binary required',
  )
  return {
    archive: process.env.ADAPTOR_ABC_ARCHIVE,
    binaryDir: process.env.FRANK_BITCOIN_ABC_BIN_DIR,
  }
}
test('all ordinary fixture imports are free of process, network, key and state effects', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const assert = require('node:assert/strict');
    for (const [name, methods] of Object.entries({fs:['mkdirSync','mkdtempSync','writeFileSync'], child_process:['spawn','execFileSync'], net:['createServer','connect'],crypto:['randomBytes','randomFillSync']})) {
      const module = require(name);
      for (const method of methods) module[method] = () => { throw new Error('import side effect: '+method) };
    }
    global.fetch = () => { throw new Error('import network') };
    const code = process.exitCode;
    const listeners = process.eventNames().map(name => [name, process.listenerCount(name)]);
    assert.equal(typeof require(${JSON.stringify(
      fixturePath,
    )}).runPairRecoveryClockFixture, 'function');
    assert.equal(process.exitCode, code);
    assert.deepEqual(process.eventNames().map(name => [name, process.listenerCount(name)]), listeners);
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
test('actual dual custody recovery, opening-anchored strict horizon, deadline races and unsafe negative trace', async () => {
  const {
    runPairRecoveryClockFixture,
  } = require('./pair-recovery-clock-fixture.ts')
  const before = snapshot()
  const proof = await runPairRecoveryClockFixture(options())
  assert.match(proof.scope, /no threshold/)
  assert.equal(proof.identities.xec.chainIdentifier, 'xec-regtest')
  assert.equal(proof.identities.evm.chainIdentifier, 'monad-regtest')
  assert.equal(proof.identities.evm.nativeChainId, '20143')
  const find = label => {
    const item = proof.observations.find(item => item.label === label)
    assert.ok(item, 'missing evidence: ' + label)
    return item
  }
  const guard = find(
    'pure B0 horizon rejects equality and short before ordinary completion authorization',
  )
  assert.deepEqual(guard.safeErrors, [])
  assert.ok(guard.boundaryErrors.includes('unsafe-horizon'))
  assert.ok(guard.shortErrors.includes('unsafe-horizon'))
  assert.equal(guard.ordinaryCompletionReleasedForRejectedTerms, false)
  assert.equal(guard.thresholdCompletionReleased, false)
  assert.equal(
    find('safe ordinary K abandoned before recovery').claimKeyAvailable,
    false,
  )
  const rejected = find(
    'safe independent refunds: native refund before maturity rejected',
  )
  assert.equal(rejected.nativeError.code, -25)
  assert.equal(rejected.tipAndOutpointUnchanged, true)
  const refund = find('safe independent refunds: native refund canonical')
  assert.equal(
    refund.previousTip.mediantime,
    proof.schedules[0].xecRefundTimestamp + 1,
  )
  assert.ok(refund.confirmations >= 2)
  assert.equal(refund.recipientSats, 10000)
  assert.equal(
    refund.publicSpend.signerPublicKey,
    proof.funding.aRefundPublicKey,
  )
  const safe = find('safe XEC refund canonical before earliest EVM fallback')
  assert.ok(
    safe.earliest > safe.bound + safe.responseSeconds + safe.crossClockSeconds,
  )
  assert.ok(safe.xecFinalHeader.time <= safe.bound)
  assert.ok(safe.evmObservation.timestamp < safe.earliest)
  assert.equal(
    safe.evmObservation.timestamp - safe.xecFinalHeader.time,
    safe.crossClockSeconds,
  )
  const beforeDeadline = find('safe fallback before expiry rejects')
  const atDeadline = find(
    'safe independent refunds: independent relayer fallback',
  )
  const afterDeadline = find('safe fallback after settlement rejects')
  assert.equal(beforeDeadline.receipt.status, 0)
  assert.equal(atDeadline.receipt.status, 1)
  assert.equal(afterDeadline.receipt.status, 0)
  assert.equal(atDeadline.at - beforeDeadline.at, 1)
  assert.equal(afterDeadline.at - atDeadline.at, 1)
  const delayed = find('delayed challenge never widens admission horizon')
  assert.ok(delayed.errors.includes('unsafe-horizon'))
  assert.ok(delayed.observedExpiry > delayed.earliest)
  assert.equal(delayed.ordinaryCompletionReleased, false)
  assert.equal(
    find('independent fee payer cannot redirect fixed cooperative payout')
      .expectedError,
    'InvalidSignature',
  )
  assert.equal(
    find('fallback after cooperative close rejects').expectedError,
    'ChannelAlreadySettled',
  )
  assert.equal(
    find('cooperative close after fallback rejects').expectedError,
    'ChannelAlreadySettled',
  )
  assert.equal(
    find('cooperative close remains valid after expiry if fallback unset')
      .receipt.status,
    1,
  )
  const unsafe = find(
    'unsafe guard bypass trace only: inactive A loses both principals',
  )
  assert.equal(unsafe.admissible, false)
  assert.equal(unsafe.intentionallyBypassed, true)
  assert.equal(unsafe.secretExtraction, false)
  assert.ok(unsafe.violatedHorizonSeconds > 0)
  assert.equal(unsafe.bReceivesEvmPrincipalWei, '10000000000000000')
  assert.equal(unsafe.bReceivesXecPrincipalSats, 10000)
  const aggregate = find('aggregate actual gas within declared test budget')
  assert.ok(BigInt(aggregate.totalFeeWei) <= BigInt(aggregate.budgetWei))
  const actualFee = proof.observations
    .filter(item => item.receipt)
    .reduce(
      (sum, item) => sum + BigInt(item.receipt.feeWei),
      BigInt(proof.identities.deployment.feeWei),
    )
  assert.equal(actualFee, BigInt(aggregate.totalFeeWei))
  assert.equal(aggregate.unsettledSyntheticOutputs.length, 4)
  assert.deepEqual(snapshot(), before)
  await assert.rejects(
    runPairRecoveryClockFixture({ ...options(), timeoutMs: 1 }),
    /readiness timeout/,
  )
  assert.deepEqual(snapshot(), before)
})
function cleanupProbe(injection) {
  options()
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const assert = require('node:assert/strict');
    const fs = require('node:fs'), os = require('node:os');
    const snapshot = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('frank-owned-template-') || name.startsWith('frank-pair-clock-anvil-')).sort();
    const before = snapshot();
    ${injection}
    const {runPairRecoveryClockFixture} = require(${JSON.stringify(
      fixturePath,
    )});
    (async () => {
      await assert.rejects(runPairRecoveryClockFixture({archive:process.env.ADAPTOR_ABC_ARCHIVE,binaryDir:process.env.FRANK_BITCOIN_ABC_BIN_DIR}), error => error instanceof Error && error.message.length > 0);
      assert.deepEqual(snapshot(), before);
    })().catch(error => {console.error(error.message);process.exitCode=1});
  `,
    ],
    { encoding: 'utf8', timeout: 45000 },
  )
  assert.equal(result.status, 0, result.stderr)
}
test('failure after actual ABC and Anvil startup cleans all owned resources', () => {
  cleanupProbe("require('node:crypto').randomBytes = () => Buffer.alloc(32);")
})
test('SIGTERM during actual pair execution cleans both owned node families', () => {
  const supervisorPath = require.resolve('../supervisor.ts')
  cleanupProbe(`
    const {Supervisor} = require(${JSON.stringify(supervisorPath)});
    const original = Supervisor.prototype.start;
    Supervisor.prototype.start = function(params) {
      const child = original.call(this, params);
      if(params.name === 'pair-clock-anvil') setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
      return child;
    };
  `)
})
