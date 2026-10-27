/** @jest-environment node */
// The live swap runtime's own dependencies and records.

const mockNamespaces: string[] = []
jest.mock('@frank/swap-protocol/src/storage/execution-browser', () => ({
  BrowserSwapExecutionStore: class {
    constructor(namespace: string) {
      mockNamespaces.push(namespace)
    }
    close = jest.fn()
  },
}))

import { activeChain, setActiveChain } from '@frank/wallet/chain'
import { TESTNET_NEGOTIATION_POLICY } from '@frank/swap-protocol/src/negotiation'
import { ChronikClient } from 'chronik-client'
import { startAppSwapExecution } from './live-swap-execution'

describe('the live swap execution store', () => {
  const previousChain = activeChain
  beforeEach(() => {
    mockNamespaces.length = 0
    setActiveChain({
      ...activeChain,
      chainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
    })
    ;(globalThis as { indexedDB?: unknown }).indexedDB = {}
  })
  afterEach(() => {
    setActiveChain(previousChain)
    delete (globalThis as { indexedDB?: unknown }).indexedDB
  })

  it("is named by the wallet's own address, so two accounts never share one", async () => {
    const start = (address: string) =>
      startAppSwapExecution({
        wallet: {
          chainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
          identity: { address: { raw: address }, displayAddress: address },
        } as never,
        revision: 1,
        account: {},
      })
    await (await start('0x1111111111111111111111111111111111111111')).stop()
    await (await start('0x2222222222222222222222222222222222222222')).stop()

    expect(mockNamespaces).toEqual([
      `${TESTNET_NEGOTIATION_POLICY.evmChainIdentifier}:0x1111111111111111111111111111111111111111:1`,
      `${TESTNET_NEGOTIATION_POLICY.evmChainIdentifier}:0x2222222222222222222222222222222222222222:1`,
    ])
  })

  // The eCash escrow is an ecash-wallet SDK wallet; it takes the Chronik client of the version
  // the wallet package uses, which is built from a list of endpoints.
  it('builds its Chronik client from a list of endpoints, as the eCash SDK expects', () => {
    expect(
      () =>
        new ChronikClient(['http://127.0.0.1:1/chain-rpc/xec-testnet/chronik']),
    ).not.toThrow()
  })
})
