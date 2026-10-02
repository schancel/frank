import { readFileSync } from 'fs'
import { join } from 'path'

describe('hot-path benchmark harness', () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '../package.json'), 'utf8'),
  ) as { scripts: { bench: string; test: string } }
  const workflow = readFileSync(
    join(__dirname, '../../../.github/workflows/nakamoto.yml'),
    'utf8',
  )
  const script = readFileSync(
    join(__dirname, '../scripts/hot-path-bench.mjs'),
    'utf8',
  )
  const audit = readFileSync(
    join(__dirname, '../../../docs/nakamoto-audit.md'),
    'utf8',
  )

  test('full timing is a documented command and not a CI step', () => {
    expect(pkg.scripts.bench).toBe(
      'tsc -p tsconfig.json --pretty false && node scripts/hot-path-bench.mjs',
    )
    expect(pkg.scripts.test).toBe('jest')
    expect(pkg.scripts.test).not.toContain('bench')
    expect(workflow).not.toContain('hot-path-bench')
    expect(workflow).not.toContain('yarn bench')
    expect(script).toContain('docs/nakamoto-audit.md')
    expect(script).toContain('v26.8.2')
    expect(script).toContain('arm64')
    expect(script).toContain('darwin')
    expect(script).toContain('yarn workspace @frank/nakamoto bench')
    expect(script).toContain('SHA-256d of an 80-byte header')
    expect(script).toContain('RIPEMD-160 of 32 bytes')
    expect(script).toContain('HASH160 of 33 bytes')
    expect(script).toContain('HMAC-SHA256')
    expect(script).toContain('ECDSA sign')
    expect(script).toContain('ECDSA verify')
    expect(script).toContain('ECDH')
    expect(script).toContain('point add')
    expect(script).toContain('Base58-encode 21 bytes')
    expect(script).toContain('CashAddr polymod encode')
    expect(script).toContain('Merkle root of 2,048 txids')
    expect(script).toContain('HASH_ITERS = 20000')
    expect(script).toContain('SIGN_ITERS = 400')
    expect(script).toContain('MERKLE_ITERS = 200')
    expect(audit).toContain('Node `v26.8.2`, `arm64`, `darwin`')
    expect(audit).toContain('yarn workspace @frank/nakamoto bench')
    expect(audit).toContain('CI does not run it')
  })
})
