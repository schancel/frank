import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import bundleEntries from '../bundle-entries.json'
import pkg from '../package.json'
import runtime from '../runtime-deps.json'
import * as bchEntry from '../src/bch.js'
import * as btcEntry from '../src/btc.js'
import { isUnknownChainError } from '../src/chain/index.js'

const root = join(__dirname, '..')

function runScript(script: string, args: string[] = []): string {
  return execFileSync(
    process.execPath,
    [join(root, 'scripts', script), ...args],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
}

describe('runtime constraints', () => {
  test('the package is ESM, side-effect free, and split by entry', () => {
    expect(pkg.type).toBe('module')
    expect(pkg.sideEffects).toBe(false)
    expect(pkg.dependencies).toEqual({ '@noble/hashes': '1.8.0' })
    expect(Object.keys(pkg.exports).sort()).toEqual([
      '.',
      './address',
      './base32',
      './base58',
      './base58check',
      './bch',
      './bech32',
      './block',
      './btc',
      './cashaddr',
      './constructors',
      './convert-bits',
      './encoding-error',
      './hd',
      './integer',
      './keys',
      './reader',
      './script',
      './script-num',
      './sign',
      './transaction',
      './varint',
      './xec',
      './xpi',
    ])
    expect(runtime.allowed).toEqual(['@noble/hashes'])
    expect(runtime.optional).toEqual([])
    expect(runtime.planned).toEqual([
      '@noble/curves',
      '@scure/base',
      '@scure/bip32',
      '@scure/bip39',
    ])
    expect(runtime.plannedOptional).toEqual(['hash-wasm', 'tiny-secp256k1'])
    expect(bundleEntries.entries.map(entry => entry.name)).toEqual([
      'root',
      'btc',
      'bch',
      'xec',
      'xpi',
      'script-num',
      'integer',
      'base58',
      'base58check',
      'varint',
      'reader',
      'convert-bits',
      'base32',
      'encoding-error',
      'constructors',
      'bech32',
      'cashaddr',
      'address',
      'keys',
      'hd',
      'sign',
      'transaction',
      'script',
      'block',
    ])
  })

  test('a chain entry does not re-export another family', () => {
    expect(bchEntry).not.toHaveProperty('BTC_MAINNET')
    expect(bchEntry).not.toHaveProperty('XPI_MAINNET')
    expect(bchEntry).not.toHaveProperty('getChain')
    expect(btcEntry).not.toHaveProperty('BCH_MAINNET')
    expect(bchEntry.BCH_MAINNET.family).toBe('bch')
    expect(btcEntry.BTC_MAINNET.p2pMagic).toBe(0xf9beb4d9)
  })

  test('shared chain code does not carry another family magic', () => {
    const shared = readFileSync(join(root, 'src/chain/shared.ts'), 'utf8')
    const bch = readFileSync(join(root, 'src/chain/bch.ts'), 'utf8')
    expect(shared).not.toContain('0xf9beb4d9')
    expect(shared).not.toContain('10605')
    expect(bch).not.toContain('0xf9beb4d9')
    expect(bch).not.toContain('10605')
    expect(readFileSync(join(root, 'src/index.ts'), 'utf8')).not.toContain(
      'globalThis',
    )
  })

  test('unknown-chain checks the code field', () => {
    expect(
      isUnknownChainError({
        code: 'unknown-chain',
        family: 'btc',
        network: 'mainnet',
      }),
    ).toBe(true)
    expect(isUnknownChainError(new Error('unknown chain'))).toBe(false)
  })

  test('the shared-import check fails when a Node built-in is added', () => {
    expect(runScript('check-shared.mjs')).toContain('no Node built-ins')
    const dir = mkdtempSync(join(tmpdir(), 'nakamoto-shared-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src/bad.ts'),
      "import { createHash } from 'node:crypto'\nexport const n = 1\n",
    )
    expect(() => runScript('check-shared.mjs', ['--root', dir])).toThrow(
      /Node built-in/,
    )

    const backend = mkdtempSync(join(tmpdir(), 'nakamoto-backend-'))
    mkdirSync(join(backend, 'src/backend/node'), { recursive: true })
    writeFileSync(
      join(backend, 'src/backend/node/hash.ts'),
      "import { createHash } from 'node:crypto'\nexport const n = 1\n",
    )
    expect(runScript('check-shared.mjs', ['--root', backend])).toContain(
      'no Node built-ins',
    )
    writeFileSync(
      join(backend, 'src/leaf.ts'),
      "import { n } from './backend/node/hash.js'\nexport const value = n\n",
    )
    expect(() => runScript('check-shared.mjs', ['--root', backend])).toThrow(
      /Node backend/,
    )
  })

  test('the dependency check rejects bn.js and an early planned package', () => {
    expect(runScript('check-deps.mjs')).toContain('justified list')
    const dir = mkdtempSync(join(tmpdir(), 'nakamoto-deps-'))
    writeFileSync(
      join(dir, 'runtime-deps.json'),
      JSON.stringify({
        allowed: [],
        optional: [],
        planned: ['@noble/hashes'],
        plannedOptional: [],
      }),
    )
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'bad', dependencies: { 'bn.js': '4.11.8' } }),
    )
    expect(() => runScript('check-deps.mjs', ['--root', dir])).toThrow(/bn\.js/)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'early',
        devDependencies: { '@noble/hashes': '1.8.0' },
      }),
    )
    expect(() => runScript('check-deps.mjs', ['--root', dir])).toThrow(
      /installed early/,
    )
  })
})
