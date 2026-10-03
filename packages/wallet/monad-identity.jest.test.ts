/**
 * Unit tests for `monad-identity.ts` (ticket #41): `MonadIdentity`'s address/key derivation, and
 * `registerMonadIdentity`/`fetchMonadIdentityPubKey`/`fetchMonadProfile`'s `PUT`/`GET
 * /metadata/:addr` wiring. `axios` is mocked here (mirroring `monad-stamp-client.jest.test.ts`'s
 * own convention) since this file -- unlike `../chain/monad-chain.ts` -- *is* the HTTP client
 * layer being tested.
 */
import axios from 'axios'
import { readFileSync } from 'fs'
import { resolve } from 'path'

import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb
import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const {
  AddressMetadata,
  Entry,
  Header,
  ListMonadProfilesEntry,
  ListMonadProfilesResponse,
} = __pb_registry_metadata_pb
import {
  MONAD_IDENTITY_DERIVATION_PATH,
  MonadIdentity,
  buildSignedDirectoryStatement,
  fetchCuratedDefaultContacts,
  fetchMonadIdentityPubKey,
  fetchMonadProfile,
  fetchMonadProfilesSince,
  isBotProfileSignedPayload,
  isCborFrame,
  registerMonadIdentity,
  registerMonadIdentityCbor,
  searchMonadProfiles,
} from './monad-identity'
import { defaultContext, validateFrame } from '@frank/codec'
import { validateProfileDisplayName } from './profile-display-name'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const RELAY_BASE_URL = 'http://relay.test'
const SEED = {
  mnemonic: 'test test test test test test test test test test test junk',
}

interface DisplayNameFixtureCase {
  id: string
  input?: string
  inputRepeat?: { value: string; count: number; suffix?: string }
  valid: boolean
}

const displayNameFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../fixtures/profile-display-name-v1.json'),
    'utf8',
  ),
) as { cases: DisplayNameFixtureCase[] }

function displayNameFixtureInput(testCase: DisplayNameFixtureCase): string {
  if (testCase.input !== undefined) return testCase.input
  const repeated = testCase.inputRepeat
  if (!repeated) throw new Error(`Fixture ${testCase.id} has no input`)
  return repeated.value.repeat(repeated.count) + (repeated.suffix ?? '')
}

describe('MonadIdentity', () => {
  it('derives an EIP-55 checksummed 0x address, deterministically, from a seed', () => {
    const a = MonadIdentity.fromSeed(SEED)
    const b = MonadIdentity.fromSeed(SEED)
    expect(a.address.raw).toBe(b.address.raw)
    expect(a.address.raw).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(a.displayAddress).toBe(a.address.raw)
  })

  it("uses the reserved change=1 identity branch, not the burner pool's change=0 branch", () => {
    expect(MONAD_IDENTITY_DERIVATION_PATH).toBe("m/44'/60'/1'/0/0")
  })

  it('never produces a Lotus-style address (no "lotus" prefix, no base58)', () => {
    const identity = MonadIdentity.fromSeed(SEED)
    expect(identity.address.raw.startsWith('0x')).toBe(true)
    expect(identity.address.raw).not.toMatch(/^lotus/)
  })

  it('round-trips through toPrivateKeyHex/fromPrivateKeyHex', () => {
    const original = MonadIdentity.fromSeed(SEED)
    const reloaded = MonadIdentity.fromPrivateKeyHex(original.toPrivateKeyHex())
    expect(reloaded.address.raw).toBe(original.address.raw)
    expect(reloaded.compressedPubKey).toEqual(original.compressedPubKey)
  })

  it('compressedPubKey is 33 bytes (0x02/0x03 prefix)', () => {
    const identity = MonadIdentity.fromSeed(SEED)
    expect(identity.compressedPubKey).toHaveLength(33)
    expect([0x02, 0x03]).toContain(identity.compressedPubKey[0])
  })

  it('signHash produces a DER-encoded ECDSA signature', () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const hash = Buffer.alloc(32, 7)
    const signature = identity.signHash(hash)
    // DER sequence tag.
    expect(signature[0]).toBe(0x30)
    expect(signature.length).toBeGreaterThan(0)
  })

  it('toBitcorePrivateKey wraps the same secp256k1 key (shared curve, no Lotus encoding)', () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const bitcoreKey = identity.toBitcorePrivateKey()
    expect(bitcoreKey.toPublicKey().toBuffer()).toEqual(
      identity.compressedPubKey,
    )
  })
})

