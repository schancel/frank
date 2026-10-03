/** Public synthetic fixtures only. Proposed allocation, never a runtime key API. */
import assert from 'node:assert/strict'
import { createHmac, createHash, createECDH } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HDNodeWallet, computeAddress } from 'ethers'
import { deriveDomainRoot, type DomainPurpose } from '../../src'
import {
  encodeFrame,
  commonTranscript,
  type Encodable,
} from '../../../frank-codec/src'

const ROOT = resolve(__dirname, '../../../..')
const FILE = resolve(
  ROOT,
  'docs/protocol/proposals/message-stamp-derivation/vectors.json',
)
const REGISTRY = 'frank-domain-roots-v1'
const N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
)
const MAX = 2147483647n
const purposes = [
  'ecash-bch-wallet',
  'evm-wallet',
  'solana-wallet',
  'messaging-encryption',
  'identity-authentication',
] as const
type Role = 'auth' | 'main' | 'funding' | 'change' | 'message' | 'stamp'
type Node = { secret: Buffer; chain: Buffer }
type Leaf = {
  id: string
  role: Role
  purpose: DomainPurpose
  generation: string
  path: string
  indices_hex: string
  seed_hex: string
  private_hex: string
  public_hex: string
  chain_hex: string
  address: string
}
type Snapshot = {
  revision: string
  message_generation: string
  stamp_generation: string
  previous_stamp_generation: string | null
  auth: string
  message: string
  stamp: string
  previous_stamp: string | null
  type4_hex: string
  t1: string
}
type RestoreCase = {
  id: string
  account: number
  snapshot: number
  mutation?: string
  operation: 'restore' | 'stamp-admission' | 'message-admission' | 'archive'
  candidate_generation?: string
  expected: string
}
const fromHex = (s: string): Buffer => Buffer.from(s, 'hex')
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const scalar = (n: bigint): Buffer => fromHex(n.toString(16).padStart(64, '0'))
const integer = (b: Uint8Array): bigint => BigInt('0x' + hex(b))
const hmac = (algorithm: string, key: Uint8Array, data: Uint8Array): Buffer =>
  createHmac(algorithm, key).update(data).digest()
