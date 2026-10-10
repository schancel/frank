import { createHash } from 'crypto'
import __pb_signed_payload_payload_pb from '../signed_payload/payload_pb'
import {
  UsernameError,
  buildUsernameClaim,
  claimUsername,
  lookupUsername,
  searchUsernames,
  tidyUsername,
  usernamesOfAddresses,
  type UsernameSigner,
} from './username-client'

const { SignedPayload } = __pb_signed_payload_payload_pb

const RELAY = 'http://relay.test'
const ADDRESS = '0x' + 'ab'.repeat(20)
const SUBJECT = '02' + 'cd'.repeat(32)

function signer(): UsernameSigner & { signed: Buffer[] } {
  const signed: Buffer[] = []
  return {
    compressedPubKey: Uint8Array.from(Buffer.from(SUBJECT, 'hex')),
    signHash: hash => {
      signed.push(Buffer.from(hash))
      return Uint8Array.from([0x30, 0x02, 0x01, 0x01])
    },
    signed,
  }
}

interface Call {
  url: string
  method: string
  headers?: Record<string, string>
  body?: Uint8Array
}

/** A relay that answers every request with `status` and `body`, recording what it was sent. */
function relay(status: number, body: unknown) {
  const calls: Call[] = []
  const fetch = async (
    url: string,
    init?: {
      method?: string
      headers?: Record<string, string>
      body?: Uint8Array
    },
  ) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    })
    return { status, ok: status === 200, json: async () => body }
  }
  return { calls, fetch }
}

const user = (username: string, extra: object = {}) => ({
  username,
  address: ADDRESS,
  account_address: ADDRESS,
  subject: SUBJECT,
  status: 'active',
  entry: null,
  ...extra,
})

describe('tidyUsername', () => {
  it('trims, drops one leading @ and lower-cases', () => {
    expect(tidyUsername('  @Alice_01 ')).toBe('alice_01')
    expect(tidyUsername('bob')).toBe('bob')
    expect(tidyUsername('@@x')).toBe('@x')
  })
})

describe('buildUsernameClaim', () => {
  it('wraps the four claim lines in a SignedPayload signed over their SHA-256', () => {
    const key = signer()
    const bytes = buildUsernameClaim(key, {
      network: 'monad-testnet',
      username: 'alice',
      issuedMs: 1_800_000_000_000,
    })
    const decoded = SignedPayload.deserializeBinary(bytes)
    const payload = Buffer.from(decoded.getPayload_asU8())
    expect(payload.toString('utf8')).toBe(
      'frank-username-claim-v1\nmonad-testnet\nalice\n1800000000000',
    )
    const digest = createHash('sha256').update(payload).digest()
    expect(Buffer.from(decoded.getPayloadDigest_asU8())).toEqual(digest)
    expect(key.signed).toEqual([digest])
    expect(Buffer.from(decoded.getPublicKey_asU8()).toString('hex')).toBe(
      SUBJECT,
    )
    expect(decoded.getScheme()).toBe(SignedPayload.SignatureScheme.ECDSA)
    expect(Array.from(decoded.getSignature_asU8())).toEqual([0x30, 2, 1, 1])
    expect(decoded.getTransactionsList()).toEqual([])
  })
})

