import { RelayProfileManager } from '../src/relay-profile-manager'
import * as monadIdentity from '@frank/wallet/monad-identity'

jest.mock('@frank/wallet/monad-identity', () => ({
  fetchMonadProfile: jest.fn(),
  registerMonadIdentity: jest.fn(),
  registerMonadIdentityCbor: jest.fn(),
}))

jest.mock('@frank/cashweb/relay/username-client', () => ({
  ...jest.requireActual('@frank/cashweb/relay/username-client'),
  claimUsername: jest.fn(),
}))
import {
  UsernameError,
  claimUsername,
} from '@frank/cashweb/relay/username-client'

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

  describe('username', () => {
    const register = (profile: { name: string; username?: string }) =>
      RelayProfileManager.registerProfile({
        relayBaseUrl: 'https://relay.example.com',
        identity: dummyIdentity,
        label: 'qwen',
        profile,
        network: 'monad-testnet',
      })

    beforeEach(() => {
      ;(monadIdentity.fetchMonadProfile as jest.Mock).mockResolvedValue({
        name: 'Qwen',
        bot: true,
      })
    })

    it('claims the bot id as its username, signed by the bot identity, even when the profile is already current', async () => {
      ;(claimUsername as jest.Mock).mockResolvedValueOnce({ username: 'qwen' })
      await register({ name: 'Qwen' })
      expect(claimUsername).toHaveBeenCalledWith({
        relayBaseUrl: 'https://relay.example.com',
        network: 'monad-testnet',
        signer: dummyIdentity,
        username: 'qwen',
      })
      expect(monadIdentity.registerMonadIdentityCbor).not.toHaveBeenCalled()
    })

    it('claims the username the profile names instead of the id', async () => {
      ;(claimUsername as jest.Mock).mockResolvedValueOnce({ username: 'ask' })
      await register({ name: 'Qwen', username: 'ask' })
      expect(claimUsername).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'ask' }),
      )
    })

    it('a taken or unreachable username is reported and the profile is still registered', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      ;(monadIdentity.fetchMonadProfile as jest.Mock).mockResolvedValue(undefined)
      for (const code of ['taken', 'unreachable'] as const) {
        ;(claimUsername as jest.Mock).mockRejectedValueOnce(
          new UsernameError(code),
        )
        await register({ name: 'Qwen' })
      }
      expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
        '[qwen] username @qwen is held by another account; this bot has no username',
        '[qwen] could not claim username @qwen: unreachable',
      ])
      expect(monadIdentity.registerMonadIdentityCbor).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    })

    it('claims nothing when no network is given', async () => {
      await RelayProfileManager.registerProfile({
        relayBaseUrl: 'https://relay.example.com',
        identity: dummyIdentity,
        label: 'qwen',
        profile: { name: 'Qwen' },
      })
      expect(claimUsername).not.toHaveBeenCalled()
    })
  })
})