const sha = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')
const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
function point(secret: Uint8Array): Buffer {
  const curve = createECDH('secp256k1')
  curve.setPrivateKey(secret)
  return curve.getPublicKey(undefined, 'compressed')
}
function generation(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error('generation')
  const n = BigInt(value)
  if (n > MAX) throw new Error('generation')
  return n
}
function profile(role: Role): DomainPurpose {
  return role === 'auth'
    ? 'identity-authentication'
    : role === 'message'
    ? 'messaging-encryption'
    : 'evm-wallet'
}
function pathFor(role: Role, value: unknown): string {
  const g = generation(value)
  if (role === 'auth' || role === 'main') {
    if (g !== 0n) throw new Error('generation')
    return "m/44'/60'/1'/0/0"
  }
  if (role === 'message' || role === 'stamp')
    return `m/44'/60'/${role === 'message' ? 4 : 2}'/0'/${g}'`
  return `m/44'/60'/0'/${role === 'funding' ? 0 : 1}/${g}`
}
function indices(path: string): number[] {
  return path
    .split('/')
    .slice(1)
    .map(v => Number(v.replace("'", '')) + (v.endsWith("'") ? 0x80000000 : 0))
}
function master(seed: Buffer, injected?: Buffer): Node {
  const digest = injected ?? hmac('sha512', Buffer.from('Bitcoin seed'), seed)
  const n = integer(digest.subarray(0, 32))
  if (n === 0n || n >= N) throw new Error('master-scalar')
  return { secret: digest.subarray(0, 32), chain: digest.subarray(32) }
}
function child(parent: Node, index: number, injected?: Buffer): Node {
  const data = Buffer.concat([
    index >= 0x80000000
      ? Buffer.concat([Buffer.from([0]), parent.secret])
      : point(parent.secret),
    u32(index),
  ])
  const digest = injected ?? hmac('sha512', parent.chain, data)
  const left = integer(digest.subarray(0, 32))
  if (left >= N) throw new Error('child-scalar')
  const n = (left + integer(parent.secret)) % N
  // Exact-index CKDpriv: never call a library's recursive next-index retry.
  if (n === 0n) throw new Error('child-zero')
  return { secret: scalar(n), chain: digest.subarray(32) }
}
function derive(seed: Buffer, path: string): Node {
  return indices(path).reduce(
    (parent, index) => child(parent, index),
    master(seed),
  )
}
function leaf(account: Buffer, role: Role, g: string): Leaf {
  const purpose = profile(role)
  const seed = Buffer.from(deriveDomainRoot(account, purpose).bytes)
  const path = pathFor(role, g),
    node = derive(seed, path)
  // A separately maintained generic BIP32 implementation checks every natural vector.
  const independent = HDNodeWallet.fromSeed(seed).derivePath(path)
  assert.equal(independent.privateKey.slice(2), hex(node.secret))
  assert.equal(independent.publicKey.slice(2), hex(point(node.secret)))
  return {
    id: `${role}-${g}`,
    role,
    purpose,
    generation: g,
    path,
    indices_hex: hex(Buffer.concat(indices(path).map(u32))),
    seed_hex: hex(seed),
    private_hex: hex(node.secret),
    public_hex: hex(point(node.secret)),
    chain_hex: hex(node.chain),
    address: computeAddress('0x' + hex(point(node.secret))),
  }
}
function hkdf(account: Buffer, purpose: DomainPurpose) {
  const salt = Buffer.from('frank/domain-root-registry/v1'),
    id = Buffer.from(REGISTRY)
  const code = purposes.indexOf(purpose) + 1,
    label = Buffer.from(`frank/domain-root/v1/${purpose}`)
  const info = Buffer.concat([
    u16(id.length),
    id,
    u16(code),
    u16(label.length),
    label,
    u16(32),
  ])
  const prk = hmac('sha256', salt, account),
    output = hmac('sha256', prk, Buffer.concat([info, Buffer.from([1])]))
  assert.equal(hex(output), hex(deriveDomainRoot(account, purpose).bytes))
  return {
    purpose,
    code,
    label: label.toString(),
    salt_hex: hex(salt),
    info_hex: hex(info),
    prk_hex: hex(prk),
    output_hex: hex(output),
  }
}
const map = (...pairs: [number, Encodable][]): Map<number, Encodable> =>
  new Map(pairs)
