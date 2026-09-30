import { inflateSync } from 'zlib'

import {
  fetchMonadProfile,
  MonadIdentity,
  registerMonadIdentity,
} from '@frank/wallet/monad-identity'
import { validateProfileDisplayName } from '@frank/wallet/profile-display-name'

import {
  BOT_PROFILES,
  botProfileFields,
  generateAvatarPng,
} from './bot-directory'
import {
  botCuratedEntries,
  renderCuratedDefaultsToml,
} from './print-curated-defaults'
import { profileMatches, registerAndLog } from './qwen-bot-common'

jest.mock('@frank/wallet/monad-identity', () => ({
  ...jest.requireActual('@frank/wallet/monad-identity'),
  fetchMonadProfile: jest.fn(),
  registerMonadIdentity: jest.fn(),
}))
const mockFetch = fetchMonadProfile as jest.Mock
const mockRegister = registerMonadIdentity as jest.Mock

describe('bot profiles (#317)', () => {
  it('gives every bot a valid, distinct display name, a bio and the bot marker', () => {
    const names = BOT_PROFILES.map(spec => spec.name)
    expect(names).toEqual([
      'Blackjack Dealer',
      'Raffle',
      'Picture Shop',
      'Qwen',
    ])
    for (const spec of BOT_PROFILES) {
      expect(validateProfileDisplayName(spec.name).normalized).toBe(spec.name)
      const fields = botProfileFields(spec.key)
      expect(fields).toMatchObject({ name: spec.name, bot: true })
      expect(fields.bio?.length).toBeGreaterThan(10)
    }
    expect(new Set(names).size).toBe(names.length)
  })

  it('generates a small, valid, deterministic PNG avatar per bot', () => {
    const avatars = BOT_PROFILES.map(spec =>
      generateAvatarPng(spec.key, spec.accent),
    )
    for (const png of avatars) {
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
      expect(png.length).toBeLessThan(2048)
      // IHDR then IDAT that inflates to exactly 60 rows of (1 filter + 60*3) bytes.
      expect(png.readUInt32BE(16)).toBe(60)
      expect(png.readUInt32BE(20)).toBe(60)
      const idatLen = png.readUInt32BE(33)
      expect(png.subarray(37, 41).toString()).toBe('IDAT')
      expect(inflateSync(png.subarray(41, 41 + idatLen)).length).toBe(
        60 * (1 + 60 * 3),
      )
      expect(png.subarray(-8, -4).toString()).toBe('IEND')
    }
    expect(new Set(avatars.map(png => png.toString('hex'))).size).toBe(4)
    expect(generateAvatarPng('qwen', BOT_PROFILES[3].accent)).toEqual(
      avatars[3],
    )
  })
})

describe('registerAndLog idempotency (#317)', () => {
  const identity = MonadIdentity.generate()
  const profile = botProfileFields('vendor')
  const remote = {
    address: identity.address,
    pubKey: new Uint8Array(33),
    name: profile.name,
    bio: profile.bio,
    avatar: profile.avatar,
    bot: true,
  }
  const call = () =>
    registerAndLog({
      relayBaseUrl: 'http://relay.test',
      identity,
      label: 'test',
      profile,
    })

  beforeEach(() => {
    mockFetch.mockReset()
    mockRegister.mockReset()
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  it('registers name, bio, avatar and the bot marker when nothing is registered', async () => {
    mockFetch.mockResolvedValue(undefined)
    await call()
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister.mock.calls[0][0].profile).toMatchObject({
      name: 'Picture Shop',
      bot: true,
      avatar: expect.stringMatching(/^data:image\/png;base64,/),
    })
  })

  it('does not re-register (no new registration timestamp) when the profile is unchanged', async () => {
    mockFetch.mockResolvedValue(remote)
    await call()
    await call()
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('re-registers when any field differs, including a pre-marker bot profile', async () => {
    for (const changed of [
      { ...remote, name: 'Old name' },
      { ...remote, bio: 'old' },
      { ...remote, avatar: undefined },
      { ...remote, bot: undefined },
    ]) {
      mockRegister.mockClear()
      mockFetch.mockResolvedValue(changed)
      await call()
      expect(mockRegister).toHaveBeenCalledTimes(1)
    }
  })

  it('profileMatches treats absent and empty fields alike', () => {
    expect(
      profileMatches(
        { address: identity.address, pubKey: new Uint8Array(1) },
        { bot: false },
      ),
    ).toBe(true)
  })
})

describe('curated defaults for the relay config (#317)', () => {
  it('lists every bot, in order, from each bot identity file, and only address+name', () => {
    const paths: Array<[string, string]> = []
    const entries = botCuratedEntries(
      { RAFFLE_BOT_IDENTITY_JSON: '/custom/raffle.json' },
      (path, label) => {
        paths.push([label, path])
        return {
          displayAddress: `0x${label.length.toString(16).padStart(40, '0')}`,
        }
      },
    )
    expect(entries.map(e => e.name)).toEqual([
      'Blackjack Dealer',
      'Raffle',
      'Picture Shop',
      'Qwen',
    ])
    expect(paths.map(([label]) => label)).toEqual([
      'blackjack',
      'raffle',
      'vendor',
      'qwen',
    ])
    expect(paths[0][1]).toBe('/tmp/blackjack-bot-identity.json')
    expect(paths[1][1]).toBe('/custom/raffle.json')
    expect(Object.keys(entries[0])).toEqual(['address', 'name'])
  })

  it('renders the relay config blocks (registry.curated_defaults) with escaped names', () => {
    expect(
      renderCuratedDefaultsToml([
        { address: '0xabc', name: 'Picture Shop' },
        { address: '0xdef', name: 'A "quoted" \\ name' },
      ]),
    ).toBe(
      '[[registry.curated_defaults]]\naddress = "0xabc"\nname = "Picture Shop"\n\n' +
        '[[registry.curated_defaults]]\naddress = "0xdef"\nname = "A \\"quoted\\" \\\\ name"\n',
    )
  })
})
