const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const fixturePath = require.resolve('./native-conditional-success.ts')
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
test('native conditional entrypoint imports without keys, state, process or network effects', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const assert = require('node:assert/strict');
    for (const [name, methods] of Object.entries({fs:['mkdirSync','mkdtempSync','writeFileSync','openSync'], child_process:['spawn','execFileSync'], net:['createServer','connect'], crypto:['randomBytes','randomFillSync']})) {
      const module = require(name);
      for (const method of methods) module[method] = () => { throw new Error('import side effect: '+method) };
    }
    global.fetch = () => { throw new Error('import network') };
    const code = process.exitCode;
    const listeners = process.eventNames().map(name => [name, process.listenerCount(name)]);
    assert.equal(typeof require(${JSON.stringify(
      fixturePath,
    )}).runNativeConditionalSuccess, 'function');
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
test('actual dealerless J conditional native success after fsync barrier and handle destruction', async () => {
  const {
    runNativeConditionalSuccess,
    validateRecoveryPackage,
    completeEvmFromObserved,
  } = require('./native-conditional-success.ts')
  const before = snapshot()
  const proof = await runNativeConditionalSuccess(options())
  assert.match(proof.scope, /no malicious security/)
  assert.equal(proof.identities.xec.chainIdentifier, 'xec-regtest')
  assert.equal(proof.identities.evm.chainIdentifier, 'monad-regtest')
  const find = label => {
    const item = proof.observations.find(item => item.label === label)
    assert.ok(item, 'missing evidence: ' + label)
    return item
  }
  const barrier = find('functional release barrier')
  assert.equal(barrier.releaseCallbacks, 1)
  assert.equal(barrier.sequentialSessions, 2)
  assert.equal(barrier.shareHandlesDestroyed, true)
  assert.equal(barrier.reloadedExactBytes, true)
  assert.equal(barrier.fsyncAcknowledged, true)
  assert.equal(barrier.evmOnlyPreFundingFsyncAcknowledged, true)
  assert.ok(
    proof.order.indexOf(
      'EVM-only public package fsynced and reloaded before B opening',
    ) < proof.order.indexOf('native EVM opening and backing verified'),
  )
  assert.equal(
    barrier.publicPackageHash,
    createHash('sha256')
      .update(JSON.stringify(proof.publicPackage))
      .digest('hex'),
  )
  assert.ok(
    proof.order.indexOf('public file fsynced') <
      proof.order.indexOf('held frame delivered to B exactly once'),
  )
  assert.ok(
    proof.order.indexOf('exact public bytes reloaded and verified') <
      proof.order.indexOf('held frame delivered to B exactly once'),
  )
  assert.ok(
    proof.order.indexOf('both J handles destroyed') <
      proof.order.indexOf('actual ABC claim observed and verified'),
  )
  assert.notEqual(
    proof.publicPackage.evm.sessionId,
    proof.publicPackage.xec.sessionId,
  )
  assert.equal(
    proof.publicPackage.evm.publicKey,
    proof.publicPackage.xec.publicKey,
  )
  assert.equal(proof.publicPackage.evm.point, proof.publicPackage.xec.point)
  assert.notEqual(
    proof.publicPackage.evm.signature.slice(0, 66),
    proof.publicPackage.xec.signature.slice(0, 66),
  )
  const claim = find('native ABC conditional claim')
  assert.equal(claim.broadcastRpcTxid, claim.txid)
  assert.equal(claim.miningRpc, 'generateblock')
  const clocks = find('pre-release native clocks and bounds verified')
  assert.ok(
    Math.abs(clocks.xecHeader.time - clocks.evmHeader.timestamp) <=
      clocks.crossClockMargin,
  )
  assert.equal(claim.principalSats, 10000)
  assert.equal(claim.feeSats, 1000)
  assert.ok(claim.confirmations >= 2)
  assert.ok(claim.revealNow < claim.cutoff)
  assert.equal(claim.normalizedLowS, true)
  const evm = find(
    'EVM completion solely from public packages and native extraction',
  )
  assert.equal(evm.receipt.status, 1)
  assert.equal(evm.originalSecretPassedToA, false)
  assert.equal(evm.extractionVerified, true)
  assert.equal(evm.aPrincipalWei, '10000000000000000')
  assert.equal(evm.jointBalanceWei, '0')
  assert.equal(evm.contractBalanceWei, '0')
  assert.ok(
    evm.timestamp <
      proof.publicPackage.binding.openingTimestamp +
        proof.publicPackage.binding.duration,
  )
  assert.equal(
    completeEvmFromObserved(proof.publicPackage, proof.expected, claim.raw)
      .evmSignature,
    evm.jSignature,
  )
  for (const label of [
    'wrong stored digest',
    'wrong stored T',
    'wrong stored session',
    'wrong stored contract',
    'wrong stored recipient',
  ]) {
    assert.equal(find(label).rejectedBeforeRelease, true)
    assert.equal(find(label).releaseCallbacks, 0)
  }
  const changed = structuredClone(proof.publicPackage)
  changed.binding.payoutA = proof.publicPackage.binding.participantB
  assert.throws(() => validateRecoveryPackage(changed, proof.expected))
  assert.equal(
    find('wrong observed intent and wrong observed signature rejected')
      .wrongSignatureRejected,
    true,
  )
  assert.deepEqual(snapshot(), before)
  await assert.rejects(
    runNativeConditionalSuccess({ ...options(), timeoutMs: 1 }),
    /readiness timeout/,
  )
  assert.deepEqual(snapshot(), before)
})
test('actual filesystem rejection with fresh J and fresh sessions withholds final callback and cleans nodes', async () => {
  const {
    runNativeConditionalSuccess,
    PublicStorageRejected,
  } = require('./native-conditional-success.ts')
  const before = snapshot()
  await assert.rejects(
    runNativeConditionalSuccess({ ...options(), rejectPublicStorage: true }),
    error => {
      assert.ok(error instanceof PublicStorageRejected)
      assert.equal(error.releaseCallbacks, 0)
      return true
    },
  )
  assert.deepEqual(snapshot(), before)
})
