import { HDNodeWallet, computeAddress, keccak256, toUtf8Bytes } from 'ethers'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import { bip32MasterFromDomainRoot } from '../bip32-domain-root'
import { MONAD_IDENTITY_DERIVATION_PATH } from '../evm-identity'
import {
  CHANGE_DERIVATION_PATH_PREFIX,
  DERIVATION_PATH_PREFIX,
} from '../secp256k1-hd-keyring'
import {
  DAPP_PERSONA_ROOT_PATH,
  DAPP_PERSONA_SHARED_BRANCH,
  DAPP_PERSONA_SITE_BRANCH,
  canonicalDappPersonaOrigin,
  dappPersonaPath,
  deriveDappPersona,
  type DappPersonaRef,
} from './persona-keys'

/** A fresh, independent BIP-32 master per call, as a second frontend of the account would build. */
function evmMaster(vector: number): HDNodeWallet {
  const bytes = Buffer.from(
    vectors.vectors[vector].outputs['evm-wallet'],
    'hex',
  )
  return HDNodeWallet.fromSeed(new Uint8Array(bytes))
}

const SITES = [
  'https://app.uniswap.org',
  'https://opensea.io',
  'https://stake.monad.xyz',
  'http://localhost:5173',
  'chrome-extension://abcdefghijklmnop',
]

