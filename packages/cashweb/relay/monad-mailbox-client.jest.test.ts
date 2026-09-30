/**
 * Tests for `monad-mailbox-client.ts` against `MockMailboxRelay`
 * (`./monad-mailbox-mock-relay.testutil.ts`), an in-process mock of the Rust relay's private
 * mailbox contract (HMAC challenges/cursors, signature verification over an independently built
 * preimage, nonce cap, byte/limit budgets, stale cursors, disabled-mailbox 404s).
 *
 * The preimage vectors below were produced by running the Rust `mailbox_auth_preimage` itself
 * (`backend/cashweb/cashweb-registry/src/http/monad_message.rs`) in a throwaway `cargo test` over
 * fixed inputs (epoch=0x11.., nonce=0x22.., expires=1_700_000_060_000, token=0x33..,
 * recipient=0xab*20) -- so the TypeScript builder is pinned to the real relay bytes, not merely
 * to this repo's own re-derivation.
 */
import { createHash } from 'crypto'
import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import {
  MailboxChallenge,
  MailboxAuthParams,
  MonadMailboxAuthError,
  MonadMailboxError,
  MonadMailboxChallengeCapacityError,
  MonadMailboxProtocolError,
  MonadMailboxRecordTooLargeError,
  MonadMailboxRecoveryActiveError,
  MonadMailboxRequestError,
  MonadMailboxRetryableError,
  MonadMailboxStaleCursorError,
  MonadMailboxUnavailableError,
  ackMonadMailboxRecovery,
  bytesToHex,
  buildMailboxAuthPreimage,
  fetchMonadMailboxInbox,
  fetchMonadMailboxInboxPage,
  fetchMonadMailboxRecoveries,
  fetchMonadMailboxRecoveryPage,
  mailboxAuthDigest,
} from './monad-mailbox-client'
import { fetchMonadMessagesSince } from './monad-message-feed'
import {
  DEFAULT_MOCK_MAX_USED_CHALLENGES,
  MockMailboxRelay,
  MockStoredMessage,
} from './monad-mailbox-mock-relay.testutil'
import __pb_monad_message_pb from './monad_message_pb'
const { MonadStampedMessage, MonadStampPayment } = __pb_monad_message_pb

const BASE = 'https://relay.example.com'
const RUST = {
  inboxNoCursor:
    '6672616e6b3a6d61696c626f782d687474702d617574683a763200111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f696e626f782f01abababababababababababababababababababab0000018bcfe568000000000000000000640000000000404000000000044d4f4e54',
  inboxCursorNoTag:
    '6672616e6b3a6d61696c626f782d687474702d617574683a763200111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f696e626f782f01abababababababababababababababababababab000000000000000501000000bc30313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130323031303230313032303130320000000000000032000000000000040000000000',
  recoveryAck:
    '6672616e6b3a6d61696c626f782d687474702d617574683a763200111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333504f5354002f6d6573736167652f6d6f6e61642f7265636f766572792d61636b2f03abababababababababababababababababababab0000000000000000000000000000000001000000000000000044444444444444444444444444444444444444444444444444444444444444445555555555555555555555555555555555555555555555555555555555555555000000044d4f4e54',
  recovery:
    '6672616e6b3a6d61696c626f782d687474702d617574683a763200111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000018bcfe652603333333333333333333333333333333333333333333333333333333333333333474554002f6d6573736167652f6d6f6e61642f7265636f766572792f02abababababababababababababababababababab000000000000000000000000000000001400000000000003e8000000044d4f4e54',
}
const RUST_CURSOR = '0102'.repeat(47)

const RECIPIENT = '0x' + 'ab'.repeat(20)
function challengeFor(
  resource: MailboxChallenge['resource'],
  overrides: Partial<MailboxChallenge>,
): MailboxChallenge {
  return {
    epoch: '11'.repeat(32),
    nonce: '22'.repeat(32),
    expires_at_ms: 1_700_000_060_000,
    token: '33'.repeat(32),
    signing_domain: 'frank:mailbox-http-auth:v2',
    resource,
    since: 0,
    cursor: null,
    limit: 20,
    max_bytes: 1000,
    network_tag: '4d4f4e54',
    recovery_payload_hash: null,
    recovery_obligation_id: null,
    ...overrides,
  }
}