describe('registerMonadIdentity', () => {
  beforeEach(() => {
    mockedAxios.mockClear()
  })

  it('sets no forbidden header name in a browser context, where the browser sends its own Origin (ticket #278)', async () => {
    const globals = globalThis as { XMLHttpRequest?: unknown }
    globals.XMLHttpRequest = class {}
    try {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: new Uint8Array(0),
        statusText: 'OK',
        headers: {},
        config: {},
      })
      await registerMonadIdentity({
        relayBaseUrl: RELAY_BASE_URL,
        identity: MonadIdentity.fromSeed(SEED),
      })
      const names = Object.keys(
        mockedAxios.mock.calls[0][0].headers as Record<string, string>,
      ).map(name => name.toLowerCase())
      expect(names).toEqual(['content-type'])
    } finally {
      delete globals.XMLHttpRequest
    }
  })

  it('still sends the Origin header the relay requires when there is no browser (bots, Node)', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: new Uint8Array(0),
      statusText: 'OK',
      headers: {},
      config: {},
    })
    await registerMonadIdentity({
      relayBaseUrl: RELAY_BASE_URL,
      identity: MonadIdentity.fromSeed(SEED),
    })
    expect(mockedAxios.mock.calls[0][0].headers).toMatchObject({
      Origin: 'http://frank.local',
    })
  })

  it("PUTs a signed AddressMetadata to /metadata/:addr with the identity's Monad address", async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: new Uint8Array(0),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    await registerMonadIdentity({ relayBaseUrl: RELAY_BASE_URL, identity })

    expect(mockedAxios).toHaveBeenCalledTimes(1)
    const call = mockedAxios.mock.calls[0][0]
    expect(call.method).toBe('put')
    expect(call.url).toBe(`${RELAY_BASE_URL}/metadata/${identity.address.raw}`)
    expect(call.headers).toMatchObject({
      'Content-Type': 'application/x-protobuf',
    })
    const signedPayload = SignedPayload.deserializeBinary(
      new Uint8Array(call.data as Buffer),
    )
    expect(Buffer.from(signedPayload.getPublicKey_asU8())).toEqual(
      identity.compressedPubKey,
    )
    expect(signedPayload.getScheme()).toBe(SignedPayload.SignatureScheme.ECDSA)
  })

  it('signs display name, bio, and avatar into the Monad profile', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    mockedAxios.mockResolvedValueOnce({ status: 200, data: new Uint8Array() })

    await registerMonadIdentity({
      relayBaseUrl: RELAY_BASE_URL,
      identity,
      profile: {
        name: '\u00a0Alice\u2003',
        bio: 'Testing Frank',
        avatar: 'data:image/png;base64,AQID',
      },
    })

    const call = mockedAxios.mock.calls.at(-1)?.[0]
    expect(call).toBeDefined()
    const signed = SignedPayload.deserializeBinary(
      new Uint8Array(call?.data as Buffer),
    )
    const metadata = AddressMetadata.deserializeBinary(signed.getPayload_asU8())
    const entries = metadata.getEntriesList()
    expect(entries.map(entry => entry.getKind())).toEqual([
      'display_name',
      'bio',
      'avatar',
    ])
    expect(new TextDecoder().decode(entries[0].getBody_asU8())).toBe('Alice')
    expect(Buffer.from(entries[2].getBody_asU8())).toEqual(
      Buffer.from([1, 2, 3]),
    )
  })

  it.each(['', '   ', ' \t\n ', '\u00a0\u2003', undefined])(
    'treats an unset/blank stored name %j as absent: registers with no display_name entry',
    async name => {
      const identity = MonadIdentity.fromSeed(SEED)
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: new Uint8Array(),
      })

      await registerMonadIdentity({
        relayBaseUrl: RELAY_BASE_URL,
        identity,
        profile: { name, bio: 'hello' },
      })

      const call = mockedAxios.mock.calls.at(-1)?.[0]
      const signed = SignedPayload.deserializeBinary(
        new Uint8Array(call?.data as Buffer),
      )
      const kinds = AddressMetadata.deserializeBinary(signed.getPayload_asU8())
        .getEntriesList()
        .map(entry => entry.getKind())
      expect(kinds).toEqual(['bio'])
    },
  )

  it.each(['A\u0000B', 'A\u2028B', 'a'.repeat(129), '\ud800', 'x\udc00'])(
    'still refuses invalid non-blank name %j',
    async name => {
      await expect(
        registerMonadIdentity({
          relayBaseUrl: RELAY_BASE_URL,
          identity: MonadIdentity.fromSeed(SEED),
          profile: { name },
        }),
      ).rejects.toThrow(/invalid profile display name/i)
      expect(mockedAxios).not.toHaveBeenCalled()
    },
  )

  it.each(
    displayNameFixture.cases.filter(
      testCase =>
        !testCase.valid &&
        validateProfileDisplayName(displayNameFixtureInput(testCase))
          .normalized !== '',
    ),
  )(
    'refuses invalid display name fixture $id before signing or sending',
    async testCase => {
      const identity = MonadIdentity.fromSeed(SEED)

      await expect(
        registerMonadIdentity({
          relayBaseUrl: RELAY_BASE_URL,
          identity,
          profile: { name: displayNameFixtureInput(testCase) },
        }),
      ).rejects.toThrow(/invalid profile display name/i)
      expect(mockedAxios).not.toHaveBeenCalled()
    },
  )
})