const key = (p: string): Encodable => map([0, 1], [1, fromHex(p)])
const time = (n: bigint): Encodable => map([0, n], [1, 0])
function snapshots(leaves: Leaf[]): Snapshot[] {
  const get = (role: Role, g: string): string =>
    leaves.find(l => l.id === `${role}-${g}`)!.public_hex
  const result: Snapshot[] = []
  for (const [revision, mg, sg] of [
    [0, 0, 0],
    [1, 0, 1],
    [2, 0, 2],
    [3, 1, 2],
  ]) {
    const previous = sg === 0 ? null : String(sg - 1)
    const payload = map(
      [0, 'monad-testnet'],
      [1, key(get('auth', '0'))],
      [2, BigInt(revision)],
      [3, time(1700000000n + BigInt(revision))],
      [
        4,
        [
          map(
            [0, Uint8Array.from({ length: 16 }, (_, i) => i)],
            [1, 'https://relay.example.invalid'],
            [2, key(hex(point(scalar(9n))))],
            [3, time(1700007200n)],
          ),
        ],
      ],
      [6, time(1700003600n + BigInt(revision))],
      [8, key(get('stamp', String(sg)))],
      [10, key(get('message', String(mg)))],
      [11, BigInt(mg)],
      [12, BigInt(sg)],
      [13, result.length ? fromHex(result[result.length - 1].t1) : null],
    )
    const frame = encodeFrame(
      { typeId: 4, schemaVersion: 4, minReaderVersion: 4 },
      payload,
    )
    result.push({
      revision: String(revision),
      message_generation: String(mg),
      stamp_generation: String(sg),
      previous_stamp_generation: previous,
      auth: get('auth', '0'),
      message: get('message', String(mg)),
      stamp: get('stamp', String(sg)),
      previous_stamp: previous === null ? null : get('stamp', previous),
      type4_hex: hex(frame),
      t1: sha(
        commonTranscript('frank/content-hash/v1', 'monad-testnet', frame),
      ),
    })
  }
  return result
}
function cases(): RestoreCase[] {
  const c: RestoreCase[] = []
  for (let account = 0; account < 2; account++) {
    for (let snapshot = 0; snapshot < 4; snapshot++)
      c.push({
        id: `restore-${account}-${snapshot}`,
        account,
        snapshot,
        operation: 'restore',
        expected: 'accept',
      })
  }
  for (const mutation of [
    'registry',
    'recovery',
    'registry-code',
    'recovery-code',
    'message-purpose-code',
    'stamp-purpose-code',
    'interpretation',
    'seed-length',
    'purpose',
    'stamp-purpose',
    'auth-as-message',
    'evm-as-message',
    'stamp-as-message',
    'funding-as-stamp',
    'negated-message',
    'nonhardened-message',
    'nonhardened-stamp',
    'wrong-account',
    'missing-generation',
    'missing-stamp-generation',
    'wrong-message-generation',
    'wrong-stamp-generation',
    'overflow-generation',
    'missing-previous',
    'wrong-previous',
    'wrong-current',
    'network',
    'head-lost',
    't1',
  ])
    c.push({
      id: mutation,
      account: 0,
      snapshot: 2,
      operation: 'restore',
      mutation,
      expected: 'reject',
    })
  c.push({
    id: 'pair-lost-current-only',
    account: 0,
    snapshot: 2,
    operation: 'restore',
    mutation: 'pair-lost',
    expected: 'current-only',
  })
  for (const [id, operation, snapshot, g, expected] of [
    ['stamp-current', 'stamp-admission', 0, '0', 'accept'],
    ['compromised-after-one-rotation', 'stamp-admission', 1, '0', 'accept'],
    ['compromised-after-two-rotations', 'stamp-admission', 2, '0', 'reject'],
    ['previous-independent-restore', 'stamp-admission', 2, '1', 'accept'],
    ['renewal-does-not-clear-previous', 'stamp-admission', 3, '1', 'accept'],
    ['pair-lost-blocks-previous', 'stamp-admission', 2, '1', 'reject'],
    ['retired-message-no-new-admission', 'message-admission', 3, '0', 'reject'],
    ['current-message', 'message-admission', 3, '1', 'accept'],
    ['retired-message-archive', 'archive', 3, '0', 'archive-only'],
  ] as const)
    c.push({
      id,
      account: 0,
      snapshot,
      operation,
      candidate_generation: g,
      ...(id === 'pair-lost-blocks-previous' ? { mutation: 'pair-lost' } : {}),
      expected,
    })
  return c
}
function generate() {
  const old = JSON.parse(
    readFileSync(
      resolve(ROOT, 'packages/domain-roots/vectors/domain-roots-v1.json'),
      'utf8',
    ),
  )
  const accounts = old.vectors.map(
    (v: { accountRoot: string; outputs: Record<string, string> }) => {
      const root = fromHex(v.accountRoot),
        roots = purposes.map(p => hkdf(root, p))
      for (const r of roots) assert.equal(r.output_hex, v.outputs[r.purpose])
      const leaves = (
        ['auth', 'main', 'funding', 'change', 'message', 'stamp'] as const
      ).flatMap(role =>
        (role === 'auth' || role === 'main'
          ? ['0']
          : role === 'funding' || role === 'change'
          ? ['0', '1', '2147483647']
          : ['0', '1', '2', '2147483647']
        ).map(g => leaf(root, role, g)),
      )
      assert.equal(
        new Set(leaves.map(l => l.public_hex.slice(2))).size,
        leaves.length,
      )
      return {
        account_root: v.accountRoot,
        roots,
        leaves,
        snapshots: snapshots(leaves),
      }
    },
  )
  const frozen = [
    'packages/domain-roots/src/index.ts',
    'packages/domain-roots/vectors/domain-roots-v1.json',
    'packages/wallet/monad-identity.ts',
    'packages/wallet/monad-wallet-material.ts',
    'packages/wallet/monad-hd-keyring.ts',
    'packages/wallet/monad-change-keyring.ts',
    'packages/wallet/chain/monad-domain-wallet.jest.test.ts',
    'docs/protocol/proposals/suite1-directory/README.md',
  ].map(path => ({ path, sha256: sha(readFileSync(resolve(ROOT, path))) }))
  return {
    format: 'message-stamp-derivation-proposal-v1',
    status: 'PROPOSED-NOT-ALLOCATED',
    base_commit: 'd11773555cdfccf1bd811654da819176e4803baf',
    registry: REGISTRY,
    recovery: 'codex32-master-v1',
    network: 'monad-testnet',
    alternate_network: 'monad-mainnet',
    accounts,
    generation_cases: [
      ...['0', '1', '2147483647'].map(value => ({ value, expected: 'accept' })),
      ...[
        '2147483648',
        '4294967295',
        '9007199254740993',
        '18446744073709551615',
        '18446744073709551616',
        '-1',
        '01',
        '1.0',
        '',
        '1e2',
      ].map(value => ({ value, expected: 'reject' })),
      { value: 1, expected: 'reject' },
      { value: null, expected: 'reject' },
    ],
    scalar_cases: [
      {
        id: 'master-zero',
        operation: 'master',
        left_hex: hex(scalar(0n)),
        expected: 'master-scalar',
      },
      {
        id: 'master-order',
        operation: 'master',
        left_hex: hex(scalar(N)),
        expected: 'master-scalar',
      },
      {
        id: 'child-order',
        operation: 'child',
        left_hex: hex(scalar(N)),
        expected: 'child-scalar',
      },
      {
        id: 'child-zero-sum',
        operation: 'child',
        left_hex: hex(scalar(N - 1n)),
        expected: 'child-zero',
      },
      {
        id: 'child-zero-tweak-valid',
        operation: 'child',
        left_hex: hex(scalar(0n)),
        expected: 'accept',
      },
    ],
    reuse_cases: [
      {
        candidate: 'message-1',
        history: ['auth-0', 'message-0', 'stamp-0'],
        negate: false,
        expected: 'accept',
      },
      {
        candidate: 'message-0',
        history: ['auth-0', 'message-0', 'stamp-0'],
        negate: false,
        expected: 'reject',
      },
      {
        candidate: 'message-0',
        history: ['auth-0', 'message-0', 'stamp-0'],
        negate: true,
        expected: 'reject',
      },
      {
        candidate: 'stamp-0',
        history: ['auth-0', 'message-0', 'stamp-0'],
        negate: false,
        expected: 'reject',
      },
    ],
    restore_cases: cases(),
    frozen_sha256: frozen,
  }
}
type Corpus = ReturnType<typeof generate>
function restoreCase(corpus: Corpus, c: RestoreCase): string {
  const account = corpus.accounts[c.account],
    snap = account.snapshots[c.snapshot]
  let root = fromHex(account.account_root),
    registry = REGISTRY,
    recovery = 'codex32-master-v1',
    network = corpus.network
  let registryCode = 1,
    recoveryCode = 1,
    messageCode = 4,
    stampCode = 2
  let interpretation = 'bip32-secp256k1-master-seed'
  let mg: unknown = snap.message_generation,
    sg: unknown = snap.stamp_generation
  let mp = profile('message'),
    sp = profile('stamp'),
    mpoint = snap.message,
    spoint = snap.stamp,
    previous = snap.previous_stamp
  let mpath = pathFor('message', mg),
    spath = pathFor('stamp', sg),
    commitment = snap.t1
  switch (c.mutation) {
    case 'registry':
      registry = 'frank-domain-roots-v2'
      break
    case 'registry-code':
      registryCode = 2
      break
    case 'recovery-code':
      recoveryCode = 2
      break
    case 'message-purpose-code':
      messageCode = 5
      break
    case 'stamp-purpose-code':
      stampCode = 4
      break
    case 'interpretation':
      interpretation = 'ed25519-keypair-seed'
      break
    case 'seed-length':
      root = root.subarray(1)
      break
    case 'recovery':
      recovery = 'codex32-master-v2'
      break
    case 'purpose':
      mp = 'identity-authentication'
      break
    case 'stamp-purpose':
      sp = 'messaging-encryption'
      break
    case 'auth-as-message':
      mpoint = snap.auth
      break
    case 'evm-as-message':
      mpoint = account.leaves.find((l: Leaf) => l.id === 'main-0')!.public_hex
      break
    case 'stamp-as-message':
      mpoint = snap.stamp
      break
    case 'funding-as-stamp':
      spoint = account.leaves.find(
        (l: Leaf) => l.id === 'funding-0',
      )!.public_hex
      break
    case 'negated-message':
      mpoint = (mpoint.startsWith('02') ? '03' : '02') + mpoint.slice(2)
      break
    case 'nonhardened-message':
      mpath = mpath.slice(0, -1)
      break
    case 'nonhardened-stamp':
      spath = spath.slice(0, -1)
      break
    case 'wrong-account':
      root = fromHex(corpus.accounts[1].account_root)
      break
    case 'missing-generation':
      mg = null
      break
    case 'missing-stamp-generation':
      sg = null
      break
    case 'wrong-message-generation':
      mg = '1'
      break
    case 'wrong-stamp-generation':
      sg = '1'
      break
    case 'overflow-generation':
      sg = '2147483648'
      break
    case 'missing-previous':
      previous = null
      break
    case 'wrong-previous':
      previous = snap.stamp
      break
    case 'wrong-current':
      spoint = snap.previous_stamp!
      break
    case 'network':
      network = corpus.alternate_network
      break
    case 'head-lost':
      return 'reject'
    case 't1':
      commitment = '00'.repeat(32)
      break
  }
  try {
    if (
      registry !== REGISTRY ||
      recovery !== 'codex32-master-v1' ||
      registryCode !== 1 ||
      recoveryCode !== 1 ||
      messageCode !== 4 ||
      stampCode !== 2 ||
      interpretation !== 'bip32-secp256k1-master-seed' ||
      root.length !== 32 ||
      network !== corpus.network ||
      mp !== 'messaging-encryption' ||
      sp !== 'evm-wallet'
    )
      return 'reject'
    if (
      commitment !==
      sha(
        commonTranscript(
          'frank/content-hash/v1',
          network,
          fromHex(snap.type4_hex),
        ),
      )
    )
      return 'reject'
    if (mpath !== pathFor('message', mg) || spath !== pathFor('stamp', sg))
      return 'reject'
    if (
      leaf(root, 'auth', '0').public_hex !== snap.auth ||
      leaf(root, 'message', String(mg)).public_hex !== mpoint ||
      leaf(root, 'stamp', String(sg)).public_hex !== spoint
    )
      return 'reject'
    if (new Set([snap.auth, mpoint, spoint].map(p => p.slice(2))).size !== 3)
      return 'reject'
    if (c.mutation === 'pair-lost') previous = null
    else {
      const pg = snap.previous_stamp_generation
      if (
        pg === null
          ? previous !== null
          : previous !== leaf(root, 'stamp', pg).public_hex
      )
        return 'reject'
      if (
        generation(sg) === 0n
          ? pg !== null
          : pg === null || generation(pg) + 1n !== generation(sg)
      )
        return 'reject'
    }
    if (c.operation === 'restore')
      return c.mutation === 'pair-lost' ? 'current-only' : 'accept'
    const role = c.operation === 'stamp-admission' ? 'stamp' : 'message'
    const candidate = leaf(root, role, c.candidate_generation!).public_hex
    if (c.operation === 'archive')
      return account.snapshots.some((s: Snapshot) => s.message === candidate)
        ? 'archive-only'
        : 'reject'
    return (
      role === 'stamp'
        ? candidate === spoint || candidate === previous
        : candidate === mpoint
    )
      ? 'accept'
      : 'reject'
  } catch {
    return 'reject'
  }
}
function check(corpus: Corpus) {
  assert.deepEqual(corpus, generate(), 'checked-in exact vectors differ')
  for (const c of corpus.generation_cases) {
    let actual = 'accept'
    try {
      pathFor('message', c.value)
      pathFor('stamp', c.value)
    } catch {
      actual = 'reject'
    }
    assert.equal(actual, c.expected, `generation ${JSON.stringify(c.value)}`)
  }
  for (const c of corpus.scalar_cases) {
    for (const index of [0x80000000, 0xffffffff]) {
      let actual = 'accept'
      try {
        const injected = Buffer.concat([
          fromHex(c.left_hex),
          Buffer.alloc(32, 0x55),
        ])
        const node =
          c.operation === 'master'
            ? master(Buffer.alloc(32), injected)
            : child(
                { secret: scalar(1n), chain: Buffer.alloc(32) },
                index,
                injected,
              )
        assert.equal(hex(node.secret), hex(scalar(1n)))
        assert.equal(hex(node.chain), '55'.repeat(32))
      } catch (e) {
        actual = (e as Error).message
      }
      assert.equal(
        actual,
        c.expected,
        `${c.id}/${index}: no retry or index shift`,
      )
    }
  }
  for (const c of corpus.restore_cases)
    assert.equal(restoreCase(corpus, c), c.expected, c.id)
  for (const c of corpus.reuse_cases) {
    const get = (id: string): string =>
      corpus.accounts[0].leaves.find((l: Leaf) => l.id === id)!.public_hex
    let candidate = get(c.candidate)
    if (c.negate)
      candidate =
        (candidate.startsWith('02') ? '03' : '02') + candidate.slice(2)
    assert.equal(
      c.history.some(id => get(id).slice(2) === candidate.slice(2))
        ? 'reject'
        : 'accept',
      c.expected,
    )
  }
  // Frozen existing independent address KATs, copied from the reviewed wallet test.
  const addresses = [
    [
      '0xa3b72b83A95d61352E969D9f09DB4276295B4175',
      '0x4669EFf913A3c595CeA5FA92a600201e8e9E75d8',
      '0x5b2657B0E7A5b7582beDc9Ae1724ba61BeC67724',
      '0x3912fB0cE7495829590C67914166ecB586D8F598',
    ],
    [
      '0x8dc3750A7789544eB239029B1Eb0EaaDdEbdfe9d',
      '0x44403a53EbB81056E865Fd706fE9B64E0B780390',
      '0xBcF19B8C0495b9436c99d720b0A1fdcd587C3fB2',
      '0x7cf72fC477c43cA1aEAD13F92a3Ed0F32b33b280',
    ],
  ]
  corpus.accounts.forEach((a: Corpus['accounts'][number], i: number) =>
    ['auth-0', 'main-0', 'funding-0', 'change-0'].forEach((id, j) =>
      assert.equal(
        a.leaves.find((l: Leaf) => l.id === id)!.address,
        addresses[i][j],
      ),
    ),
  )
  console.log(
    `TS: 10 frozen roots; 32 exact leaves; 8 exact directory tuples; ${
      corpus.generation_cases.length
    } bounds; ${corpus.scalar_cases.length * 2} scalar probes; ${
      corpus.restore_cases.length
    } restore/admission cases; ${
      corpus.reuse_cases.length
    } no-reuse cases; 8 existing address KATs`,
  )
}
if (process.argv.includes('--emit'))
  console.log(JSON.stringify(generate(), null, 2))
else check(JSON.parse(readFileSync(FILE, 'utf8')))