describe('buildMailboxAuthPreimage (pinned to bytes from the Rust mailbox_auth_preimage)', () => {
  it('inbox without cursor, network tag MONT', () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor('inbox', {
        since: 1_700_000_000_000,
        limit: 100,
        max_bytes: 4_210_688,
      }),
      RECIPIENT,
    )
    expect(bytesToHex(preimage)).toBe(RUST.inboxNoCursor)
  })

  it('inbox with an opaque cursor token and an empty network tag', () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor('inbox', {
        since: 5,
        cursor: RUST_CURSOR,
        limit: 50,
        max_bytes: 1024,
        network_tag: '',
      }),
      RECIPIENT,
    )
    expect(bytesToHex(preimage)).toBe(RUST.inboxCursorNoTag)
  })

  it('recovery_ack binds payload hash and obligation id, POST recovery-ack path', () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor('recovery_ack', {
        limit: 1,
        max_bytes: 0,
        recovery_payload_hash: '44'.repeat(32),
        recovery_obligation_id: '55'.repeat(32),
      }),
      RECIPIENT,
    )
    expect(bytesToHex(preimage)).toBe(RUST.recoveryAck)
  })

  it('recovery', () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor('recovery', { limit: 20, max_bytes: 1000 }),
      RECIPIENT,
    )
    expect(bytesToHex(preimage)).toBe(RUST.recovery)
  })

  it('hashes with plain SHA-256', () => {
    const preimage = buildMailboxAuthPreimage(
      challengeFor('recovery', {}),
      RECIPIENT,
    )
    expect(bytesToHex(mailboxAuthDigest(preimage))).toBe(
      createHash('sha256').update(preimage).digest('hex'),
    )
  })

  it('rejects a malformed challenge instead of signing it', () => {
    expect(() =>
      buildMailboxAuthPreimage(
        challengeFor('inbox', { epoch: 'zz' }),
        RECIPIENT,
      ),
    ).toThrow(MonadMailboxProtocolError)
    expect(() =>
      buildMailboxAuthPreimage(
        challengeFor('bogus' as MailboxChallenge['resource'], {}),
        RECIPIENT,
      ),
    ).toThrow(MonadMailboxProtocolError)
  })
})

// --- fixtures ---------------------------------------------------------------------------------

interface Fixture {
  relay: MockMailboxRelay
  auth: MailboxAuthParams
  sleeps: number[]
  signCalls: () => number
  address: string
  privateKey: PrivateKey
}

function makeFixture(
  options: {
    maxUsedChallenges?: number
    enabled?: boolean
    register?: boolean
    signWith?: PrivateKey
  } = {},
): Fixture {
  const privateKey = new PrivateKey()
  const address =
    '0x' +
    createHash('sha256')
      .update(privateKey.toBuffer())
      .digest('hex')
      .slice(0, 40)
  const relay = new MockMailboxRelay({
    enabled: options.enabled,
    maxUsedChallenges: options.maxUsedChallenges,
  })
  if (options.register !== false) {
    relay.registerProfile(address, privateKey.toPublicKey().toBuffer())
  }
  const signer = options.signWith ?? privateKey
  const sleeps: number[] = []
  let signs = 0
  return {
    relay,
    sleeps,
    signCalls: () => signs,
    address,
    privateKey,
    auth: {
      relayBaseUrl: BASE + '/',
      recipient: address,
      http: relay.http,
      retry: {
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        sleep: async ms => void sleeps.push(ms),
      },
      signDigest: digest => {
        signs++
        const signature = bitcoreCrypto.ECDSA.sign(Buffer.from(digest), signer)
        return (signature as unknown as { toDER(): Buffer }).toDER()
      },
    },
  }
}

