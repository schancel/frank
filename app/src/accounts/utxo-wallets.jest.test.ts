const publicAccount = (accountId: string) => ({
  receipt: { context: { accountId } },
})
const mockState = {
  status: 'ready',
  account: publicAccount('account-a'),
  revision: 1,
}
const mockSessionCreateWallet = jest.fn()
jest.mock('./session', () => ({
  accountSession: {
    get state() {
      return mockState
    },
    createUtxoWallet: (relay: unknown) => mockSessionCreateWallet(relay),
  },
}))
const mockCreateWallet = jest.fn()
const mockClose = jest.fn(async () => undefined)
const mockOpenRelayUtxoChain = jest.fn(
  (params: { chainIdentifier: string }) => {
    let live = true
    return {
      chain: { chainIdentifier: params.chainIdentifier },
      createWallet: (root: Uint8Array) =>
        mockCreateWallet(params, Uint8Array.from(root)),
      assertActive: () => {
        if (!live) throw new Error('closed')
      },
      close: () => {
        live = false
        return mockClose()
      },
    }
  },
)
jest.mock('@frank/wallet/chain', () => ({
  loadMonadChainConfigFromEnv: () => ({
    relayBaseUrl: 'https://relay.invalid',
  }),
  openRelayUtxoChain: (params: { chainIdentifier: string }) =>
    mockOpenRelayUtxoChain(params),
}))

import { openUtxoWallet } from './utxo-wallets'

beforeEach(() => {
  jest.clearAllMocks()
  mockState.status = 'ready'
  mockState.account = publicAccount('account-a')
  mockState.revision += 1
  mockSessionCreateWallet.mockImplementation(relay =>
    relay.createWallet(new Uint8Array(32).fill(7)),
  )
  mockCreateWallet.mockImplementation(
    async (params: { chainIdentifier: string }) => ({
      chainIdentifier: params.chainIdentifier,
    }),
  )
})

it('opens one wallet per chain for the account, through the relay, through session custody', async () => {
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
    operationStoreFactory: expect.any(Function),
  })
  expect(mockSessionCreateWallet).toHaveBeenCalledTimes(2)
  expect(mockSessionCreateWallet.mock.calls[0][0]).toBe(
    mockOpenRelayUtxoChain.mock.results[0].value,
  )
})

it('does not hand one account the wallet of another', async () => {
  const first = await openUtxoWallet('btc-testnet')
  const closedBefore = mockClose.mock.calls.length
  mockState.account = publicAccount('account-b')
  const second = await openUtxoWallet('btc-testnet')
  expect(second).not.toBe(first)
  // The earlier account's connection is released.
  expect(mockClose).toHaveBeenCalledTimes(closedBefore + 1)
})

it('refuses a wallet whose account changed while it was opening', async () => {
  mockCreateWallet.mockImplementationOnce(async () => {
    mockState.account = publicAccount('account-b')
    return { chainIdentifier: 'btc-testnet' }
  })
  await expect(openUtxoWallet('btc-testnet')).rejects.toThrow('Account changed')
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

it('reopens the same account/revision after the session revoked its relay, without a new scope', async () => {
  const first = await openUtxoWallet('xec-testnet')
  const relay = mockOpenRelayUtxoChain.mock.results.at(-1)!.value
  await relay.close()
  const second = await openUtxoWallet('xec-testnet')
  expect(second).not.toBe(first)
  expect(mockSessionCreateWallet).toHaveBeenCalledTimes(2)
})

it('rejects a late open after its owner was revoked even when account scope is unchanged', async () => {
  let finish!: () => void
  let began!: () => void
  const started = new Promise<void>(resolve => {
    began = resolve
  })
  mockCreateWallet.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () => resolve({ chainIdentifier: 'xec-testnet' })
        began()
      }),
  )
  const opening = openUtxoWallet('xec-testnet')
  const rejected = expect(opening).rejects.toThrow('closed')
  await started
  await mockOpenRelayUtxoChain.mock.results.at(-1)!.value.close()
  finish()
  await rejected
  await expect(openUtxoWallet('xec-testnet')).resolves.toHaveProperty('wallet')
})

it('propagates owner cleanup failures when replacing an account cache entry', async () => {
  await openUtxoWallet('xec-testnet')
  mockState.account = publicAccount('cleanup-replacement')
  mockClose.mockRejectedValueOnce(new Error('cleanup failed'))
  await expect(openUtxoWallet('xec-testnet')).rejects.toThrow('cleanup failed')
})
