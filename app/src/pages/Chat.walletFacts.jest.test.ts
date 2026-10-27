/** @jest-environment jsdom */
// The balance and network facts Chat.vue hands its composers come from the wallet and the
// chain registry, never a hard-coded network.

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))
jest.mock('../utils/messaging-state', () => ({
  messagingState: { status: 'ready' },
}))
jest.mock('../accounts/session', () => ({
  accountStatus: { revision: 1, status: 'ready' },
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => {
  const chain = {
    activeChain: {
      chainIdentifier: 'monad-testnet',
      fromDisplayAmount: (s: string) => BigInt(s),
      toDisplayAmount: (n: bigint) => n.toString(),
      unit: 'MON',
      nativeTransfers: { getBalance: jest.fn() },
      directMessages: { defaultStampQuote: jest.fn() },
    },
  }
  return { ...chain, getActiveChain: () => chain.activeChain }
})
jest.mock('@frank/wallet/chain/chains-registry', () => {
  const actual = jest.requireActual('@frank/wallet/chain/chains-registry')
  const entries: Record<string, unknown> = {
    'ethereum-sepolia': { nativeChainId: 11155111, nativeDecimals: 18 },
    'xec-testnet': { nativeDecimals: 2 },
  }
  return { ...actual, getChainConfig: (id: string) => entries[id] }
})
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => '0xMe',
  sameCanonicalAddress: (a: string, b: string) => a === b,
  useReactiveOwnCanonicalAddress: () => ({ value: '0xMe' }),
}))

import ChatPage from './Chat.vue'
import { activeChain } from '@frank/wallet/chain'

const computed = (
  ChatPage as unknown as {
    computed: Record<string, (this: Record<string, unknown>) => unknown>
  }
).computed

function setActiveChain(chainIdentifier: string) {
  ;(activeChain as { chainIdentifier: string }).chainIdentifier =
    chainIdentifier
}

describe('Chat.vue wallet facts', () => {
  it('offers the wallet balance as the available balance, and nothing while it is unknown', () => {
    expect(
      computed.availableBalanceWei.call({ activeWalletBalance: 5_000n }),
    ).toBe(5_000n)
    expect(computed.availableBalanceWei.call({ activeWalletBalance: 0n })).toBe(
      0n,
    )
    expect(
      computed.availableBalanceWei.call({ activeWalletBalance: null }),
    ).toBeUndefined()
  })

  it("names the selected network's own chain ID, never Monad's", () => {
    setActiveChain('ethereum-sepolia')
    expect(computed.activeNetworkId.call({})).toBe('11155111')
    expect(computed.activeNativeDecimals.call({})).toBe(18)
  })

  it('names a network without a native chain ID by its canonical identifier', () => {
    setActiveChain('xec-testnet')
    expect(computed.activeNetworkId.call({})).toBe('xec-testnet')
    expect(computed.activeNativeDecimals.call({})).toBe(2)
  })
})