function message(
  recipient: string,
  timestamp: number,
  byte: number,
  size = 8,
): MockStoredMessage {
  return {
    recipient,
    timestamp,
    payloadHash: Buffer.alloc(32, byte),
    encryptedPayload: Buffer.alloc(size, byte),
    stampPayments: [{ childIndex: 0, rawTx: Buffer.from([1, 2, 3, byte]) }],
    networkTag: Buffer.from('MONT'),
  }
}

describe('fetchMonadMailboxInbox / fetchMonadMessagesSince', () => {
  it('follows cursors across pages in (timestamp, hash) order and decodes the stored shape', async () => {
    const f = makeFixture()
    for (let i = 0; i < 250; i++) {
      // Three rows share a timestamp to exercise the payload-hash tie-breaker at page edges.
      f.relay.addMessage(
        message(f.address, 1000 + Math.floor(i / 3), i % 256, 4),
      )
    }
    f.relay.addMessage(message('0x' + '99'.repeat(20), 1000, 0xee)) // someone else's row
    const result = await fetchMonadMailboxInbox({ ...f.auth, sinceMs: 0 })
    expect(result.truncatedBy).toBeUndefined()
    // De-duplication by payload hash: only 250 rows but payload bytes repeat mod 256 -> all unique.
    expect(result.messages).toHaveLength(250)
    const stamps = result.messages.map(m => m.timestamp)
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps)
    expect(result.messages[0].message?.stampPayments[0].rawTx).toEqual(
      new Uint8Array([1, 2, 3, result.messages[0].message!.payloadHash[0]]),
    )
    expect(new TextDecoder().decode(result.messages[0].networkTag)).toBe('MONT')
    // 3 pages of <=100 rows: each page = one challenge + one read, cursor bound after the first.
    const reads = f.relay.log.filter(l => l.route === 'inbox')
    expect(reads).toHaveLength(3)
    expect(reads[0].query.cursor).toBeUndefined()
    expect(reads[1].query.cursor).toMatch(/^[0-9a-f]{188}$/)
    expect(reads.every(r => r.query.limit === '100')).toBe(true)
    expect(f.relay.usedChallenges(f.address)).toBe(3)
    expect(f.signCalls()).toBe(3)
  })

  it('honours the inclusive since bound and returns [] for a genuinely empty inbox', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 100, 1))
    f.relay.addMessage(message(f.address, 200, 2))
    expect(
      (await fetchMonadMessagesSince({ ...f.auth, sinceMs: 200 })).map(
        m => m.timestamp,
      ),
    ).toEqual([200])
    expect(await fetchMonadMessagesSince({ ...f.auth, sinceMs: 201 })).toEqual(
      [],
    )
  })

  it('drops duplicate payload hashes seen across pages', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 100, 7))
    f.relay.addMessage({ ...message(f.address, 101, 7) }) // same hash, later timestamp
    const messages = await fetchMonadMessagesSince({
      ...f.auth,
      sinceMs: 0,
      pageLimit: 1,
    })
    expect(messages).toHaveLength(1)
  })

  it('splits pages by max_bytes and fails clearly when one record exceeds the budget', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 1, 1, 200))
    f.relay.addMessage(message(f.address, 2, 2, 200))
    const paged = await fetchMonadMailboxInboxPage({
      ...f.auth,
      sinceMs: 0,
      maxBytes: 400,
    })
    expect(paged.messages).toHaveLength(1)
    expect(paged.nextCursor).toBeDefined()
    await expect(
      fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0, maxBytes: 50 }),
    ).rejects.toBeInstanceOf(MonadMailboxRecordTooLargeError)
  })

  it('rejects an out-of-range limit as a request error (400 invalid_mailbox_limit)', async () => {
    const f = makeFixture()
    await expect(
      fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0, limit: 101 }),
    ).rejects.toMatchObject({
      constructor: MonadMailboxRequestError,
      status: 400,
      code: 'invalid_mailbox_limit',
    })
    expect(f.signCalls()).toBe(0) // the relay refused to issue a challenge; nothing was signed
  })

  it('surfaces a stale cursor (older than since) distinctly', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 100, 1))
    f.relay.addMessage(message(f.address, 200, 2))
    const first = await fetchMonadMailboxInboxPage({
      ...f.auth,
      sinceMs: 0,
      limit: 1,
    })
    expect(first.nextCursor).toBeDefined()
    await expect(
      fetchMonadMailboxInboxPage({
        ...f.auth,
        sinceMs: 150,
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(MonadMailboxStaleCursorError)
  })

  it('reports a cursor from before a relay restart as an auth failure in the challenge phase', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 100, 1))
    f.relay.addMessage(message(f.address, 200, 2))
    const first = await fetchMonadMailboxInboxPage({
      ...f.auth,
      sinceMs: 0,
      limit: 1,
    })
    const restarted = new MockMailboxRelay() // new epoch + HMAC secret
    restarted.registerProfile(f.address, f.privateKey.toPublicKey().toBuffer())
    const error = await fetchMonadMailboxInboxPage({
      ...f.auth,
      http: restarted.http,
      sinceMs: 0,
      cursor: first.nextCursor,
      limit: 1,
    }).catch(e => e)
    expect(error).toBeInstanceOf(MonadMailboxAuthError)
    expect(error.phase).toBe('challenge')
    expect(restarted.log.filter(l => l.route === 'challenge')).toHaveLength(1) // not retried
  })

  it('a later-page failure returns a complete-timestamp prefix (relay caps unexpired challenges; modelled at 8 here), first-page failure throws', async () => {
    const f = makeFixture({ maxUsedChallenges: 8 })
    for (let i = 0; i < 12; i++)
      f.relay.addMessage(message(f.address, 100 + i, i))
    const truncated = await fetchMonadMailboxInbox({
      ...f.auth,
      sinceMs: 0,
      pageLimit: 1,
    })
    expect(truncated.messages).toHaveLength(7) // 8 fetched, the 9th refused; last row's group dropped
    expect(truncated.truncatedBy).toBeInstanceOf(
      MonadMailboxChallengeCapacityError,
    )
    // Now the recipient has exhausted its nonce budget: a first-page failure must throw.
    const capacity = await fetchMonadMailboxInbox({
      ...f.auth,
      sinceMs: 0,
    }).catch(e => e)
    expect(capacity).toBeInstanceOf(MonadMailboxChallengeCapacityError)
    expect(capacity).toMatchObject({ status: 429, retryAfterMs: 60_000 })
    expect(f.sleeps).toEqual([]) // capacity only returns on expiry: not retried in-call
    // The feed wrapper reports truncation to the caller.
    const g = makeFixture({ maxUsedChallenges: 8 })
    for (let i = 0; i < 12; i++)
      g.relay.addMessage(message(g.address, 100 + i, i))
    const reasons: unknown[] = []
    const messages = await fetchMonadMessagesSince({
      ...g.auth,
      sinceMs: 0,
      pageLimit: 1,
      onTruncated: reason => reasons.push(reason),
    })
    expect(messages).toHaveLength(7)
    expect(reasons).toHaveLength(1)
  })

  describe('truncation never strands the rest of a timestamp group (F1)', () => {
    /** Fails every inbox read after the first `okReads`, as a dropped connection / 500 would. */
    function failAfter(f: Fixture, okReads: number, status = 500) {
      const original = f.auth.http!
      let reads = 0
      f.auth.http = async request => {
        if (request.url.includes('/inbox/') && ++reads > okReads) {
          return { status, headers: {}, data: new Uint8Array() }
        }
        return original(request)
      }
    }

    it('drops the trailing same-timestamp rows, so since=lastTimestamp+1 loses nothing', async () => {
      const f = makeFixture()
      f.relay.addMessage(message(f.address, 99, 1)) // X
      f.relay.addMessage(message(f.address, 100, 2)) // A
      f.relay.addMessage(message(f.address, 100, 3)) // B, same timestamp as A
      const healthy = f.auth.http!
      failAfter(f, 1) // page 1 = [X, A], page 2 (would be [B]) fails

      const reasons: unknown[] = []
      const first = await fetchMonadMessagesSince({
        ...f.auth,
        sinceMs: 0,
        pageLimit: 2,
        onTruncated: r => reasons.push(r),
      })
      expect(reasons).toHaveLength(1)
      expect(first.map(m => m.timestamp)).toEqual([99]) // A was fetched but is withheld

      // The consumer advances exactly like the app/bots: since = lastTimestamp + 1.
      const nextSince = first[first.length - 1].timestamp + 1
      f.auth.http = healthy
      const second = await fetchMonadMessagesSince({
        ...f.auth,
        sinceMs: nextSince,
      })
      const all = [...first, ...second]
      expect(all.map(m => m.timestamp).sort((a, b) => a - b)).toEqual([
        99, 100, 100,
      ])
      expect(
        new Set(all.map(m => bytesToHex(m.message!.payloadHash))).size,
      ).toBe(3)
    })

    it('when every fetched row shares one timestamp there is no safe prefix: the error is thrown, not an empty success', async () => {
      const f = makeFixture()
      for (const byte of [1, 2, 3])
        f.relay.addMessage(message(f.address, 100, byte))
      failAfter(f, 1)
      await expect(
        fetchMonadMessagesSince({ ...f.auth, sinceMs: 0, pageLimit: 2 }),
      ).rejects.toBeInstanceOf(MonadMailboxError)
    })

    it('a page-budget stop applies the same rule', async () => {
      const f = makeFixture()
      f.relay.addMessage(message(f.address, 99, 1))
      f.relay.addMessage(message(f.address, 100, 2))
      f.relay.addMessage(message(f.address, 100, 3))
      const result = await fetchMonadMailboxInbox({
        ...f.auth,
        sinceMs: 0,
        pageLimit: 2,
        maxPages: 1,
      })
      expect(result.truncatedBy).toBeInstanceOf(MonadMailboxRetryableError)
      expect(result.messages.map(m => m.timestamp)).toEqual([99])
    })
  })

  it('stops instead of looping when the relay repeats a cursor', async () => {
    const g = makeFixture()
    g.relay.addMessage(message(g.address, 100, 1))
    g.relay.addMessage(message(g.address, 101, 2))
    const originalHttp = g.auth.http!
    let firstCursor: string | undefined
    g.auth.http = async request => {
      const response = await originalHttp(request)
      if (request.url.includes('/inbox/')) {
        firstCursor ??= response.headers['x-frank-mailbox-next-cursor']
        response.headers['x-frank-mailbox-next-cursor'] = firstCursor // same valid token forever
      }
      return response
    }
    await expect(
      fetchMonadMailboxInbox({ ...g.auth, sinceMs: 0, pageLimit: 1 }),
    ).rejects.toBeInstanceOf(MonadMailboxProtocolError)
  })
})

