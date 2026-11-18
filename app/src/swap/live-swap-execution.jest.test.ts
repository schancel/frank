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
import {
  startAppSwapExecution,
  xecEscrowFundingObservation,
} from './live-swap-execution'

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

// Chronik's view of an eCash escrow address, as `script(...).history()` returns its txs.
describe('the funding of an eCash escrow', () => {
  const ESCROW = '76a914' + '11'.repeat(20) + '88ac'
  const OTHER = '76a914' + '22'.repeat(20) + '88ac'
  const PRINCIPAL = 25_000n
  const tx = (
    txid: string,
    height: number | undefined,
    outputs: [string, bigint][],
  ) => ({
    txid: txid.repeat(64 / txid.length),
    block: height === undefined ? undefined : { height, hash: 'bb'.repeat(32) },
    outputs: outputs.map(([outputScript, sats]) => ({ outputScript, sats })),
  })
  const observe = (
    history: ReturnType<typeof tx>[],
    unspentSats: bigint,
    tipHeight = 1000,
  ) =>
    xecEscrowFundingObservation({
      principalSats: PRINCIPAL,
      escrowOutputScript: ESCROW,
      tipHeight,
      history,
      unspentSats,
    })

  it('is unseen with no payment to the escrow', () => {
    expect(observe([], 0n)).toEqual({ status: 'unseen', confirmations: 0 })
    expect(observe([tx('a1', 990, [[OTHER, PRINCIPAL]])], 0n)).toEqual({
      status: 'unseen',
      confirmations: 0,
    })
  })

  it('is unseen while the payment is only in the mempool', () => {
    expect(
      observe([tx('a1', undefined, [[ESCROW, PRINCIPAL]])], PRINCIPAL),
    ).toEqual({
      status: 'unseen',
      txId: 'a1'.repeat(32),
      confirmations: 0,
      spent: false,
    })
  })

  it('reports the depth of the funding block, final only at 10', () => {
    expect(
      observe([tx('a1', 998, [[ESCROW, PRINCIPAL]])], PRINCIPAL),
    ).toMatchObject({
      status: 'included',
      confirmations: 3,
      blockHeight: 998,
      spent: false,
    })
    expect(
      observe([tx('a1', 991, [[ESCROW, PRINCIPAL]])], PRINCIPAL),
    ).toMatchObject({ status: 'final', confirmations: 10 })
    expect(
      observe([tx('a1', 900, [[ESCROW, PRINCIPAL]])], PRINCIPAL),
    ).toMatchObject({ status: 'final', confirmations: 101 })
  })

  it('does not count less than the principal, and dates it by the payment that completed it', () => {
    expect(
      observe([tx('a1', 950, [[ESCROW, PRINCIPAL - 1n]])], PRINCIPAL - 1n),
    ).toEqual({ status: 'unseen', confirmations: 0 })
    // Newest first, as Chronik lists history.
    expect(
      observe(
        [
          tx('a2', 996, [[ESCROW, 5_000n]]),
          tx('a1', 950, [
            [ESCROW, 20_000n],
            [OTHER, 1n],
          ]),
        ],
        PRINCIPAL,
      ),
    ).toMatchObject({
      status: 'included',
      confirmations: 5,
      txId: 'a2'.repeat(32),
    })
  })

  it('reports an escrow swept after its funding as spent, with the funding depth', () => {
    const sweep = tx('c1', 999, [[OTHER, PRINCIPAL - 300n]])
    expect(observe([sweep, tx('a1', 980, [[ESCROW, PRINCIPAL]])], 0n)).toEqual({
      status: 'final',
      txId: 'a1'.repeat(32),
      confirmations: 21,
      blockHeight: 980,
      blockHash: 'bb'.repeat(32),
      spent: true,
    })
    // Swept before it is deep: still only `included`, never `final`.
    expect(
      observe([sweep, tx('a1', 998, [[ESCROW, PRINCIPAL]])], 0n),
    ).toMatchObject({ status: 'included', confirmations: 3, spent: true })
  })
})
