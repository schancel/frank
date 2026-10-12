import axios from 'axios'
import { usernamesOfAddresses } from '@frank/cashweb/relay/username-client'
import {
  MonadIdentity,
  buildSignedDirectoryStatement,
} from '@frank/wallet/monad-identity'
import {
  PendingProfilePreviewError,
  readPendingProfilePreview,
} from './pending-profile-preview'

jest.mock('axios')
jest.mock('@frank/cashweb/relay/username-client', () => ({
  usernamesOfAddresses: jest.fn(),
}))

const identity = MonadIdentity.fromPrivateKeyHex('0x' + '02'.repeat(32))
const other = MonadIdentity.fromPrivateKeyHex('0x' + '03'.repeat(32))
const relayBaseUrl = 'https://relay.example.test'
const read = () =>
  readPendingProfilePreview({
    relayBaseUrl,
    address: identity.address.raw,
  })

beforeEach(() => {
  jest.mocked(axios).mockReset()
  jest.mocked(usernamesOfAddresses).mockReset()
})

test('shows the signed display name and the username currently held by this address', async () => {
  jest.mocked(axios).mockResolvedValueOnce({
    data: buildSignedDirectoryStatement(identity, {
      network: 'monad-testnet',
      profile: { name: 'Alice', username: 'stale-claim' },
    }),
  })
  jest.mocked(usernamesOfAddresses).mockResolvedValueOnce([
    {
      username: 'alice-current',
      address: identity.address.raw.toLowerCase(),
      subject: '',
    },
  ])
  await expect(read()).resolves.toEqual({
    name: 'Alice',
    username: 'alice-current',
  })
  expect(usernamesOfAddresses).toHaveBeenCalledWith(
    expect.objectContaining({ addresses: [identity.address.raw] }),
  )
})

test('404 leaves the address-only confirmation and makes no username request', async () => {
  const missing = Object.assign(new Error('missing'), {
    response: { status: 404 },
  })
  jest.mocked(axios).mockRejectedValueOnce(missing)
  jest.mocked(axios.isAxiosError).mockReturnValueOnce(true)
  await expect(read()).resolves.toBeUndefined()
  expect(usernamesOfAddresses).not.toHaveBeenCalled()
})

test('rejects a valid signed profile for a different address', async () => {
  jest.mocked(axios).mockResolvedValueOnce({
    data: buildSignedDirectoryStatement(other, {
      network: 'monad-testnet',
      profile: { name: 'Impostor' },
    }),
  })
  await expect(read()).rejects.toMatchObject({
    code: 'unverified',
  } satisfies Partial<PendingProfilePreviewError>)
  expect(usernamesOfAddresses).not.toHaveBeenCalled()
})

test('rejects a signed profile from another canonical network', async () => {
  jest.mocked(axios).mockResolvedValueOnce({
    data: buildSignedDirectoryStatement(identity, {
      network: 'monad-mainnet',
      profile: { name: 'Wrong network' },
    }),
  })
  await expect(read()).rejects.toMatchObject({ code: 'unverified' })
  expect(usernamesOfAddresses).not.toHaveBeenCalled()
})

test('does not show unverified legacy bytes or names when username registry is offline', async () => {
  jest.mocked(axios).mockResolvedValueOnce({ data: new Uint8Array([1, 2, 3]) })
  await expect(read()).rejects.toMatchObject({ code: 'unverified' })
  jest.mocked(axios).mockResolvedValueOnce({
    data: buildSignedDirectoryStatement(identity, {
      network: 'monad-testnet',
      profile: { name: 'Alice' },
    }),
  })
  jest.mocked(usernamesOfAddresses).mockRejectedValueOnce(new Error('offline'))
  await expect(read()).rejects.toMatchObject({ code: 'unreachable' })
})