describe('mock relay contract pin', () => {
  it('models the relay cap of 30 consumed challenges per recipient per 60 s', async () => {
    expect(DEFAULT_MOCK_MAX_USED_CHALLENGES).toBe(30)
    const f = makeFixture()
    for (let i = 0; i < 30; i++) {
      await fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0 })
    }
    await expect(
      fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0 }),
    ).rejects.toBeInstanceOf(MonadMailboxChallengeCapacityError)
  })
})

describe('mailbox disabled / unknown relay', () => {
  it('never turns a 404 into an empty inbox (inbox, recovery, ack)', async () => {
    const f = makeFixture({ enabled: false })
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 }),
    ).rejects.toBeInstanceOf(MonadMailboxUnavailableError)
    await expect(fetchMonadMailboxRecoveries(f.auth)).rejects.toBeInstanceOf(
      MonadMailboxUnavailableError,
    )
    await expect(
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: '11'.repeat(32),
        obligationIdHex: '22'.repeat(32),
      }),
    ).rejects.toBeInstanceOf(MonadMailboxUnavailableError)
    expect(f.signCalls()).toBe(0)
    expect(f.sleeps).toEqual([]) // 404 is definitive, not retried
  })

  it('a 404 on the read after a challenge (old relay with only /auth) is also Unavailable', async () => {
    const f = makeFixture()
    f.relay.inject('inbox', { status: 404 })
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 }),
    ).rejects.toBeInstanceOf(MonadMailboxUnavailableError)
  })
})