describe('dApp persona keys', () => {
  it('derives from the custody root, not from any public data (old formulas give other keys)', () => {
    const master = evmMaster(0)
    const shared = deriveDappPersona(master, { kind: 'shared', slot: 0 })
    const identityAddress = master.derivePath(
      MONAD_IDENTITY_DERIVATION_PATH,
    ).address
    // The removed derivations: keccak of a public address (plus index or origin).
    for (const address of [identityAddress, shared.address]) {
      const oldShared = keccak256(
        toUtf8Bytes(`frank-dapp-persona-v1:${address.toLowerCase()}:0`),
      )
      expect(oldShared).not.toBe(shared.node.privateKey)
      expect(computeAddress(oldShared)).not.toBe(shared.address)
      for (const origin of SITES) {
        const site = deriveDappPersona(master, { kind: 'site', origin })
        const oldBurner = keccak256(
          toUtf8Bytes(
            `frank-dapp-origin-burner-v1:${address.toLowerCase()}:${origin}`,
          ),
        )
        expect(oldBurner).not.toBe(site.node.privateKey)
        expect(computeAddress(oldBurner)).not.toBe(site.address)
      }
    }
  })

  it('uses only hardened derivation, so the public master cannot derive any persona', () => {
    const master = evmMaster(0)
    const refs: DappPersonaRef[] = [
      { kind: 'shared', slot: 0 },
      { kind: 'shared', slot: 7 },
      ...SITES.map(origin => ({ kind: 'site' as const, origin })),
    ]
    for (const ref of refs) {
      const path = dappPersonaPath(master, ref)
      const segments = path.split('/').slice(1)
      expect(segments.length).toBeGreaterThanOrEqual(4)
      for (const segment of segments) expect(segment).toMatch(/^\d+'$/)
      expect(() => master.neuter().derivePath(path)).toThrow()
    }
  })

  it('is deterministic for one account across independent instances', () => {
    const a = evmMaster(0)
    const b = evmMaster(0)
    // The production construction from the purpose-tagged domain root agrees too.
    const c = bip32MasterFromDomainRoot(
      {
        purpose: 'evm-wallet',
        bytes: new Uint8Array(
          Buffer.from(vectors.vectors[0].outputs['evm-wallet'], 'hex'),
        ),
      },
      'evm-wallet',
    )
    for (const ref of [
      { kind: 'shared', slot: 0 } as const,
      ...SITES.map(origin => ({ kind: 'site' as const, origin })),
    ]) {
      const address = deriveDappPersona(a, ref).address
      expect(deriveDappPersona(b, ref).address).toBe(address)
      expect(deriveDappPersona(c, ref).address).toBe(address)
    }
  })

  it('gives every site its own persona, and different accounts different personas', () => {
    const master = evmMaster(0)
    const other = evmMaster(1)
    const shared = deriveDappPersona(master, { kind: 'shared', slot: 0 }).address
    const seen = new Set<string>([shared])
    for (const origin of SITES) {
      const persona = deriveDappPersona(master, { kind: 'site', origin })
      expect(persona.path.startsWith(`${DAPP_PERSONA_SITE_BRANCH}/`)).toBe(true)
      expect(seen.has(persona.address)).toBe(false)
      seen.add(persona.address)
      expect(deriveDappPersona(other, { kind: 'site', origin }).address).not.toBe(
        persona.address,
      )
      // The per-site index itself is account-private: another account maps the site elsewhere.
      expect(dappPersonaPath(other, { kind: 'site', origin })).not.toBe(
        persona.path,
      )
    }
    expect(
      deriveDappPersona(other, { kind: 'shared', slot: 0 }).address,
    ).not.toBe(shared)
  })

  it('keys a site by its canonical origin and rejects origins with no persona', () => {
    const master = evmMaster(0)
    const canonical = deriveDappPersona(master, {
      kind: 'site',
      origin: 'https://app.uniswap.org',
    })
    for (const spelling of [
      'HTTPS://App.Uniswap.org',
      'https://app.uniswap.org/',
      'https://app.uniswap.org/swap?x=1',
      ' https://app.uniswap.org:443 ',
    ])
      expect(
        deriveDappPersona(master, { kind: 'site', origin: spelling }).address,
      ).toBe(canonical.address)
    expect(canonicalDappPersonaOrigin('https://app.uniswap.org:8443')).toBe(
      'https://app.uniswap.org:8443',
    )
    for (const bad of [
      '',
      'null',
      'wc://paired-dapp',
      'http://example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ])
      expect(() =>
        deriveDappPersona(master, { kind: 'site', origin: bad }),
      ).toThrow()
    expect(() =>
      deriveDappPersona(master, { kind: 'shared', slot: -1 }),
    ).toThrow()
    expect(() =>
      deriveDappPersona(master, { kind: 'shared', slot: 2 ** 31 }),
    ).toThrow()
    expect(() =>
      deriveDappPersona(master.derivePath("m/44'"), { kind: 'shared', slot: 0 }),
    ).toThrow(/master/)
  })

  it('collides with no identity, wallet, change, stamp or chain-adapter path or address', () => {
    expect(DAPP_PERSONA_ROOT_PATH).toBe("m/1785'/60'")
    expect(DAPP_PERSONA_SHARED_BRANCH.startsWith(DAPP_PERSONA_ROOT_PATH)).toBe(
      true,
    )
    const master = evmMaster(0)
    const rolePaths = [MONAD_IDENTITY_DERIVATION_PATH]
    for (let account = 0; account < 6; account += 1) {
      for (let i = 0; i < 8; i += 1) {
        rolePaths.push(`m/44'/60'/${account}'/0/${i}`)
        rolePaths.push(`m/44'/60'/${account}'/1/${i}`)
        rolePaths.push(`m/44'/60'/${account}'/0'/${i}'`)
      }
    }
    for (let i = 0; i < 32; i += 1) {
      rolePaths.push(`${DERIVATION_PATH_PREFIX}/${i}`)
      rolePaths.push(`${CHANGE_DERIVATION_PATH_PREFIX}/${i}`)
    }
    for (const path of rolePaths)
      expect(path.startsWith(`m/${DAPP_PERSONA_ROOT_PATH.split('/')[1]}`)).toBe(
        false,
      )
    const roleAddresses = new Set(
      rolePaths.map(path => master.derivePath(path).address),
    )
    for (let slot = 0; slot < 16; slot += 1)
      expect(
        roleAddresses.has(deriveDappPersona(master, { kind: 'shared', slot }).address),
      ).toBe(false)
    for (const origin of SITES)
      expect(
        roleAddresses.has(deriveDappPersona(master, { kind: 'site', origin }).address),
      ).toBe(false)
  })
})