describe('fetchMonadIdentityPubKey / fetchMonadProfile', () => {
  it('GETs /metadata/:addr and returns the registered pubkey', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(identity.compressedPubKey)
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(signedPayload.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const pubKey = await fetchMonadIdentityPubKey({
      relayBaseUrl: RELAY_BASE_URL,
      address: identity.address.raw,
    })

    expect(pubKey).toEqual(identity.compressedPubKey)
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: `${RELAY_BASE_URL}/metadata/${identity.address.raw}`,
      }),
    )
  })

  it('returns undefined on a 404', async () => {
    mockedAxios.mockRejectedValueOnce(
      Object.assign(new Error('not found'), {
        isAxiosError: true,
        response: { status: 404 },
      }),
    )
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)

    const pubKey = await fetchMonadIdentityPubKey({
      relayBaseUrl: RELAY_BASE_URL,
      address: '0x' + '00'.repeat(20),
    })
    expect(pubKey).toBeUndefined()
  })

  it('fetchMonadProfile wraps the pubkey with the requested ChainAddress', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(identity.compressedPubKey)
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(signedPayload.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const profile = await fetchMonadProfile({
      relayBaseUrl: RELAY_BASE_URL,
      address: identity.address,
    })

    expect(profile?.address).toBe(identity.address)
    expect(Buffer.from(profile?.pubKey ?? [])).toEqual(
      identity.compressedPubKey,
    )
  })

  it('fetchMonadProfile decodes the signed user-facing fields', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const metadata = new AddressMetadata()
    const name = new Entry()
    name.setKind('display_name')
    name.setBody(new TextEncoder().encode('Alice'))
    const avatar = new Entry()
    avatar.setKind('avatar')
    avatar.setBody(new Uint8Array([1, 2, 3]))
    const contentType = new Header()
    contentType.setName('content-type')
    contentType.setValue('image/png')
    avatar.addHeaders(contentType)
    metadata.setEntriesList([name, avatar])
    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(identity.compressedPubKey)
    signedPayload.setPayload(metadata.serializeBinary())
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(signedPayload.serializeBinary()),
    })

    const profile = await fetchMonadProfile({
      relayBaseUrl: RELAY_BASE_URL,
      address: identity.address,
    })

    expect(profile?.name).toBe('Alice')
    expect(profile?.avatar).toBe('data:image/png;base64,AQID')
  })
})

