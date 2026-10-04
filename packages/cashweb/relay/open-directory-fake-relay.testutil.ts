/**
 * Test stand-in for a relay's open directory surface (see the shared interface notes):
 *
 *   GET /relay/v1/info
 *   PUT /directory/v1/{network}/{P}/head
 *   GET /directory/v1/{network}/{P}/head
 *   GET /directory/v1/{network}/{P}/statements/{t1}
 *   GET /directory/v1/{network}/address/{0x-address}
 *
 * It accepts an entry for any well-formed key, pins that key's first revision zero, requires later
 * revisions to chain from the stored head, and answers 409 to a second revision zero. It verifies
 * signatures with the real codec. `tamper` lets a test make it lie.
 */
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  cborMap,
  directorySignatureDigest,
  encodeFrame,
  fromHex,
  toHex,
  verifyPreviewDirectoryEvidence,
  type RelayBinding,
  type Timestamp,
} from '@frank/codec'
import type { DirectoryFetch, DirectoryResponse } from './directory-client'
import { directoryAddress } from './open-directory'

const MEDIA = 'application/vnd.frank.cbor'

export interface FakeRelayOptions {
  network?: string
  endpoint?: string
  /** Unix nanoseconds; defaults to far in the future. */
  bindingExpiryNs?: bigint
  relayId?: string
}
export interface FakeRelay {
  readonly endpoint: string
  readonly network: string
  readonly binding: RelayBinding
  readonly fetch: DirectoryFetch
  /** Every request seen, in order. */
  readonly requests: { method: string; path: string }[]
  /** Every key this relay holds an entry for. */
  subjects(): IterableIterator<string>
  /** Stored attestation chain of a key, oldest first. */
  chain(subject: string): Uint8Array[]
  /** Store a chain directly, as replication from another relay would. */
  replicate(attestations: readonly Uint8Array[]): void
  /** While set, every request fails as if the relay were unreachable. */
  down: boolean
  /** Replace what a GET returns: `path` is everything after the origin. */
  tamper?: (path: string) => Uint8Array | 404 | undefined
  /** Peers asked for an address or key this relay does not hold. */
  peers: FakeRelay[]
}

const time = (t: Timestamp) =>
  cborMap([
    [0, t.seconds],
    [1, t.nanoseconds],
  ])
const account = (key: Uint8Array) =>
  cborMap([
    [0, 1],
    [1, key],
  ])

/** A throwaway account with its own signing, message and stamp keys, for tests only. */
export function testAccount(seed: number) {
  const scalar = (n: number) => fromHex(n.toString(16).padStart(64, '0'))
  const auth = scalar(seed * 3 + 1),
    message = scalar(seed * 3 + 2),
    stamp = scalar(seed * 3 + 3)
  const subject = toHex(secp256k1.getPublicKey(auth, true))
  return {
    subject,
    address: directoryAddress(subject)!,
    /** Sign one revision of this account's entry (or, with `signer`, forge one). */
    sign(input: {
      network: string
      revision: bigint
      predecessor: Uint8Array | null
      issuedAt: Timestamp
      expiresAt: Timestamp
      relay: RelayBinding
      /** Claim to be this key while signing with this account's key. */
      claimSubject?: string
    }): Uint8Array {
      const claimed = input.claimSubject
        ? fromHex(input.claimSubject)
        : secp256k1.getPublicKey(auth, true)
      const statement = encodeFrame(
        { typeId: 4, schemaVersion: 4, minReaderVersion: 4 },
        cborMap([
          [0, input.network],
          [1, account(claimed)],
          [2, input.revision],
          [3, time(input.issuedAt)],
          [
            4,
            [
              cborMap([
                [0, input.relay.relayId],
                [1, input.relay.endpoint],
                [2, account(input.relay.identity.keyBytes)],
                [3, time(input.relay.expiry)],
              ]),
            ],
          ],
          [6, time(input.expiresAt)],
          [8, account(secp256k1.getPublicKey(stamp, true))],
          [10, account(secp256k1.getPublicKey(message, true))],
          [11, 0],
          [12, 0],
          [13, input.predecessor],
        ]),
      )
      const signature = secp256k1
        .sign(directorySignatureDigest(input.network, statement), auth, {
          lowS: true,
        })
        .toDERRawBytes()
      return encodeFrame(
        { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
        cborMap([
          [0, statement],
          [
            1,
            [
              cborMap([
                [0, 1],
                [1, account(secp256k1.getPublicKey(auth, true))],
                [2, signature],
              ]),
            ],
          ],
        ]),
      )
    },
  }
}

function answer(
  url: string,
  status: number,
  body?: Uint8Array,
  headers: Record<string, string> = {},
): DirectoryResponse {
  let read = false
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return {
    status,
    url,
    headers: { get: name => lower[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          read || !body
            ? { done: true }
            : ((read = true), { done: false, value: body }),
        cancel: async () => undefined,
      }),
    },
  }
}

