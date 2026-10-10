/**
 * Usernames on a relay: claim one for your own key, look one up, search by prefix.
 *
 * A name points to exactly one account key, and the relay only gives a name to a key that has
 * published its directory entry there, so whoever a name resolves to can be messaged.
 *
 * A claim is a `SignedPayload` (the envelope profiles use) around four lines of text, signed by
 * the key the name will point to. The relay is the authority on what a valid name is and on who
 * holds it; this client only tidies input (trim, drop a leading `@`, lower-case) before signing.
 */
import { sha256 } from '@frank/crypto-box'
import __pb_signed_payload_payload_pb from '../signed_payload/payload_pb'

const { SignedPayload } = __pb_signed_payload_payload_pb

const CLAIM_DOMAIN = 'frank-username-claim-v1'
const REQUEST_DEADLINE_MS = 30_000

/** The identity key a name will point to. `MonadIdentity` satisfies this. */
export interface UsernameSigner {
  /** Compressed (33-byte) secp256k1 public key. */
  readonly compressedPubKey: Uint8Array
  /** DER ECDSA signature over a 32-byte digest. */
  signHash(hash: Buffer): Uint8Array
}

/** One name and the account holding it, as the relay reports it. */
export interface UsernameEntry {
  username: string
  /** Lower-case 0x address of the holder. */
  address: string
  /** The holder's compressed key, hex: the subject of its directory entry. */
  subject: string
  /** The holder's published profile bytes (display name, avatar), when it has one. */
  profile?: Uint8Array
}

export type UsernameErrorCode =
  /** Another account holds this name. */
  | 'taken'
  /** Not 3 to 32 of a-z, 0-9, hyphen, underscore, starting with a letter or digit. */
  | 'invalid-username'
  /** The relay refused the signed claim itself (wrong network, bad signature, clock). */
  | 'invalid-claim'
  /** This account has since claimed another name with a later claim. */
  | 'stale-claim'
  /** This account has no directory entry on the relay yet. */
  | 'not-published'
  /** The relay could not be reached or answered with something unexpected. */
  | 'unreachable'

const MESSAGES: Record<UsernameErrorCode, string> = {
  'taken': 'That username is already taken.',
  'invalid-username':
    'Usernames are 3 to 32 letters, digits, hyphens or underscores, starting with a letter or digit.',
  'invalid-claim': 'The relay did not accept the signed username request.',
  'stale-claim':
    'A newer username request from this account was already accepted.',
  'not-published':
    'This account is not published on the relay yet. Try again once messaging is on.',
  'unreachable': 'The relay could not be reached to set the username.',
}

export class UsernameError extends Error {
  constructor(
    readonly code: UsernameErrorCode,
    /** The relay's own explanation, when it gave one. */
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(MESSAGES[code])
    this.name = 'UsernameError'
  }
}

type Fetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: Uint8Array
    signal?: AbortSignal
  },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>

const globalFetch: Fetch = (url, init) =>
  (globalThis as unknown as { fetch: Fetch }).fetch(url, init)

/** Trim, drop one leading `@`, lower-case. The relay decides whether the result is valid. */
export function tidyUsername(raw: string): string {
  const trimmed = raw.trim()
  return (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).toLowerCase()
}

/** The signed claim for `username` (already tidied) on `network`, e.g. `monad-testnet`. */
export function buildUsernameClaim(
  signer: UsernameSigner,
  claim: { network: string; username: string; issuedMs: number },
): Uint8Array {
  // Copied into this realm's Uint8Array: the hash backend refuses any other kind.
  const payload = Uint8Array.from(
    new TextEncoder().encode(
      [
        CLAIM_DOMAIN,
        claim.network,
        claim.username,
        String(claim.issuedMs),
      ].join('\n'),
    ),
  )
  const digest = sha256(payload)
  const signed = new SignedPayload()
  signed.setPublicKey(Uint8Array.from(signer.compressedPubKey))
  signed.setPayload(payload)
  signed.setPayloadDigest(digest)
  signed.setScheme(SignedPayload.SignatureScheme.ECDSA)
  signed.setBurnAmount(0)
  signed.setTransactionsList([])
  signed.setSignature(Uint8Array.from(signer.signHash(Buffer.from(digest))))
  return signed.serializeBinary()
}

function entryOf(value: unknown): UsernameEntry | undefined {
  const user = value as {
    username?: unknown
    address?: unknown
    subject?: unknown
    entry?: { raw_hex?: unknown } | null
  } | null
  if (
    !user ||
    typeof user.username !== 'string' ||
    typeof user.address !== 'string' ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    typeof user.subject !== 'string'
  )
    return undefined
  const rawHex = user.entry?.raw_hex
  return {
    username: user.username,
    address: user.address,
    subject: user.subject,
    ...(typeof rawHex === 'string' && /^([0-9a-f]{2})+$/.test(rawHex)
      ? { profile: Uint8Array.from(Buffer.from(rawHex, 'hex')) }
      : {}),
  }
}