describe('bot profile marker (#311)', () => {
  async function registeredPayload(profile?: { bot?: boolean; name?: string }) {
    const identity = MonadIdentity.fromSeed(SEED)
    mockedAxios.mockClear()
    mockedAxios.mockResolvedValueOnce({ status: 200, data: new Uint8Array(0) })
    await registerMonadIdentity({
      relayBaseUrl: RELAY_BASE_URL,
      identity,
      profile,
    })
    return {
      identity,
      signedPayload: SignedPayload.deserializeBinary(
        new Uint8Array(mockedAxios.mock.calls[0][0].data as Buffer),
      ),
    }
  }

  it('registers a `bot` entry only when asked, and the decoder sees exactly that', async () => {
    const marked = await registeredPayload({ bot: true, name: 'Dealer' })
    expect(isBotProfileSignedPayload(marked.signedPayload)).toBe(true)
    expect(
      AddressMetadata.deserializeBinary(marked.signedPayload.getPayload_asU8())
        .getEntriesList()
        .map(entry => entry.getKind()),
    ).toEqual(['display_name', 'bot'])

    expect(
      isBotProfileSignedPayload(
        (await registeredPayload({ name: 'Al' })).signedPayload,
      ),
    ).toBe(false)
    expect(
      isBotProfileSignedPayload((await registeredPayload()).signedPayload),
    ).toBe(false)
  })

  it('fetchMonadProfile surfaces the marker as `bot`', async () => {
    const { identity, signedPayload } = await registeredPayload({ bot: true })
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(signedPayload.serializeBinary()),
    })
    const profile = await fetchMonadProfile({
      relayBaseUrl: RELAY_BASE_URL,
      address: identity.address,
    })
    expect(profile?.bot).toBe(true)
  })
})

describe('fetchMonadProfilesSince', () => {
  it('GETs /metadata/monad?since=<sinceMs> and decodes each entry, including its SignedPayload', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(identity.compressedPubKey)
    signedPayload.setScheme(SignedPayload.SignatureScheme.ECDSA)

    const entry = new ListMonadProfilesEntry()
    entry.setAddress(identity.address.raw)
    entry.setSignedPayload(signedPayload.serializeBinary())
    const wireResponse = new ListMonadProfilesResponse()
    wireResponse.addEntries(entry)

    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(wireResponse.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const sinceMs = 1_700_000_000_000
    const profiles = await fetchMonadProfilesSince({
      relayBaseUrl: RELAY_BASE_URL,
      sinceMs,
    })

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: `${RELAY_BASE_URL}/metadata/monad`,
        params: { since: sinceMs },
      }),
    )
    expect(profiles).toHaveLength(1)
    expect(profiles[0].address).toBe(identity.address.raw)
    expect(Buffer.from(profiles[0].signedPayload.getPublicKey_asU8())).toEqual(
      identity.compressedPubKey,
    )
    expect(profiles[0].signedPayload.getScheme()).toBe(
      SignedPayload.SignatureScheme.ECDSA,
    )
  })

  it('returns [] on an empty ListMonadProfilesResponse', async () => {
    const emptyResponse = new ListMonadProfilesResponse()
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(emptyResponse.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const profiles = await fetchMonadProfilesSince({
      relayBaseUrl: RELAY_BASE_URL,
      sinceMs: 0,
    })

    expect(profiles).toEqual([])
  })
})

