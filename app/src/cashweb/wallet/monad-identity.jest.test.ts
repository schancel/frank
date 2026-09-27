/**
 * Unit tests for `monad-identity.ts` (ticket #41): `MonadIdentity`'s address/key derivation, and
 * `registerMonadIdentity`/`fetchMonadIdentityPubKey`/`fetchMonadProfile`'s `PUT`/`GET
 * /metadata/:addr` wiring. `axios` is mocked here (mirroring `monad-stamp-client.jest.test.ts`'s
 * own convention) since this file -- unlike `../chain/monad-chain.ts` -- *is* the HTTP client
 * layer being tested.
 */
import axios from 'axios'

import { SignedPayload } from '../signed_payload/payload_pb'
import {
  MONAD_IDENTITY_DERIVATION_PATH,
  MonadIdentity,
  fetchMonadIdentityPubKey,
  fetchMonadProfile,
  registerMonadIdentity,
} from './monad-identity'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const RELAY_BASE_URL = 'http://relay.test'
const SEED = {
  mnemonic: 'test test test test test test test test test test test junk',
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
})