describe('local validation before anything is sent', () => {
  it('refuses to sign a challenge with a foreign signing_domain (no cross-protocol signature)', async () => {
    const f = makeFixture()
    const originalHttp = f.auth.http!
    f.auth.http = async request => {
      const response = await originalHttp(request)
      if (request.url.includes('/auth/')) {
        const body = JSON.parse(
          new TextDecoder().decode(response.data as Uint8Array),
        )
        body.signing_domain = 'frank:something-else:v1'
        response.data = new TextEncoder().encode(JSON.stringify(body))
      }
      return response
    }
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 }),
    ).rejects.toThrow(/signing_domain/)
    expect(f.signCalls()).toBe(0)
  })

  it.each([
    ['payload hash not hex', 'nothex', '22'.repeat(32)],
    ['payload hash upper-case', 'AB'.repeat(32), '22'.repeat(32)],
    ['payload hash short', '11'.repeat(31), '22'.repeat(32)],
    ['obligation id not hex', '11'.repeat(32), 'zz'.repeat(32)],
    ['obligation id long', '11'.repeat(32), '22'.repeat(33)],
  ])(
    'ack rejects %s locally: no request is made and nothing is signed',
    async (_name, payloadHashHex, obligationIdHex) => {
      const f = makeFixture()
      await expect(
        ackMonadMailboxRecovery({ ...f.auth, payloadHashHex, obligationIdHex }),
      ).rejects.toBeInstanceOf(MonadMailboxRequestError)
      expect(f.relay.log).toHaveLength(0)
      expect(f.signCalls()).toBe(0)
    },
  )

  it('rejects a malformed recipient locally', async () => {
    const f = makeFixture()
    await expect(
      fetchMonadMessagesSince({ ...f.auth, recipient: '0x1234', sinceMs: 0 }),
    ).rejects.toBeInstanceOf(MonadMailboxRequestError)
    expect(f.signCalls()).toBe(0)
  })
})