describe('searchMonadProfiles', () => {
  it('GETs /metadata/monad/search?prefix=&limit= and decodes each entry, including its SignedPayload', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(identity.compressedPubKey)
    signedPayload.setScheme(SignedPayload.SignatureScheme.ECDSA)

    const entry = new ListMonadProfilesEntry()
    entry.setAddress(identity.address.raw)
    entry.setSignedPayload(signedPayload.serializeBinary())
    const wireResponse = new ListMonadProfilesResponse()
    wireResponse.addEntries(entry)

    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(wireResponse.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const profiles = await searchMonadProfiles({
      relayBaseUrl: RELAY_BASE_URL,
      prefix: 'ali',
      limit: 5,
    })

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: `${RELAY_BASE_URL}/metadata/monad/search`,
        params: { prefix: 'ali', limit: 5 },
      }),
    )
    expect(profiles).toHaveLength(1)
    expect(profiles[0].address).toBe(identity.address.raw)
    expect(Buffer.from(profiles[0].signedPayload.getPublicKey_asU8())).toEqual(
      identity.compressedPubKey,
    )
    expect(profiles[0].signedPayload.getScheme()).toBe(
      SignedPayload.SignatureScheme.ECDSA,
    )
  })

  it('omits `limit` from the query when not provided', async () => {
    const emptyResponse = new ListMonadProfilesResponse()
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(emptyResponse.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    await searchMonadProfiles({ relayBaseUrl: RELAY_BASE_URL, prefix: 'bob' })

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: `${RELAY_BASE_URL}/metadata/monad/search`,
        params: { prefix: 'bob' },
      }),
    )
  })

  it('returns [] on an empty ListMonadProfilesResponse (no matches)', async () => {
    const emptyResponse = new ListMonadProfilesResponse()
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(emptyResponse.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const profiles = await searchMonadProfiles({
      relayBaseUrl: RELAY_BASE_URL,
      prefix: 'zzz',
    })

    expect(profiles).toEqual([])
  })

  it('propagates a network error, mirroring fetchMonadProfilesSince (no fail-soft)', async () => {
    mockedAxios.mockRejectedValueOnce(new Error('network down'))

    await expect(
      searchMonadProfiles({ relayBaseUrl: RELAY_BASE_URL, prefix: 'ali' }),
    ).rejects.toThrow('network down')
  })
})

describe('fetchCuratedDefaultContacts', () => {
  it('GETs /metadata/monad/curated-defaults and returns the configured entries', async () => {
    const entries = [
      { address: '0x' + '11'.repeat(20), name: 'Welcome Bot' },
      { address: '0x' + '22'.repeat(20), name: 'Support' },
    ]
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: { entries },
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const contacts = await fetchCuratedDefaultContacts({
      relayBaseUrl: RELAY_BASE_URL,
    })

    expect(contacts).toEqual(entries)
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: `${RELAY_BASE_URL}/metadata/monad/curated-defaults`,
      }),
    )
  })

  it('returns [] and does not throw on a 404/network error', async () => {
    mockedAxios.mockRejectedValueOnce(
      Object.assign(new Error('not found'), {
        isAxiosError: true,
        response: { status: 404 },
      }),
    )

    const contacts = await fetchCuratedDefaultContacts({
      relayBaseUrl: RELAY_BASE_URL,
    })

    expect(contacts).toEqual([])
  })

  it('returns [] and does not throw on a malformed response body (missing entries)', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {},
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const contacts = await fetchCuratedDefaultContacts({
      relayBaseUrl: RELAY_BASE_URL,
    })

    expect(contacts).toEqual([])
  })
})

