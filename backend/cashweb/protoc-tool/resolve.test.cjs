const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const resolver = path.join(__dirname, 'resolve.sh')
const relayDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(relayDir, '../..')
const installed = spawnSync('/bin/bash', [resolver, repoRoot], { encoding: 'utf8' })
assert.equal(installed.status, 0, installed.stderr)
const compiler = installed.stdout.trim()

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frank protoc test '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  for (const tool of ['perl', 'mktemp', 'rm', 'rmdir']) {
    const location = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    fs.symlinkSync(location, path.join(bin, tool))
  }
  const env = { PATH: bin, TMPDIR: root }
  const write = (relative, content, mode = 0o755) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, { mode })
    return file
  }
  const native = relative => {
    const file = write(relative, fs.readFileSync(compiler))
    // Homebrew's protoc locates its shared libraries beside ../bin. Preserve
    // that readonly layout when moving the executable into a path with spaces.
    const sourceLib = path.resolve(path.dirname(compiler), '../lib')
    const targetLib = path.resolve(path.dirname(file), '../lib')
    if (fs.existsSync(sourceLib) && !fs.existsSync(targetLib)) fs.symlinkSync(sourceLib, targetLib)
    return fs.realpathSync(file)
  }
  const run = extra => spawnSync('/bin/bash', [resolver, root], {
    env: { ...env, ...extra }, encoding: 'utf8',
  })
  return { root, bin, env, write, native, run }
}

test('explicit native override keeps spaces and wins over PATH; relative paths work', t => {
  const f = fixture(t)
  const selected = f.native('chosen compiler/protoc')
  f.native('bin/protoc')
  assert.equal(f.run({ PROTOC: selected }).stdout, `${selected}\n`)
  const result = spawnSync('/bin/bash', [resolver, f.root], {
    cwd: f.root, env: { ...f.env, PROTOC: './chosen compiler/protoc' }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${selected}\n`)
})

test('invalid overrides fail without falling back, including version and compile failures', t => {
  const f = fixture(t)
  f.native('bin/protoc')
  const badVersion = f.write('old', '#!/bin/sh\necho "libprotoc 2.6.1"\n')
  const badCompile = f.write('broken', '#!/bin/sh\nif [ "$1" = --version ]; then echo "libprotoc 3.20.3"; else exit 1; fi\n')
  const notExecutable = f.write('not executable', 'unused', 0o644)
  for (const candidate of ['', '/no-such-compiler', badVersion, badCompile, notExecutable]) {
    const result = f.run({ PROTOC: candidate })
    assert.equal(result.status, 69, result.stderr)
    assert.match(result.stderr, /PROTOC is unusable; set it to an executable native protoc/)
    assert.equal(result.stdout, '')
    if (candidate) assert.ok(!result.stderr.includes(candidate))
  }
})

test('no compiler gives an actionable early diagnostic', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 69)
  assert.match(result.stderr, /no usable protoc found; install a native protoc/)
  assert.match(result.stderr, /CASHWEBD_BIN skips/)
})

function npmFixture(f) {
  const wrapper = f.write('node_modules/protoc/bin/protoc', '#!/usr/bin/env node\r\nthrow new Error("CLI must not run")\r\n')
  f.write('node_modules/protoc/protoc.js', 'module.exports = "protoc/bin/protoc"\n')
  const npmBin = path.join(f.root, 'node_modules/.bin')
  fs.mkdirSync(npmBin)
  fs.symlinkSync('../protoc/bin/protoc', path.join(npmBin, 'protoc'))
  return { wrapper, npmBin, original: fs.readFileSync(wrapper) }
}

test('actual CRLF failure is bypassed for npm native compilation without changing the wrapper', t => {
  const f = fixture(t)
  const npm = npmFixture(f)
  const failed = spawnSync(npm.wrapper, ['--version'], { env: f.env, encoding: 'utf8' })
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /node(?:\r|\\r)/)
  const native = f.native('node_modules/protoc/protoc/bin/protoc')
  const result = f.run({ PATH: `${npm.npmBin}:${f.bin}` })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${native}\n`)
  // Compile a real proto through the selected compiler, as prost does. The
  // source-build launcher gate additionally runs the actual workspace prost builds.
  const proto = f.write('example.proto', 'syntax = "proto3"; package example; message Example { string value = 1; }')
  const descriptor = path.join(f.root, 'example.pb')
  const compiled = spawnSync(result.stdout.trim(), [
    `--proto_path=${f.root}`, `--descriptor_set_out=${descriptor}`, proto,
  ], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  assert.ok(fs.statSync(descriptor).size > 0)
  assert.deepEqual(fs.readFileSync(npm.wrapper), npm.original)
  assert.equal(f.run({ PROTOC: npm.wrapper }).status, 69)
  assert.equal(f.run({ PROTOC: native }).stdout, `${native}\n`)
})

test('PATH native wins after a broken npm wrapper, even without its native payload', t => {
  const f = fixture(t)
  const npm = npmFixture(f)
  const native = f.native('bin/protoc')
  const result = f.run({ PATH: `${npm.npmBin}:${f.bin}` })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${native}\n`)
  assert.deepEqual(fs.readFileSync(npm.wrapper), npm.original)
})

test('repository npm installation is discovered without .bin on PATH', t => {
  const f = fixture(t)
  const native = f.native('node_modules/protoc/protoc/bin/protoc')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${native}\n`)
})

test('launcher passes the selected path only to Cargo and fails before Cargo for a bad override', t => {
  const f = fixture(t)
  const relay = path.join(f.root, 'backend/cashweb')
  fs.mkdirSync(path.join(relay, 'protoc-tool'), { recursive: true })
  for (const file of ['run-local-monad.sh', 'cashwebd.local.toml']) {
    fs.copyFileSync(path.join(relayDir, file), path.join(relay, file))
  }
  fs.copyFileSync(resolver, path.join(relay, 'protoc-tool/resolve.sh'))
  f.write('.agents/scripts/with-cargo-slot', '#!/bin/bash\nexec "$@"\n')
  const native = f.native('bin/protoc')
  const npm = npmFixture(f)
  const daemon = f.write('daemon', '#!/bin/bash\n[[ -z "${PROTOC+x}" ]] || exit 23\n/bin/cat >/dev/null\n')
  const capture = path.join(f.root, 'cargo-compiler')
  const cargo = f.write('cargo', `#!/bin/bash\nprintf '%s' "$PROTOC" > "$CAPTURE"\nprintf '%s\\n' '${JSON.stringify({ reason: 'compiler-artifact', target: { name: 'cashwebd-exe', kind: ['bin'] }, executable: daemon })}'\n`)
  const env = {
    PATH: `${npm.npmBin}:${f.bin}:/usr/bin:/bin`, HOME: f.root,
    MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:9', CARGO: cargo, CAPTURE: capture,
  }
  const result = spawnSync('/bin/bash', [path.join(relay, 'run-local-monad.sh')], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(capture, 'utf8'), native)
  fs.unlinkSync(capture)
  const invalid = spawnSync('/bin/bash', [path.join(relay, 'run-local-monad.sh')], {
    env: { ...env, PROTOC: '/bad/override' }, encoding: 'utf8',
  })
  assert.equal(invalid.status, 69)
  assert.equal(fs.existsSync(capture), false)
})
