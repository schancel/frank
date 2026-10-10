jest.mock('@frank/cashweb/relay/username-client', () => ({
  ...jest.requireActual('@frank/cashweb/relay/username-client'),
  claimUsername: jest.fn(),
  usernamesOfAddresses: jest.fn(),
}))
// username-claim pulls in the wallet composable, which needs a browser account session.
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

import {
  UsernameError,
  claimUsername,
  usernamesOfAddresses,
} from '@frank/cashweb/relay/username-client'
import {
  clearOwnUsername,
  ownUsername,
  setOwnUsername,
  syncOwnUsername,
} from './own-username'

const ADDRESS = '0xAbAbababABabABabABABabABabAbabABabAbABab'
const signer = {
  compressedPubKey: new Uint8Array(33),
  signHash: () => new Uint8Array(),
}
const options = (saved?: string) => ({
  relayBaseUrl: 'http://relay.test',
  network: 'monad-testnet',
  signer,
  address: ADDRESS,
  saved,
})
const holds = (username: string) => [
  { username, address: ADDRESS.toLowerCase(), subject: '02' },
]

describe('own username', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearOwnUsername()
  })

  it('a saved name the relay gives back is the held name', async () => {
    ;(claimUsername as jest.Mock).mockResolvedValue({ username: 'alice' })
    await syncOwnUsername(options('alice'))
    expect(claimUsername).toHaveBeenCalledWith({
      relayBaseUrl: 'http://relay.test',
      network: 'monad-testnet',
      signer,
      username: 'alice',
    })
    expect(ownUsername).toEqual({ held: 'alice', wanted: null, problem: null })
  })

  it('a saved name someone else now holds is not shown as held, and the reason is kept', async () => {
    setOwnUsername('alice')
    ;(claimUsername as jest.Mock).mockRejectedValue(new UsernameError('taken'))
    ;(usernamesOfAddresses as jest.Mock).mockResolvedValue([])
    await syncOwnUsername(options('alice'))
    expect(ownUsername).toEqual({
      held: null,
      wanted: 'alice',
      problem: 'profile.usernameTaken',
    })
  })

  it('when the saved name is refused but the account holds another, that one is the held name', async () => {
    ;(claimUsername as jest.Mock).mockRejectedValue(
      new UsernameError('stale-claim'),
    )
    ;(usernamesOfAddresses as jest.Mock).mockResolvedValue(holds('alicia'))
    await syncOwnUsername(options('alice'))
    expect(usernamesOfAddresses).toHaveBeenCalledWith({
      relayBaseUrl: 'http://relay.test',
      addresses: [ADDRESS.toLowerCase()],
    })
    expect(ownUsername).toEqual({
      held: 'alicia',
      wanted: 'alice',
      problem: 'profile.usernameUnavailable',
    })
  })

  it('with no saved name, the held name is whatever the relay says the account holds', async () => {
    ;(usernamesOfAddresses as jest.Mock).mockResolvedValue(holds('alice'))
    await syncOwnUsername(options())
    expect(claimUsername).not.toHaveBeenCalled()
    expect(ownUsername).toEqual({ held: 'alice', wanted: null, problem: null })
  })

  it('an unreachable relay leaves what was known and records the problem', async () => {
    setOwnUsername('alice')
    ;(claimUsername as jest.Mock).mockRejectedValue(
      new UsernameError('unreachable'),
    )
    ;(usernamesOfAddresses as jest.Mock).mockRejectedValue(
      new UsernameError('unreachable'),
    )
    await syncOwnUsername(options('alice'))
    expect(ownUsername).toEqual({
      held: 'alice',
      wanted: 'alice',
      problem: 'profile.usernameUnavailable',
    })
  })
})