describe('registerMonadIdentityCbor & dual-format CBOR/protobuf handling', () => {
  it('buildSignedDirectoryStatement produces a valid Stage 10.6 Type-2 attestation', () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const frame = buildSignedDirectoryStatement(identity, {
      network: 'monad-testnet',
      profile: {
        name: 'Alice',
        bio: 'Decentralized identity test',
        bot: true,
        avatar: 'data:image/png;base64,QUJDRA==',
      },
      timestampMs: 1_700_000_000_000,
    })

    expect(isCborFrame(frame)).toBe(true)
    const validated = validateFrame(
      frame,
      defaultContext({ operation: 'full' }),
    )
    expect(validated.kind).toBe('parsed')
    expect(validated.typed?.type).toBe(2)
    if (validated.typed?.type === 2) {
      const stmtFrame = validated.typed.statementFrame
      expect(stmtFrame.kind).toBe('parsed')
      expect(stmtFrame.typed?.type).toBe(4)
      if (stmtFrame.typed?.type === 4) {
        expect(stmtFrame.typed.network).toBe('monad-testnet')
        expect(stmtFrame.typed.subject.keyBytes).toEqual(
          new Uint8Array(identity.compressedPubKey),
        )
        expect(stmtFrame.typed.profileEntries?.map(e => e.kind)).toEqual([
          'display_name',
          'bio',
          'bot',
          'avatar',
        ])
      }
    }
  })

  it('registerMonadIdentityCbor sends Content-Type application/cbor to PUT /metadata/:addr', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: '',
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const identity = MonadIdentity.fromSeed(SEED)
    await registerMonadIdentityCbor({
      relayBaseUrl: RELAY_BASE_URL,
      identity,
      profile: { name: 'Bob' },
    })

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'put',
        url: `${RELAY_BASE_URL}/metadata/${identity.address.raw}`,
        headers: expect.objectContaining({
          'Content-Type': 'application/cbor',
          'Origin': 'http://frank.local',
        }),
      }),
    )
  })

  it('fetchMonadIdentityPubKey and fetchMonadProfile decode CBOR frames correctly', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const cborFrame = buildSignedDirectoryStatement(identity, {
      network: 'monad-testnet',
      profile: {
        name: 'Charlie',
        bio: 'Frank tester',
        bot: false,
        avatar: 'data:image/jpeg;base64,MTIzNA==',
      },
    })

    // Test fetchMonadIdentityPubKey
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(cborFrame),
      statusText: 'OK',
      headers: { 'content-type': 'application/cbor' },
      config: {},
    })
    const pubKey = await fetchMonadIdentityPubKey({
      relayBaseUrl: RELAY_BASE_URL,
      address: identity.address.raw,
    })
    expect(pubKey).toEqual(identity.compressedPubKey)

    // Test fetchMonadProfile
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(cborFrame),
      statusText: 'OK',
      headers: { 'content-type': 'application/cbor' },
      config: {},
    })
    const profile = await fetchMonadProfile({
      relayBaseUrl: RELAY_BASE_URL,
      address: identity.address,
    })
    expect(profile).toBeDefined()
    expect(profile?.name).toBe('Charlie')
    expect(profile?.bio).toBe('Frank tester')
    expect(profile?.avatar).toBe('data:image/jpeg;base64,MTIzNA==')
    expect(profile?.bot).toBeUndefined()
    expect(Buffer.from(profile!.pubKey)).toEqual(identity.compressedPubKey)
  })

  it('fetchMonadProfilesSince and searchMonadProfiles handle CBOR frames and populate rawBytes', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const cborFrame = buildSignedDirectoryStatement(identity, {
      network: 'monad-testnet',
      profile: { name: 'Dan', bot: true },
    })

    const entry = new ListMonadProfilesEntry()
    entry.setAddress(identity.address.raw)
    entry.setSignedPayload(cborFrame)

    const response = new ListMonadProfilesResponse()
    response.setEntriesList([entry])

    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(response.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const sinceResults = await fetchMonadProfilesSince({
      relayBaseUrl: RELAY_BASE_URL,
      sinceMs: 0,
    })

    expect(sinceResults).toHaveLength(1)
    expect(sinceResults[0].address).toBe(identity.address.raw)
    expect(sinceResults[0].rawBytes).toEqual(cborFrame)
    expect(isBotProfileSignedPayload(sinceResults[0].signedPayload)).toBe(true)
    expect(
      Buffer.from(sinceResults[0].signedPayload.getPublicKey_asU8()),
    ).toEqual(identity.compressedPubKey)

    // searchMonadProfiles
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(response.serializeBinary()),
      statusText: 'OK',
      headers: {},
      config: {},
    })

    const searchResults = await searchMonadProfiles({
      relayBaseUrl: RELAY_BASE_URL,
      prefix: 'dan',
    })

    expect(searchResults).toHaveLength(1)
    expect(searchResults[0].address).toBe(identity.address.raw)
    expect(searchResults[0].rawBytes).toEqual(cborFrame)
  })

  it('fails closed when CBOR frame has tampered signature', async () => {
    const identity = MonadIdentity.fromSeed(SEED)
    const cborFrame = buildSignedDirectoryStatement(identity, {
      network: 'monad-testnet',
      profile: { name: 'Eve' },
    })

    // Tamper with the last byte (part of signature)
    const tampered = new Uint8Array(cborFrame)
    tampered[tampered.length - 1] ^= 0xff

    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from(tampered),
      statusText: 'OK',
      headers: { 'content-type': 'application/cbor' },
      config: {},
    })

    await expect(
      fetchMonadIdentityPubKey({
        relayBaseUrl: RELAY_BASE_URL,
        address: identity.address.raw,
      }),
    ).rejects.toThrow()
  })
})
