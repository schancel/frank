/**
 * Regenerates (default) or checks (`--check`) every Frank-CBOR test vector corpus, in
 * dependency order. `yarn vectors:generate` / `yarn vectors:check`; see
 * docs/protocol/cbor/vectors/README.md.
 *
 * 1. Frozen corpora are re-encoded for the registry's type identifiers (vectors-renumber.mts).
 * 2. Builder corpora are rewritten from the codec fixture builders (vectors-builders.ts), the
 *    sealed-sender DM corpus from the renumbered suite-1 corpus (dm-sealed-sender-corpus.mts),
 *    and the message-stamp-derivation proposal from its generator (it also pins source hashes).
 * 3. The suite-1 directory and Forum proposals are rebuilt by their own proposal checkers.
 *    The suite-1 proposal pins hashes of the manifest and of docs/protocol/cbor/README.md and
 *    directory.cddl, so it follows the builders. The suite-1 Rust checker (`check.rs --write`)
 *    then re-signs `rust-origin.json` with the Rust signer, whose nonces differ from noble's.
 * 4. The builders run again (`directory-preview.json` reads the suite-1 proposal and
 *    `rust-origin.json`); the directory-admission corpus is expanded from the suite-1 proposal;
 *    the canonical direct-message request fixtures in cashweb-registry's
 *    `evm_direct_messages_tests.rs` are re-signed as plain transfers (#826).
 * 5. The Rust-origin and interoperability corpora are rewritten by their Rust tests.
 *
 * 6. The Rust proposal checkers (suite-1 directory, Forum content read, message stamp
 *    derivation) read the committed corpora and fail if any frame or derived value disagrees.
 *
 * Steps 1-5 need cargo only when generating; under --check the TypeScript suite-1 checker
 * verifies `rust-origin.json`, and `cargo test` compares the rest. Step 6 runs in both modes.
 * `--no-rust` skips every cargo step.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const check = process.argv.includes('--check')
const noRust = process.argv.includes('--no-rust')
const rust = !check && !noRust

function run(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  if (r.status !== 0) {
    process.stdout.write(r.stdout ?? '')
    throw new Error(`${cmd} ${args.join(' ')} failed`)
  }
  return r.stdout
}
const node = (script: string, ...args: string[]) =>
  run('node', ['--import', 'tsx', script, ...args])
/** A generator that prints the corpus: write it, or compare it with the committed file. */
function printed(path: string, cmd: string, args: string[]): void {
  const text = run(cmd, args)
  if (check) {
    if (readFileSync(resolve(ROOT, path), 'utf8') !== text)
      throw new Error(`${path} is stale; run yarn vectors:generate`)
  } else writeFileSync(resolve(ROOT, path), text)
}

/** A generator that rewrites `path` in place; under --check the file is restored and compared. */
function rewrites(path: string, generate: () => void): void {
  const file = resolve(ROOT, path)
  const before = readFileSync(file, 'utf8')
  generate()
  if (!check) return
  const after = readFileSync(file, 'utf8')
  writeFileSync(file, before)
  if (after !== before)
    throw new Error(`${path} is stale; run yarn vectors:generate`)
}

const flag = check ? ['--check'] : []
const builders = () =>
  node('packages/frank-codec/scripts/vectors-builders.ts', ...flag)
node('packages/frank-codec/scripts/vectors-renumber.mts', ...flag)
if (!check) builders()
// Derived from the renumbered named suite-1 corpus.
printed('docs/protocol/cbor/vectors/dm-sealed-sender.json', 'node', [
  '--import',
  'tsx',
  'packages/frank-codec/scripts/dm-sealed-sender-corpus.mts',
])
printed(
  'docs/protocol/proposals/message-stamp-derivation/vectors.json',
  'node',
  [
    'packages/domain-roots/proposals/message-stamp-derivation/run.cjs',
    '--emit',
  ],
)
node(
  'packages/frank-codec/proposals/suite1-directory/check.ts',
  ...(check ? [] : ['--write']),
)
if (rust)
  run('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    'backend/cashweb/frank-cbor/proposals/suite1-directory/Cargo.toml',
    '--',
    '--write',
  ])
if (check) node('packages/frank-codec/proposals/forum-content-read/check.ts')
else
  printed('docs/protocol/proposals/forum-content-read/vectors.json', 'node', [
    '--import',
    'tsx',
    'packages/frank-codec/proposals/forum-content-read/check.ts',
    '--emit',
  ])
builders()
if (check)
  run('node', [
    'backend/cashweb/cashweb-registry/tests/directory_preview_corpus.cjs',
    '--check',
  ])
else
  printed('docs/protocol/cbor/vectors/directory-admission.json', 'node', [
    'backend/cashweb/cashweb-registry/tests/directory_preview_corpus.cjs',
  ])
rewrites(
  'backend/cashweb/cashweb-registry/src/http/evm_direct_messages_tests.rs',
  () =>
    run('node', [
      'backend/cashweb/cashweb-registry/tests/support/canonical_dm_plain_transfer_fixtures.cjs',
    ]),
)
if (rust) {
  const manifest = ['--manifest-path', 'backend/cashweb/frank-cbor/Cargo.toml']
  run('cargo', ['test', '--quiet', ...manifest, '--test', 'rust_origin'], {
    FRANK_UPDATE_RUST_VECTORS: '1',
  })
  run('cargo', ['test', '--quiet', ...manifest, '--test', 'interoperability'], {
    FRANK_UPDATE_INTEROPERABILITY_VECTORS: '1',
  })
}
if (!noRust) {
  const proposals = [
    ...(check ? ['suite1-directory'] : []),
    'forum-content-read',
    'message-stamp-derivation',
  ]
  for (const proposal of proposals)
    run('cargo', [
      'run',
      '--quiet',
      '--locked',
      '--manifest-path',
      `backend/cashweb/frank-cbor/proposals/${proposal}/Cargo.toml`,
    ])
}
console.log(
  check
    ? 'vectors: every corpus matches its generator'
    : 'vectors: regenerated',
)