const CODES: readonly UsernameErrorCode[] = [
  'taken',
  'invalid-username',
  'invalid-claim',
  'stale-claim',
  'not-published',
]

async function request(
  fetch: Fetch,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: Uint8Array },
): Promise<{ status: number; body: unknown }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), REQUEST_DEADLINE_MS)
  try {
    const response = await fetch(url, {
      ...init,
      // A relay reached through an ngrok tunnel answers a browser with an interstitial page
      // unless this header is present (the relay's other clients send it too).
      headers: { 'ngrok-skip-browser-warning': '1', ...init.headers },
      signal: abort.signal,
    })
    const body = await response.json().catch(() => undefined)
    return { status: response.status, body }
  } catch {
    throw new UsernameError('unreachable')
  } finally {
    clearTimeout(timer)
  }
}

function refusal(status: number, body: unknown): UsernameError {
  const answer = body as { error?: unknown; message?: unknown } | undefined
  const code = CODES.find(known => known === answer?.error)
  return new UsernameError(
    code ?? 'unreachable',
    typeof answer?.message === 'string' ? answer.message : undefined,
    status,
  )
}

const base = (relayBaseUrl: string) => relayBaseUrl.replace(/\/+$/, '')

/**
 * Claim `username` for the signer's key. Resolves with the entry when the key holds the name
 * afterwards (claiming a name you already hold changes nothing). Claiming a different name
 * releases the one the key held. Throws `UsernameError`; `code === 'taken'` when another
 * account has it.
 */
export async function claimUsername(params: {
  relayBaseUrl: string
  /** Canonical network of the relay's directory, e.g. `monad-testnet`. */
  network: string
  signer: UsernameSigner
  username: string
  nowMs?: number
  fetch?: Fetch
}): Promise<UsernameEntry> {
  const username = tidyUsername(params.username)
  if (username === '' || /[^a-z0-9_-]/.test(username))
    throw new UsernameError('invalid-username')
  const body = buildUsernameClaim(params.signer, {
    network: params.network,
    username,
    issuedMs: params.nowMs ?? Date.now(),
  })
  const answer = await request(
    params.fetch ?? globalFetch,
    `${base(params.relayBaseUrl)}/directory/user/${username}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body,
    },
  )
  const entry = answer.status === 200 ? entryOf(answer.body) : undefined
  if (!entry) throw refusal(answer.status, answer.body)
  return entry
}

/** Who holds `username`, or `undefined` when nobody does (or it is not a valid name). */
export async function lookupUsername(params: {
  relayBaseUrl: string
  username: string
  fetch?: Fetch
}): Promise<UsernameEntry | undefined> {
  const username = tidyUsername(params.username)
  if (username === '' || /[^a-z0-9_-]/.test(username)) return undefined
  const answer = await request(
    params.fetch ?? globalFetch,
    `${base(params.relayBaseUrl)}/directory/user/${username}`,
    { method: 'GET' },
  )
  if (answer.status === 404 || answer.status === 400) return undefined
  const entry = answer.status === 200 ? entryOf(answer.body) : undefined
  if (!entry) throw refusal(answer.status, answer.body)
  return entry
}

async function list(
  fetch: Fetch | undefined,
  relayBaseUrl: string,
  query: string,
): Promise<UsernameEntry[]> {
  const answer = await request(
    fetch ?? globalFetch,
    `${base(relayBaseUrl)}/directory/users?${query}`,
    { method: 'GET' },
  )
  const users = (answer.body as { users?: unknown } | undefined)?.users
  if (answer.status !== 200 || !Array.isArray(users))
    throw refusal(answer.status, answer.body)
  return users.flatMap(user => entryOf(user) ?? [])
}

/** Names starting with `prefix`, in name order. The relay returns at most 100. */
export async function searchUsernames(params: {
  relayBaseUrl: string
  prefix: string
  limit?: number
  fetch?: Fetch
}): Promise<UsernameEntry[]> {
  const prefix = tidyUsername(params.prefix)
  if (/[^a-z0-9_-]/.test(prefix)) return []
  return list(
    params.fetch,
    params.relayBaseUrl,
    `prefix=${prefix}${
      params.limit === undefined ? '' : `&limit=${params.limit}`
    }`,
  )
}

/** The names the given addresses hold. Addresses without a name are simply absent. */
export async function usernamesOfAddresses(params: {
  relayBaseUrl: string
  addresses: readonly string[]
  fetch?: Fetch
}): Promise<UsernameEntry[]> {
  const addresses = [
    ...new Set(params.addresses.map(address => address.toLowerCase())),
  ].filter(address => /^0x[0-9a-f]{40}$/.test(address))
  if (addresses.length === 0) return []
  return list(
    params.fetch,
    params.relayBaseUrl,
    `addresses=${addresses.slice(0, 100).join(',')}`,
  )
}
