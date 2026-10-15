const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const entry = require.resolve('./refund-reorg.ts')
const snapshot = () =>
  readdirSync(tmpdir())
    .filter(name =>
      [
        'frank-owned-template-',
        'frank-pair-clock-anvil-',
        'frank-refund-observer-',
      ].some(prefix => name.startsWith(prefix)),
    )
    .sort()
test('refund proof imports without process, network, key or filesystem effects', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
 const assert=require('node:assert/strict');
 for(const [name,methods] of Object.entries({fs:['mkdtempSync','mkdirSync','openSync','writeFileSync'],child_process:['spawn','spawnSync','execFileSync'],net:['createServer','connect'],http:['createServer'],crypto:['randomBytes','randomFillSync']})) {
 const module=require(name);for(const method of methods) module[method]=()=>{throw Error('import effect '+method)};
 }
 global.fetch=()=>{throw Error('import network')};
 const listeners=process.eventNames().map(name=>[name,process.listenerCount(name)]);
 assert.equal(typeof require(${JSON.stringify(
   entry,
 )}).runRefundReorgProof,'function');
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
test('fixture observation proxy rejects mutation/oversize and closes on errors', async () => {
  const { withReadOnlyRpc } = require('./refund-reorg.ts')
  let forwarded = 0,
    endpoint
  await assert.rejects(
    withReadOnlyRpc(
      async () => {
        forwarded++
        return { chain: 'regtest' }
      },
      async url => {
        endpoint = url
        for (const body of [
          JSON.stringify({ method: 'invalidateblock', params: ['00'] }),
          'x'.repeat(4097),
        ]) {
          const response = await fetch(url, { method: 'POST', body })
          assert.equal(response.status, 400)
        }
        assert.equal(forwarded, 0)
        const response = await fetch(url, {
          method: 'POST',
          body: JSON.stringify({ method: 'getblockchaininfo', params: [] }),
        })
        assert.equal(response.status, 200)
        assert.equal(forwarded, 1)
        throw Error('owned observation failure')
      },
    ),
    /owned observation failure/,
  )
  await assert.rejects(fetch(endpoint))
})
test(
  'actual ordinary refund and fallback reorgs retain original signed artifacts and terminal observation',
  { timeout: 240000 },
  async () => {
    assert.ok(process.env.ADAPTOR_ABC_ARCHIVE)
    assert.ok(process.env.FRANK_BITCOIN_ABC_BIN_DIR)
    const before = snapshot()
    const proof = await require('./refund-reorg.ts').runRefundReorgProof({
      archive: process.env.ADAPTOR_ABC_ARCHIVE,
      binaryDir: process.env.FRANK_BITCOIN_ABC_BIN_DIR,
    })
    const find = label => {
      const value = proof.observations.find(item => item.label === label)
      assert.ok(value, label)
      return value
    }
    const xec = find(
      'S2b XEC refund disconnected and exact signed bytes reincluded',
    )
    assert.equal(xec.before.terminalRefund, true)
    assert.equal(xec.disconnected.terminalRefund, false)
    assert.equal(xec.disconnected.state, 'observed/noncanonical')
    assert.equal(xec.disconnected.artifactRetained, true)
    assert.equal(xec.disconnected.canonicalFundingUnspent, true)
    assert.equal(xec.current.terminalRefund, true)
    assert.ok(xec.current.depth >= 2)
    assert.notEqual(xec.publicRecord.inclusion.hash, xec.reincluded.hash)
    assert.equal(xec.exactOriginalSignedRawReused, true)
    assert.equal(xec.privateKeysPassed, false)
    assert.equal(xec.wrongChainAndMismatchedBindingsRejected, true)
    const evm = find(
      'S2b EVM fallback disconnected and exact signed transaction reincluded',
    )
    assert.equal(evm.before.terminalRefund, true)
    assert.equal(evm.disconnected.terminalRefund, false)
    assert.equal(evm.disconnected.receipt, null)
    assert.equal(evm.disconnected.channelSettled, false)
    assert.equal(evm.disconnected.contractBalanceWei, evm.canonicalPrincipalWei)
    assert.equal(evm.current.contractBalanceWei, '0')
    assert.equal(evm.current.terminalRefund, true)
    assert.equal(evm.exactOriginalSignedRawReused, true)
    assert.equal(evm.originalNonceRestored, true)
    assert.equal(evm.wrongChainAndMismatchedBindingsRejected, true)
    assert.equal(evm.originalReceipt.hash, evm.currentReceipt.hash)
    assert.notEqual(evm.originalReceipt.blockHash, evm.currentReceipt.blockHash)
    const refund = find(
      'safe independent refunds: independent relayer fallback',
    )
    assert.equal(refund.receipt.feeWei, evm.currentReceipt.feeWei)
    const terminal = find(
      'S2b fresh terminal fallback observer rejects valid cooperative completion',
    )
    assert.equal(terminal.observer.terminalRefund, true)
    assert.equal(terminal.observer.contractBalanceWei, '0')
    assert.equal(terminal.observer.cooperativeKnowledgeRetained, true)
    assert.equal(terminal.observer.cooperativeExecutable, false)
    const rejection = find('cooperative close after fallback rejects')
    assert.equal(rejection.receipt.status, 0)
    assert.equal(rejection.expectedError, 'ChannelAlreadySettled')
    assert.equal(
      find('all EVM principal and independent payer fees reconcile')
        .contractFinalWei,
      '0',
    )
    const aggregate = find('aggregate actual gas within declared test budget')
    const actual = proof.observations
      .filter(item => item.receipt)
      .reduce(
        (sum, item) => sum + BigInt(item.receipt.feeWei),
        BigInt(proof.identities.deployment.feeWei),
      )
    assert.equal(actual.toString(), aggregate.totalFeeWei)
    assert.deepEqual(snapshot(), before)
    if (process.env.REFUND_REORG_EVIDENCE_DIR) {
      const fundingHeight = xec.publicRecord.funding.height
      const compact = {
        ...proof,
        xecHeaders: proof.xecHeaders.filter(
          header => header.height >= fundingHeight,
        ),
      }
      assert.ok(compact.xecHeaders.length <= 33)
      writeFileSync(
        join(process.env.REFUND_REORG_EVIDENCE_DIR, 'refund-reorg.json'),
        JSON.stringify(compact, null, 2) + '\n',
        { flag: 'wx' },
      )
    }
  },
)
