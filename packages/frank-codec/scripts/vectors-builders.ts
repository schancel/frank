/**
 * Writes (or, with --check, compares) every vector corpus that a fixture builder produces.
 * Run by `yarn vectors:generate` after the frozen and proposal corpora, which some builders read.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { blackjackHandCorpus } from '../fixtures/blackjack-hand'
import { blackjackHandV3Corpus } from '../fixtures/blackjack-hand-v3'
import { experimentalSolanaStealthCorpus } from '../fixtures/experimental-solana-stealth'
import { buildForumCorpus } from '../fixtures/forum-content-read'
import { buildManifest } from '../fixtures/manifest'
import { stealthAssetCorpus } from '../fixtures/stealth-assets'
import { buildTopicCommitments } from '../fixtures/topic-commitments'

const ROOT = resolve(__dirname, '../../..')
const V = 'docs/protocol/cbor/vectors'
const corpora: [string, () => unknown][] = [
  [`${V}/manifest.json`, buildManifest],
  [`${V}/topic-commitments.json`, buildTopicCommitments],
  [`${V}/stealth-assets.json`, stealthAssetCorpus],
  [`${V}/blackjack-hand.json`, blackjackHandCorpus],
  [`${V}/blackjack-hand-v3.json`, blackjackHandV3Corpus],
  [`${V}/forum-content-read.json`, buildForumCorpus],
  [`${V}/directory-preview.json`, directoryPreview],
  [
    'packages/frank-codec/fixtures/experimental-solana-stealth-vectors.json',
    experimentalSolanaStealthCorpus,
  ],
]

/**
 * The codec's directory-preview corpus is the suite-1 proposal's records with authored
 * `expected` outcomes; `rust-origin-bootstrap` is the Rust signer's output
 * (`backend/cashweb/frank-cbor/proposals/suite1-directory/rust-origin.json`, written by that
 * proposal's `check.rs --write`).
 */
function directoryPreview(): unknown {
  const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
  const proposal = read(
    'docs/protocol/proposals/suite1-directory/vectors.json',
  ) as {
    records: { id: string }[]
  }
  const corpus = read(`${V}/directory-preview.json`) as {
    records: Record<string, unknown>[]
  }
  const byId = new Map<string, unknown>(proposal.records.map(r => [r.id, r]))
  byId.set(
    'rust-origin-bootstrap',
    read(
      'backend/cashweb/frank-cbor/proposals/suite1-directory/rust-origin.json',
    ),
  )
  return {
    ...corpus,
    records: corpus.records.map(r => {
      const p = byId.get(r.id as string)
      return p
        ? Object.fromEntries(
            Object.keys(r).map(key => [
              key,
              key !== 'expected' && key in (p as object)
                ? (p as Record<string, unknown>)[key]
                : r[key],
            ]),
          )
        : r
    }),
  }
}

/**
 * The new value written in the old file's layout: every scalar token of the old text is
 * replaced, in order, by the new value's scalar. A corpus whose shape changed is written as
 * `JSON.stringify(…, null, 2)`.
 */
function keepLayout(oldText: string, value: unknown): string {
  const scalars: unknown[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    else scalars.push(v)
  }
  walk(value)
  const token =
    /"(?:[^"\\]|\\.)*"(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g
  let i = 0
  const out = oldText.replace(token, (t: string, colon?: string) => {
    if (colon) return t
    return i < scalars.length ? JSON.stringify(scalars[i++]) : t
  })
  let same = i === scalars.length
  try {
    same = same && isDeepStrictEqual(JSON.parse(out), value)
  } catch {
    same = false
  }
  return same ? out : JSON.stringify(value, null, 2) + '\n'
}

const check = process.argv.includes('--check')
const stale: string[] = []
for (const [path, build] of corpora) {
  const file = resolve(ROOT, path)
  const old = readFileSync(file, 'utf8')
  const text = keepLayout(old, JSON.parse(JSON.stringify(build())))
  if (old === text) continue
  if (check) stale.push(path)
  else writeFileSync(file, text)
}
if (stale.length) {
  console.error(
    `builder corpora differ from their builders:\n  ${stale.join(
      '\n  ',
    )}\nRun yarn vectors:generate.`,
  )
  process.exit(1)
}