describe('authentication failures', () => {
  it('an unregistered recipient is a 401 auth error (one fresh-challenge retry, then throw)', async () => {
    const f = makeFixture({ register: false })
    const error = await fetchMonadMessagesSince({
      ...f.auth,
      sinceMs: 0,
    }).catch(e => e)
    expect(error).toBeInstanceOf(MonadMailboxAuthError)
    expect(error.phase).toBe('request')
    expect(f.relay.log.filter(l => l.route === 'challenge')).toHaveLength(2)
  })

  it('a signature from the wrong key is rejected', async () => {
    const f = makeFixture({ signWith: new PrivateKey() })
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 }),
    ).rejects.toBeInstanceOf(MonadMailboxAuthError)
  })

  it('recovers from one expired/replayed challenge by fetching a fresh one', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 100, 1))
    f.relay.inject('inbox', {
      status: 401,
      body: { error: 'mailbox_auth_failed' },
    })
    const messages = await fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    expect(messages).toHaveLength(1)
    expect(f.relay.log.filter(l => l.route === 'challenge')).toHaveLength(2)
  })

  it('refuses to sign a challenge that does not echo the request', async () => {
    const f = makeFixture()
    const originalHttp = f.auth.http!
    f.auth.http = async request => {
      const response = await originalHttp(request)
      if (request.url.includes('/auth/')) {
        const body = JSON.parse(
          new TextDecoder().decode(response.data as Uint8Array),
        )
        body.limit = 1 // relay "downgrades" the page size behind the client's back
        response.data = new TextEncoder().encode(JSON.stringify(body))
      }
      return response
    }
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 }),
    ).rejects.toBeInstanceOf(MonadMailboxProtocolError)
    expect(f.signCalls()).toBe(0)
  })
})