describe('claimUsername', () => {
  it('PUTs the signed claim for the tidied name and returns the holder', async () => {
    const { calls, fetch } = relay(200, user('alice'))
    const entry = await claimUsername({
      relayBaseUrl: RELAY + '/',
      network: 'monad-testnet',
      signer: signer(),
      username: ' @Alice ',
      nowMs: 42,
      fetch,
    })
    expect(entry).toEqual({
      username: 'alice',
      address: ADDRESS,
      subject: SUBJECT,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${RELAY}/directory/user/alice`)
    expect(calls[0].method).toBe('PUT')
    const sent = SignedPayload.deserializeBinary(calls[0].body!)
    expect(Buffer.from(sent.getPayload_asU8()).toString('utf8')).toBe(
      'frank-username-claim-v1\nmonad-testnet\nalice\n42',
    )
  })

  it.each([
    [409, 'taken'],
    [400, 'invalid-username'],
    [400, 'invalid-claim'],
    [409, 'stale-claim'],
    [409, 'not-published'],
  ] as const)('reports a %i %s refusal by its code', async (status, code) => {
    const { fetch } = relay(status, { error: code, message: 'because' })
    const failure = await claimUsername({
      relayBaseUrl: RELAY,
      network: 'monad-testnet',
      signer: signer(),
      username: 'alice',
      fetch,
    }).catch(error => error)
    expect(failure).toBeInstanceOf(UsernameError)
    expect(failure.code).toBe(code)
    expect(failure.detail).toBe('because')
    expect(failure.status).toBe(status)
  })

  it('does not sign or send a name with characters no relay accepts', async () => {
    const { calls, fetch } = relay(200, user('x'))
    const key = signer()
    for (const username of ['', '  ', 'al ice', 'a/b', 'ünï']) {
      await expect(
        claimUsername({
          relayBaseUrl: RELAY,
          network: 'monad-testnet',
          signer: key,
          username,
          fetch,
        }),
      ).rejects.toMatchObject({ code: 'invalid-username' })
    }
    expect(calls).toEqual([])
    expect(key.signed).toEqual([])
  })

  it('reports an unreachable relay, an unknown answer and a malformed success as unreachable', async () => {
    const attempt = (fetch: Parameters<typeof claimUsername>[0]['fetch']) =>
      claimUsername({
        relayBaseUrl: RELAY,
        network: 'monad-testnet',
        signer: signer(),
        username: 'alice',
        fetch,
      })
    await expect(
      attempt(async () => {
        throw new Error('offline')
      }),
    ).rejects.toMatchObject({ code: 'unreachable' })
    await expect(
      attempt(relay(500, { error: 'storage' }).fetch),
    ).rejects.toMatchObject({ code: 'unreachable', status: 500 })
    await expect(
      attempt(relay(200, { username: 'alice' }).fetch),
    ).rejects.toMatchObject({ code: 'unreachable' })
  })
})

describe('lookupUsername', () => {
  it('returns the holder with its profile bytes', async () => {
    const { calls, fetch } = relay(
      200,
      user('alice', {
        entry: { content_type: 'application/cbor', raw_hex: '0102ff' },
      }),
    )
    const entry = await lookupUsername({
      relayBaseUrl: RELAY,
      username: '@ALICE',
      fetch,
    })
    expect(calls[0]).toMatchObject({
      url: `${RELAY}/directory/user/alice`,
      method: 'GET',
    })
    expect(entry).toEqual({
      username: 'alice',
      address: ADDRESS,
      subject: SUBJECT,
      profile: Uint8Array.from([1, 2, 255]),
    })
  })

  it('is undefined for a name nobody holds or that is not a name', async () => {
    expect(
      await lookupUsername({
        relayBaseUrl: RELAY,
        username: 'nobody',
        fetch: relay(404, { error: 'not-found' }).fetch,
      }),
    ).toBeUndefined()
    expect(
      await lookupUsername({
        relayBaseUrl: RELAY,
        username: 'ab',
        fetch: relay(400, { error: 'invalid-username' }).fetch,
      }),
    ).toBeUndefined()
    const { calls, fetch } = relay(200, user('x'))
    expect(
      await lookupUsername({
        relayBaseUrl: RELAY,
        username: 'not a name',
        fetch,
      }),
    ).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('throws when the relay fails', async () => {
    await expect(
      lookupUsername({
        relayBaseUrl: RELAY,
        username: 'alice',
        fetch: relay(500, {}).fetch,
      }),
    ).rejects.toMatchObject({ code: 'unreachable' })
  })
})

describe('searchUsernames and usernamesOfAddresses', () => {
  it('asks for a tidied prefix and returns well-formed entries only', async () => {
    const { calls, fetch } = relay(200, {
      users: [user('alice'), { username: 'broken' }, user('alicia')],
    })
    const found = await searchUsernames({
      relayBaseUrl: RELAY,
      prefix: '@Ali',
      limit: 5,
      fetch,
    })
    expect(calls[0].url).toBe(`${RELAY}/directory/users?prefix=ali&limit=5`)
    expect(found.map(entry => entry.username)).toEqual(['alice', 'alicia'])
  })

  it('answers a prefix no name can start with without asking', async () => {
    const { calls, fetch } = relay(200, { users: [] })
    expect(
      await searchUsernames({
        relayBaseUrl: RELAY,
        prefix: 'John Smith',
        fetch,
      }),
    ).toEqual([])
    expect(calls).toEqual([])
  })

  it('asks for the names of distinct valid addresses', async () => {
    const { calls, fetch } = relay(200, { users: [user('alice')] })
    const other = '0x' + '11'.repeat(20)
    const found = await usernamesOfAddresses({
      relayBaseUrl: RELAY,
      addresses: [
        ADDRESS.toUpperCase().replace('0X', '0x'),
        ADDRESS,
        'junk',
        other,
      ],
      fetch,
    })
    expect(calls[0].url).toBe(
      `${RELAY}/directory/users?addresses=${ADDRESS},${other}`,
    )
    expect(found).toEqual([
      { username: 'alice', address: ADDRESS, subject: SUBJECT },
    ])
    expect(
      await usernamesOfAddresses({
        relayBaseUrl: RELAY,
        addresses: ['junk'],
        fetch,
      }),
    ).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('throws when the relay answers with something else', async () => {
    await expect(
      searchUsernames({
        relayBaseUrl: RELAY,
        prefix: 'ali',
        fetch: relay(200, { nope: true }).fetch,
      }),
    ).rejects.toBeInstanceOf(UsernameError)
  })
})
