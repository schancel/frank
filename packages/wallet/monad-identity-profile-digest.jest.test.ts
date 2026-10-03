import { createHash } from 'crypto'

import axios from 'axios'

import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb

import {
  MonadIdentity,
  monadProfilePayloadDigest,
  registerMonadIdentity,
} from './monad-identity'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const SEED = {
  mnemonic: 'test test test test test test test test test test test junk',
}

it('hashes AddressMetadata with one SHA-256', async () => {
  const empty = Buffer.from(monadProfilePayloadDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )

  const sample = Uint8Array.from([0, 1, 2, 255, 16])
  const digest = Buffer.from(monadProfilePayloadDigest(sample))
  expect(digest.toString('hex')).toBe(
    createHash('sha256').update(sample).digest('hex'),
  )
  const doubled = createHash('sha256')
    .update(createHash('sha256').update(sample).digest())
    .digest('hex')
  expect(digest.toString('hex')).not.toBe(doubled)

  mockedAxios.mockResolvedValueOnce({
    status: 200,
    data: new Uint8Array(0),
    statusText: 'OK',
    headers: {},
    config: {},
  })
  await registerMonadIdentity({
    relayBaseUrl: 'http://relay.test',
    identity: MonadIdentity.fromSeed(SEED),
    profile: { bio: 'digest' },
  })
  const call = mockedAxios.mock.calls[0][0]
  const signed = SignedPayload.deserializeBinary(
    new Uint8Array(call.data as Buffer),
  )
  const payload = Buffer.from(signed.getPayload_asU8())
  const declared = Buffer.from(signed.getPayloadDigest_asU8())
  expect(declared.toString('hex')).toBe(
    createHash('sha256').update(payload).digest('hex'),
  )
  expect(declared).toEqual(Buffer.from(monadProfilePayloadDigest(payload)))
})