describe('retry / rate limit handling', () => {
  it('retries 503 on the challenge and on the read with exponential backoff, then succeeds', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 100, 1))
    f.relay.inject('challenge', {
      status: 503,
      body: { error: 'mailbox_auth_retryable' },
    })
    f.relay.inject('inbox', {
      status: 503,
      body: { error: 'mailbox_auth_retryable' },
    })
    const messages = await fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    expect(messages).toHaveLength(1)
    expect(f.sleeps).toEqual([100, 200])
  })

  it('honours Retry-After on 429 (seconds), capped by maxRetryAfterMs', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 100, 1))
    f.relay.inject('challenge', {
      status: 429,
      headers: { 'retry-after': '3' },
      body: { error: 'rate_limited' },
    })
    await fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 })
    expect(f.sleeps).toEqual([3000])
    f.sleeps.length = 0
    f.relay.inject('challenge', {
      status: 429,
      headers: { 'retry-after': '120' },
    })
    await fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0 })
    expect(f.sleeps).toEqual([60_000]) // Retry-After honoured, capped at maxRetryAfterMs (F4)
    f.sleeps.length = 0
    f.relay.inject('challenge', {
      status: 429,
      headers: { 'retry-after': '3600' },
    })
    await fetchMonadMailboxInboxPage({ ...f.auth, sinceMs: 0 })
    expect(f.sleeps).toEqual([60_000])
  })

  it('gives up after maxAttempts with a retryable error that says so', async () => {
    const f = makeFixture()
    f.relay.atCapacity = true
    const error = await fetchMonadMessagesSince({
      ...f.auth,
      sinceMs: 0,
    }).catch(e => e)
    expect(error).toBeInstanceOf(MonadMailboxRetryableError)
    expect(error.status).toBe(503)
    expect(f.sleeps).toEqual([100, 200, 400]) // 4 attempts
  })

  it('retries network failures (no response) but not local signer errors', async () => {
    const f = makeFixture()
    f.relay.addMessage(message(f.address, 100, 1))
    f.relay.inject('challenge', 'network-error', 'network-error')
    expect(
      await fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 }),
    ).toHaveLength(1)
    expect(f.sleeps).toEqual([100, 200])

    const g = makeFixture()
    g.relay.inject(
      'challenge',
      'network-error',
      'network-error',
      'network-error',
      'network-error',
    )
    const error = await fetchMonadMessagesSince({
      ...g.auth,
      sinceMs: 0,
    }).catch(e => e)
    expect(error).toBeInstanceOf(MonadMailboxRetryableError)
    expect(error.message).toMatch(/no response from relay/)

    const h = makeFixture()
    h.auth.signDigest = () => {
      throw new Error('hardware signer unavailable')
    }
    await expect(
      fetchMonadMessagesSince({ ...h.auth, sinceMs: 0 }),
    ).rejects.toThrow('hardware signer unavailable')
    expect(h.sleeps).toEqual([])
  })

  it('does not retry definitive client errors (400) or server 500', async () => {
    const f = makeFixture()
    f.relay.inject('inbox', { status: 500 })
    await expect(
      fetchMonadMessagesSince({ ...f.auth, sinceMs: 0 }),
    ).rejects.toMatchObject({ status: 500 })
    expect(f.sleeps).toEqual([])
  })
})

