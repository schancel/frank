const mockState = { status: 'ready', account: 'account-a', revision: 1 }
const mockGetRoot = jest.fn()
jest.mock('./session', () => ({
  accountSession: {
    get state() {
      return mockState
    },
    getActiveDomainRoot: (purpose: string) => mockGetRoot(purpose),
  },
}))
const mockCreateWallet = jest.fn()
const mockClose = jest.fn(async () => undefined)
const mockOpenRelayUtxoChain = jest.fn(
  (params: { chainIdentifier: string }) => ({
    chain: { chainIdentifier: params.chainIdentifier },
    createWallet: (root: Uint8Array) =>
      mockCreateWallet(params, Uint8Array.from(root)),
    close: mockClose,
  }),
)
jest.mock('@frank/wallet/chain', () => ({
  loadMonadChainConfigFromEnv: () => ({
    relayBaseUrl: 'https://relay.invalid',
  }),
  openRelayUtxoChain: (params: { chainIdentifier: string }) =>
    mockOpenRelayUtxoChain(params),
}))

import { openUtxoWallet } from './utxo-wallets'

let roots: Uint8Array[]
beforeEach(() => {
  jest.clearAllMocks()
  mockState.status = 'ready'
  mockState.account = 'account-a'
  mockState.revision += 1
  roots = []
  mockGetRoot.mockImplementation(async () => {
    const root = new Uint8Array(32).fill(7)
    roots.push(root)
    return root
  })
  mockCreateWallet.mockImplementation(
    async (params: { chainIdentifier: string }) => ({
      chainIdentifier: params.chainIdentifier,
    }),
  )
})

it('opens one wallet per chain for the account, through the relay, and clears the root', async () => {
  const [first, again, other] = await Promise.all([
    openUtxoWallet('btc-testnet'),
    openUtxoWallet('btc-testnet'),
    openUtxoWallet('xec-testnet'),
  ])
  expect(again).toBe(first)
  expect(first.wallet.chainIdentifier).toBe('btc-testnet')
  expect(other.wallet.chainIdentifier).toBe('xec-testnet')
  expect(mockOpenRelayUtxoChain).toHaveBeenCalledTimes(2)
  expect(mockOpenRelayUtxoChain).toHaveBeenCalledWith({
    chainIdentifier: 'btc-testnet',
    relayBaseUrl: 'https://relay.invalid',
  })
  expect(mockGetRoot).toHaveBeenCalledWith('ecash-bch-wallet')
  // The wallet saw the real root; the copy custody handed out is zero afterwards.
  expect(
    mockCreateWallet.mock.calls[0][1].every((byte: number) => byte === 7),
  ).toBe(true)
  expect(roots.every(root => root.every(byte => byte === 0))).toBe(true)
})

it('does not hand one account the wallet of another', async () => {
  const first = await openUtxoWallet('btc-testnet')
  const closedBefore = mockClose.mock.calls.length
  mockState.account = 'account-b'
  const second = await openUtxoWallet('btc-testnet')
  expect(second).not.toBe(first)
  // The earlier account's connection is released.
  expect(mockClose).toHaveBeenCalledTimes(closedBefore + 1)
})

it('refuses a wallet whose account changed while it was opening', async () => {
  mockCreateWallet.mockImplementationOnce(async () => {
    mockState.account = 'account-b'
    return { chainIdentifier: 'btc-testnet' }
  })
  await expect(openUtxoWallet('btc-testnet')).rejects.toThrow('Account changed')
  expect(roots[0].every(byte => byte === 0)).toBe(true)
})

it('retries after a failed open instead of caching the failure', async () => {
  mockCreateWallet.mockRejectedValueOnce(new Error('relay unreachable'))
  await expect(openUtxoWallet('bch-testnet')).rejects.toThrow(
    'relay unreachable',
  )
  await expect(openUtxoWallet('bch-testnet')).resolves.toMatchObject({
    wallet: { chainIdentifier: 'bch-testnet' },
  })
})

it('needs an open account', () => {
  mockState.status = 'locked'
  expect(() => openUtxoWallet('btc-testnet')).toThrow('No account is open')
})