export function createFakeRelay(options: FakeRelayOptions = {}): FakeRelay {
  const network = options.network ?? 'monad-testnet'
  const endpoint = options.endpoint ?? 'https://relay-a.example'
  const expiryNs = options.bindingExpiryNs ?? 4_000_000_000n * 1_000_000_000n
  const relayKey = toHex(secp256k1.getPublicKey(fromHex('77'.repeat(32)), true))
  const relayId = options.relayId ?? '0a'.repeat(16)
  const binding: RelayBinding = {
    relayId: fromHex(relayId),
    endpoint,
    identity: { keyType: 1, keyBytes: fromHex(relayKey) },
    expiry: {
      seconds: expiryNs / 1_000_000_000n,
      nanoseconds: Number(expiryNs % 1_000_000_000n),
    },
    unknownFields: new Map(),
  }
  const chains = new Map<string, { hash: string; bytes: Uint8Array }[]>()
  const parse = (bytes: Uint8Array) => {
    const verified = verifyPreviewDirectoryEvidence(bytes, network)
    return {
      subject: toHex(verified.statement.subject.keyBytes),
      revision: verified.statement.revision,
      hash: toHex(verified.statementHash),
      predecessor: verified.statement.preview.predecessor,
    }
  }
  const head = (bytes: Uint8Array, url: string, subject: string) =>
    answer(url, 200, bytes, {
      'content-type': MEDIA,
      'x-frank-directory-evidence': 'fresh-current',
      'x-frank-directory-subject': subject,
    })
  const relay: FakeRelay = {
    endpoint,
    network,
    binding,
    requests: [],
    down: false,
    peers: [],
    chain: subject => (chains.get(subject) ?? []).map(row => row.bytes),
    replicate(attestations) {
      for (const bytes of attestations) {
        const entry = parse(bytes)
        const chain = chains.get(entry.subject) ?? []
        if (!chain.some(row => row.hash === entry.hash))
          chain.push({ hash: entry.hash, bytes: bytes.slice() })
        chains.set(entry.subject, chain)
      }
    },
    fetch: async (url, init) => {
      if (relay.down) throw new Error('relay unreachable')
      if (!url.startsWith(endpoint + '/'))
        throw new Error(`request for another origin: ${url}`)
      const path = url.slice(endpoint.length)
      relay.requests.push({ method: init.method, path })
      if (init.method === 'GET') {
        const forged = relay.tamper?.(path)
        if (forged === 404) return answer(url, 404)
        if (forged)
          return answer(url, 200, forged, {
            'content-type': MEDIA,
            'x-frank-directory-evidence': path.includes('/statements/')
              ? 'historical'
              : 'fresh-current',
          })
      }
      if (path === '/relay/v1/info' && init.method === 'GET')
        return answer(
          url,
          200,
          new TextEncoder().encode(
            JSON.stringify({
              network,
              relayId,
              endpoint,
              relayKey,
              bindingExpiry: expiryNs.toString(),
            }),
          ),
          { 'content-type': 'application/json' },
        )
      const prefix = `/directory/v1/${network}/`
      if (!path.startsWith(prefix)) return answer(url, 404)
      const parts = path.slice(prefix.length).split('/')
      const everywhere = [relay, ...relay.peers]
      if (
        parts[0] === 'address' &&
        parts.length === 2 &&
        init.method === 'GET'
      ) {
        for (const source of everywhere)
          for (const subject of [...source.subjects()])
            if (directoryAddress(subject) === parts[1].toLowerCase()) {
              const chain = source.chain(subject)
              // Asking a peer also brings the entry (and its history) here.
              if (source !== relay) relay.replicate(chain)
              return head(chain[chain.length - 1], url, subject)
            }
        return answer(url, 404)
      }
      const subject = parts[0]
      if (parts[1] === 'head' && parts.length === 2 && init.method === 'GET') {
        const chain = chains.get(subject)
        return chain?.length
          ? head(chain[chain.length - 1].bytes, url, subject)
          : answer(url, 404)
      }
      if (
        parts[1] === 'statements' &&
        parts.length === 3 &&
        init.method === 'GET'
      ) {
        const row = chains.get(subject)?.find(r => r.hash === parts[2])
        return row
          ? answer(url, 200, row.bytes, {
              'content-type': MEDIA,
              'x-frank-directory-evidence': 'historical',
            })
          : answer(url, 404)
      }
      if (parts[1] === 'head' && parts.length === 2 && init.method === 'PUT') {
        const bytes = new Uint8Array(init.body!)
        let entry
        try {
          entry = parse(bytes)
        } catch {
          return answer(url, 422)
        }
        if (entry.subject !== subject) return answer(url, 422)
        const chain = chains.get(subject) ?? []
        const last = chain[chain.length - 1]
        if (chain.some(row => row.hash === entry.hash))
          return head(last.bytes, url, subject)
        if (!last) {
          if (entry.revision !== 0n) return answer(url, 409)
        } else if (
          entry.revision === 0n ||
          !entry.predecessor ||
          toHex(entry.predecessor) !== last.hash
        )
          return answer(url, 409)
        chain.push({ hash: entry.hash, bytes })
        chains.set(subject, chain)
        return head(bytes, url, subject)
      }
      return answer(url, 404)
    },
    subjects: () => chains.keys(),
  }
  return relay
}