describe('recovery listing and ack', () => {
  function recoveryFixture(f: Fixture, lifecycle: string, hashByte: number) {
    const nested = new MonadStampedMessage()
    nested.setEncryptedPayload(new Uint8Array([9, hashByte]))
    nested.setPayloadHash(new Uint8Array(32).fill(hashByte))
    for (const child of [0, 1]) {
      const payment = new MonadStampPayment()
      payment.setChildIndex(child)
      payment.setRawTx(new Uint8Array([child, hashByte]))
      nested.addStampPayments(payment)
    }
    f.relay.addRecovery({
      recipient: f.address,
      payloadHash: Buffer.alloc(32, hashByte),
      obligationId: Buffer.alloc(32, hashByte + 0x10),
      canonicalMessage: Buffer.from(nested.serializeBinary()),
      confirmedChildren: [0],
      lifecycle,
    })
  }

  it('pages recovery obligations with cursors and decodes the canonical message', async () => {
    const f = makeFixture()
    recoveryFixture(f, 'terminal:expired', 1)
    recoveryFixture(f, 'pending', 2)
    recoveryFixture(f, 'fully_confirmed', 3)
    const first = await fetchMonadMailboxRecoveryPage({ ...f.auth, limit: 2 })
    expect(first.records.map(r => r.lifecycle)).toEqual([
      'terminal:expired',
      'pending',
    ])
    expect(first.nextCursor).toMatch(/^[0-9a-f]{172}$/)
    const all = await fetchMonadMailboxRecoveries({ ...f.auth, pageLimit: 2 })
    expect(all.truncatedBy).toBeUndefined()
    expect(all.records).toHaveLength(3)
    expect(all.records[0]).toMatchObject({
      payloadHashHex: '01'.repeat(32),
      obligationIdHex: '11'.repeat(32),
      confirmedChildren: [0],
    })
    expect(
      all.records[0].canonicalMessage.stampPayments.map(p => p.childIndex),
    ).toEqual([0, 1])
    expect(all.records[0].canonicalMessage.payloadHash).toEqual(
      new Uint8Array(32).fill(1),
    )
  })

  it('acks a terminal obligation (204), is idempotent when it is already gone, refuses an active one', async () => {
    const f = makeFixture()
    recoveryFixture(f, 'terminal:stale_nonce', 1)
    recoveryFixture(f, 'pending', 2)
    const ack = (byte: number) =>
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: bytesToHex(new Uint8Array(32).fill(byte)),
        obligationIdHex: bytesToHex(new Uint8Array(32).fill(byte + 0x10)),
      })
    await ack(1)
    expect(f.relay.hasRecovery(Buffer.alloc(32, 1))).toBe(false)
    await ack(1) // absent -> still 204
    await expect(ack(2)).rejects.toBeInstanceOf(MonadMailboxRecoveryActiveError)
    expect(f.relay.hasRecovery(Buffer.alloc(32, 2))).toBe(true)
  })

  it('validates ack identifiers locally; an ack for another recipient is a silent 204 that retires nothing', async () => {
    const f = makeFixture()
    await expect(
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: 'nothex',
        obligationIdHex: '22'.repeat(32),
      }),
    ).rejects.toBeInstanceOf(MonadMailboxRequestError)
    const other = makeFixture()
    f.relay.registerProfile(
      other.address,
      other.privateKey.toPublicKey().toBuffer(),
    )
    recoveryFixture(f, 'terminal:expired', 5) // owned by f, not `other`
    // 204 is NOT proof the obligation existed or was retired (no existence oracle).
    await expect(
      ackMonadMailboxRecovery({
        ...other.auth,
        http: f.relay.http,
        payloadHashHex: '05'.repeat(32),
        obligationIdHex: '15'.repeat(32),
      }),
    ).resolves.toBeUndefined()
    expect(f.relay.hasRecovery(Buffer.alloc(32, 5))).toBe(true)
    // A stale obligation id for the owner is also a plain 204 and leaves the row alone.
    await expect(
      ackMonadMailboxRecovery({
        ...f.auth,
        payloadHashHex: '05'.repeat(32),
        obligationIdHex: 'ee'.repeat(32),
      }),
    ).resolves.toBeUndefined()
    expect(f.relay.hasRecovery(Buffer.alloc(32, 5))).toBe(true)
  })
})
