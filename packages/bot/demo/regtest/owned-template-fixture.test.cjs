const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')

const fixturePath = require.resolve('./owned-template-fixture.ts')
test('pure import cannot start processes, create state, or access the network', () => {
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
    assert.equal(typeof fixture.startOwnedTemplateFixture, 'function');
    assert.equal(process.exitCode, code);
    assert.deepEqual(process.eventNames().map(name => [name, process.listenerCount(name)]), listeners);
  `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, TSX_DISABLE_CACHE: '1' } })
  assert.equal(result.status, 0, result.stderr)
})
test('actual disconnected RPC fails, then ordinary owned peer sync enables template; cleanup is idempotent', async () => {
  const { startOwnedTemplateFixture } = require('./owned-template-fixture.ts')
  assert.ok(process.env.ADAPTOR_ABC_ARCHIVE, 'verified archive required')
  assert.ok(process.env.FRANK_BITCOIN_ABC_BIN_DIR, 'verified binary required')
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort()
  const options = { archive: process.env.ADAPTOR_ABC_ARCHIVE, binaryDir: process.env.FRANK_BITCOIN_ABC_BIN_DIR }
  const fixture = await startOwnedTemplateFixture(options)
  try {
    assert.deepEqual(fixture.disconnectedError, { code: -9, message: 'Bitcoin is not connected!' })
    assert.equal(fixture.template.height, 2)
    assert.equal(fixture.template.transactions.length, 0)
    assert.equal(await fixture.rpc('getblockcount'), 1)
  } finally { await Promise.all([fixture.stop(), fixture.stop()]) }
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort(), before)
  await assert.rejects(startOwnedTemplateFixture({ ...options, timeoutMs: 1 }), /readiness timeout/)
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort(), before)
})
test('SIGTERM shuts down ready owned nodes and removes state', async () => {
  const { spawn } = require('node:child_process')
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort()
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', `
    require(${JSON.stringify(fixturePath)}).startOwnedTemplateFixture({archive:process.env.ADAPTOR_ABC_ARCHIVE,binaryDir:process.env.FRANK_BITCOIN_ABC_BIN_DIR})
      .then(() => console.log('ready'), error => {console.error(error.message);process.exitCode=1});
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signal fixture readiness timeout')), 40000)
      child.stdout.once('data', () => { clearTimeout(timer); resolve() })
      child.once('exit', () => { clearTimeout(timer); reject(new Error(stderr || 'fixture exited before ready')) })
    })
    child.kill('SIGTERM')
    const result = await exited
    assert.deepEqual(result, { code: 0, signal: null }, stderr)
    assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('frank-owned-template-')).sort(), before)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }
})
