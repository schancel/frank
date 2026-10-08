import { RelayProfileManager } from '../src/relay-profile-manager'
import * as monadIdentity from '@frank/wallet/monad-identity'

jest.mock('@frank/wallet/monad-identity', () => ({
  fetchMonadProfile: jest.fn(),
  registerMonadIdentity: jest.fn(),
  registerMonadIdentityCbor: jest.fn(),
}))

describe('RelayProfileManager', () => {
  const dummyIdentity = {
    address: '0x1111111111111111111111111111111111111111',
    displayAddress: 'monad:0x1111...1111',
  } as any

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('skips registration when profile on relay is already current', async () => {
    ;(monadIdentity.fetchMonadProfile as jest.Mock).mockResolvedValueOnce({
      name: 'Bot Name',
      bio: 'Bot Bio',
      bot: true,
    })

    await RelayProfileManager.registerProfile({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      label: 'TestBot',
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        bot: true,
      },
    })

    expect(monadIdentity.fetchMonadProfile).toHaveBeenCalledWith({
      relayBaseUrl: 'https://relay.example.com',
      address: dummyIdentity.address,
    })
    expect(monadIdentity.registerMonadIdentityCbor).not.toHaveBeenCalled()
  })

  it('registers profile when relay profile differs', async () => {
    ;(monadIdentity.fetchMonadProfile as jest.Mock).mockResolvedValueOnce({
      name: 'Old Name',
      bio: 'Bot Bio',
      bot: true,
    })
    ;(
      monadIdentity.registerMonadIdentityCbor as jest.Mock
    ).mockResolvedValueOnce({})

    await RelayProfileManager.registerProfile({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      label: 'TestBot',
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        bot: true,
      },
    })

    expect(monadIdentity.fetchMonadProfile).toHaveBeenCalledTimes(1)
    expect(monadIdentity.registerMonadIdentityCbor).toHaveBeenCalledWith({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        avatar: undefined,
        bot: true,
      },
    })
  })

  it('registers profile when fetchMonadProfile throws', async () => {
    ;(monadIdentity.fetchMonadProfile as jest.Mock).mockRejectedValueOnce(
      new Error('Relay down or profile 404'),
    )
    ;(
      monadIdentity.registerMonadIdentityCbor as jest.Mock
    ).mockResolvedValueOnce({})

    await RelayProfileManager.registerProfile({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      label: 'TestBot',
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
      },
    })

    expect(monadIdentity.fetchMonadProfile).toHaveBeenCalledTimes(1)
    expect(monadIdentity.registerMonadIdentityCbor).toHaveBeenCalledTimes(1)
  })

  it('forces registration without fetching when force: true is specified', async () => {
    ;(
      monadIdentity.registerMonadIdentityCbor as jest.Mock
    ).mockResolvedValueOnce({})

    await RelayProfileManager.registerProfile({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      label: 'TestBot',
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        bot: true,
      },
      force: true,
    })

    expect(monadIdentity.fetchMonadProfile).not.toHaveBeenCalled()
    expect(monadIdentity.registerMonadIdentityCbor).toHaveBeenCalledWith({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        avatar: undefined,
        bot: true,
      },
    })
  })

  it('converts Uint8Array avatar to base64 data url', async () => {
    ;(
      monadIdentity.registerMonadIdentityCbor as jest.Mock
    ).mockResolvedValueOnce({})
    const avatarBytes = new Uint8Array([1, 2, 3, 4])

    await RelayProfileManager.registerProfile({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      label: 'TestBot',
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        avatarPng: avatarBytes,
      },
      force: true,
    })

    expect(monadIdentity.registerMonadIdentityCbor).toHaveBeenCalledWith({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        avatar: 'data:image/png;base64,AQIDBA==',
        bot: true,
      },
    })
  })

  it('falls back to protobuf registerMonadIdentity when registerMonadIdentityCbor fails', async () => {
    ;(
      monadIdentity.registerMonadIdentityCbor as jest.Mock
    ).mockRejectedValueOnce(new Error('CBOR unsupported'))
    ;(
      monadIdentity.registerMonadIdentity as jest.Mock
    ).mockResolvedValueOnce({})

    await RelayProfileManager.registerProfile({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      label: 'TestBot',
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        bot: true,
      },
      force: true,
    })

    expect(monadIdentity.registerMonadIdentityCbor).toHaveBeenCalledTimes(1)
    expect(monadIdentity.registerMonadIdentity).toHaveBeenCalledWith({
      relayBaseUrl: 'https://relay.example.com',
      identity: dummyIdentity,
      profile: {
        name: 'Bot Name',
        bio: 'Bot Bio',
        avatar: undefined,
        bot: true,
      },
    })
  })
})

