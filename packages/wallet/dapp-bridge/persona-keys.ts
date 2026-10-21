import { HDNodeWallet, getAddress, getBytes } from 'ethers'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { utf8ToBytes } from '@noble/hashes/utils'

/**
 * dApp persona key derivation.
 *
 * Every dApp persona key is a hardened BIP-32 child of the account's EVM BIP-32 master: the
 * `evm-wallet` domain root for Codex32 accounts, the BIP39 PBKDF2 seed for historical accounts.
 * Only custody can build that master, so a persona key is never computable from public data.
 *
 * The branch uses purpose `1785'`, which no other Frank role uses (identity, stamp pool,
 * change, keyring and chain-adapter paths all live under purposes 44', 84' and 86'):
 *
 *   m/1785'/60'/0'/<slot>'         shared persona slots; slot 0 is the default shared persona
 *   m/1785'/60'/1'                 site-index key: its private key keys the per-site HMAC
 *   m/1785'/60'/2'/<a>'/<b>'       per-site persona, (a, b) = HMAC-SHA256(site-index key,
 *                                  "frank/dapp-persona/site/v1" || 0x00 || canonical origin),
 *                                  first two big-endian u32 words with the top bit cleared
 *
 * Every frontend of the same account computes the same persona for a site without syncing,
 * and nobody without the account's secret can derive a key or link two sites' personas.
 */
export const DAPP_PERSONA_BIP32_PURPOSE = 1785 as const
export const DAPP_PERSONA_ROOT_PATH = "m/1785'/60'" as const
export const DAPP_PERSONA_SHARED_BRANCH = `${DAPP_PERSONA_ROOT_PATH}/0'` as const
export const DAPP_PERSONA_SITE_INDEX_KEY_PATH = `${DAPP_PERSONA_ROOT_PATH}/1'` as const
export const DAPP_PERSONA_SITE_BRANCH = `${DAPP_PERSONA_ROOT_PATH}/2'` as const

const SITE_INDEX_LABEL = 'frank/dapp-persona/site/v1'
const HARDENED_LIMIT = 0x8000_0000

/** Which persona: a shared slot, or the per-site persona for one canonical origin. */
export type DappPersonaRef =
  | { readonly kind: 'shared'; readonly slot: number }
  | { readonly kind: 'site'; readonly origin: string }

/**
 * The canonical origin that keys a per-site persona: `scheme://host[:port]`, lower case.
 * Only web (https, loopback http) and browser-extension origins have a site persona; any
 * other value is rejected rather than silently mapped to some persona.
 */
export function canonicalDappPersonaOrigin(rawOrigin: string): string {
  if (typeof rawOrigin !== 'string') throw new Error('dApp origin must be a string')
  let parsed: URL
  try {
    parsed = new URL(rawOrigin.trim())
  } catch {
    throw new Error(`Malformed dApp origin: ${rawOrigin}`)
  }
  const protocol = parsed.protocol.toLowerCase()
  const host = parsed.hostname.toLowerCase()
  if (!host) throw new Error(`dApp origin has no host: ${rawOrigin}`)
  if (protocol === 'https:') return parsed.origin.toLowerCase()
  if (
    protocol === 'http:' &&
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
  )
    return parsed.origin.toLowerCase()
  if (
    protocol === 'chrome-extension:' ||
    protocol === 'moz-extension:' ||
    protocol === 'safari-web-extension:'
  )
    return `${protocol}//${host}`
  throw new Error(`No dApp persona for origin scheme ${protocol}`)
}

function requireMaster(master: HDNodeWallet): void {
  if (!(master instanceof HDNodeWallet) || master.depth !== 0)
    throw new Error('dApp persona derivation needs the account BIP-32 master')
}

function requireSlot(slot: number): void {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= HARDENED_LIMIT)
    throw new Error(`Invalid dApp persona slot: ${String(slot)}`)
}

/** The hardened path of a persona; per-site paths need the account master for the HMAC key. */
export function dappPersonaPath(
  master: HDNodeWallet,
  ref: DappPersonaRef,
): string {
  requireMaster(master)
  if (ref.kind === 'shared') {
    requireSlot(ref.slot)
    return `${DAPP_PERSONA_SHARED_BRANCH}/${ref.slot}'`
  }
  if (ref.kind !== 'site') throw new Error('Unknown dApp persona kind')
  const origin = canonicalDappPersonaOrigin(ref.origin)
  const key = getBytes(
    master.derivePath(DAPP_PERSONA_SITE_INDEX_KEY_PATH).privateKey,
  )
  const message = new Uint8Array([
    ...utf8ToBytes(SITE_INDEX_LABEL),
    0,
    ...utf8ToBytes(origin),
  ])
  const digest = hmac(sha256, key, message)
  key.fill(0)
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  const a = view.getUint32(0) & 0x7fff_ffff
  const b = view.getUint32(4) & 0x7fff_ffff
  digest.fill(0)
  return `${DAPP_PERSONA_SITE_BRANCH}/${a}'/${b}'`
}

export interface DerivedDappPersona {
  readonly path: string
  readonly address: string
  /** Hardened child node holding the persona private key; keep it inside custody code. */
  readonly node: HDNodeWallet
}

/** Derives a persona key from the account's EVM BIP-32 master (custody-side only). */
export function deriveDappPersona(
  master: HDNodeWallet,
  ref: DappPersonaRef,
): DerivedDappPersona {
  const path = dappPersonaPath(master, ref)
  const node = master.derivePath(path)
  return Object.freeze({ path, address: getAddress(node.address), node })
}
