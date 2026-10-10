/** @jest-environment jsdom */
/**
 * The swap form's states. The node is canned at the JSON-RPC seam and the wallet is a recorder;
 * the same quote and execution code against the real network is
 * `packages/wallet/swap/*.livecheck.ts`.
 */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { getEvmDexDeployment } from '@frank/wallet/chain/dex-deployments'
import {
  callRevert,
  cannedNode,
  tooLittleReceived,
} from '@frank/wallet/swap/swap-reader.testutil'
import { findToken, poolId, routesFor } from '@frank/wallet/swap/uniswap-v4'
import vectors from '@frank/wallet/swap/monad-testnet-swap-vectors.json'
import en from '../../i18n/en-us'
import fr from '../../i18n/fr-fr'
import type { SwapRecord } from '../../stores/swaps'

enableAutoUnmount(afterEach)

const deployment = getEvmDexDeployment('monad-testnet')!
const MON = findToken(deployment, 'MON')!
const USDC = findToken(deployment, 'USDC')!
const account = vectors.account
const E18 = 10n ** 18n

const mockOpen = jest.fn()
const mockSaved: SwapRecord[] = []
let mockStorageFull = false
const mockHistory = ref<SwapRecord[]>([])
jest.mock('src/swap/evm-swap-session', () => {
  class EvmSwapUnavailableError extends Error {
    constructor(readonly reason: string) {
      super(reason)
    }
  }
  return {
    EvmSwapUnavailableError,
    openEvmSwapSession: (...args: unknown[]) => mockOpen(...args),
  }
})
jest.mock('src/composables/useSwapHistory', () => ({
  useSwapHistory: () => ({
    getSwapsForChain: () => mockHistory,
    saveLocal: (record: SwapRecord) => {
      if (mockStorageFull) throw new Error('QuotaExceededError')
      mockSaved.push(JSON.parse(JSON.stringify(record)))
    },
  }),
}))
jest.mock('src/utils/explorer', () => ({
  getExplorerUrl: (hash: string) => `https://explorer.test/tx/${hash}`,
}))

import EvmSwapPanel from './EvmSwapPanel.vue'

const translate =
  (locale: typeof en | typeof fr) =>
  (key: string, params: Record<string, unknown> = {}) => {
    const text = key
      .split('.')
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === 'object'
            ? (value as Record<string, unknown>)[part]
            : undefined,
        locale,
      )
    return typeof text === 'string'
      ? text.replace(/\{(\w+)\}/g, (_all, name) => String(params[name] ?? ''))
      : key
  }
const passthrough = (name: string) => [
  name,
  { template: '<div><slot /></div>' },
]
const stubs = {
  QBtn: {
    props: ['disable', 'label', 'loading'],
    template: '<button :disabled="disable || loading">{{ label }}</button>',
  },
  QInput: {
    props: ['modelValue', 'disable'],
    template:
      '<input :value="modelValue" :disabled="disable" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  QSelect: {
    props: ['modelValue', 'options', 'disable'],
    template:
      '<select :value="modelValue" :disabled="disable" @change="$emit(\'update:modelValue\', Number($event.target.value))"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
  },
  ...Object.fromEntries(
    [
      'q-card',
      'q-icon',
      'q-separator',
      'q-skeleton',
      'q-spinner',
      'q-linear-progress',
    ].map(passthrough),
  ),
}

function scene(
  options: {
    mainBalance?: bigint
    usdc?: bigint
    other?: bigint
    feeBps?: number
  } = {},
) {
  const venue = options.feeBps
    ? {
        ...deployment,
        interfaceFee: {
          bps: options.feeBps,
          recipient: '0x1A63C39618d00e386B8872BF390DBCfEB6619Db5',
        },
      }
    : deployment
  const canned = cannedNode(deployment)
  canned.node.nativeBalance = options.mainBalance ?? E18
  canned.node.tokenBalance.set(
    USDC.address!.toLowerCase(),
    options.usdc ?? 5_000_000n,
  )
  // 1 MON = 1.0005 USDC at mid price; the quoter pays 4 units less than 1:1.
  canned.node.pools.set(
    poolId(routesFor(deployment, MON, USDC)[0]!.key).toLowerCase(),
    {
      sqrtPriceX96: 79248805082736432488342n,
      liquidity: 95902508421861n,
      lpFee: 500,
      quote: (amountIn, zeroForOne) =>
        (zeroForOne ? amountIn / 10n ** 12n : amountIn * 10n ** 12n) - 4n,
    },
  )
  const receipts = new Map<string, unknown>()
  const events: string[] = []
  const wallet = {
    sendContractCall: jest.fn(
      async (params: {
        data: string
        onSigned?: (s: { operationId: string; txHash: string }) => Promise<void>
      }) => {
        const handle = {
          operationId: `op-${wallet.sendContractCall.mock.calls.length}`,
          txHash: `0xhash${wallet.sendContractCall.mock.calls.length}`,
        }
        await params.onSigned?.(handle)
        events.push(
          `broadcast ${handle.txHash} after ${mockSaved.length} saved`,
        )
        return handle
      },
    ),
    getContractCallFunds: jest.fn(async () => ({
      mainAddress: account.toLowerCase(),
      mainBalance: canned.node.nativeBalance,
      otherBalance: options.other ?? 0n,
      mainBusy: false,
    })),
    fundMainAccount: jest.fn(),
    resumeNativeOperation: jest.fn(),
    getUnresolvedContractCalls: jest.fn(
      () => [] as { operationId: string; txHash: string }[],
    ),
    reobserveNativeOperations: jest.fn(async () => undefined),
  }
  let current = true
  mockOpen.mockResolvedValue({
    chainIdentifier: 'monad-testnet',
    deployment: venue,
    account,
    reader: {
      ...canned.reader,
      call: (tx: Parameters<typeof canned.reader.call>[0]) =>
        canned.reader.call(tx),
      estimateGas: (tx: Parameters<typeof canned.reader.estimateGas>[0]) =>
        canned.reader.estimateGas(tx),
      getTransactionReceipt: async (hash: string) => receipts.get(hash) ?? null,
      getTransaction: async () => ({}),
    },
    wallet,
    isCurrent: () => current,
  })
  return {
    ...canned,
    wallet,
    receipts,
    events,
    signOut: () => {
      current = false
    },
  }
}

async function mountPanel(locale: typeof en | typeof fr = en) {
  const view = mount(EvmSwapPanel, {
    props: {
      chainIdentifier: 'monad-testnet',
      walletId: 'monad',
      venueId: 'uniswap-v4',
    },
    global: { mocks: { $t: translate(locale) }, stubs },
  })
  await flushPromises()
  return view
}
const text = (view: Awaited<ReturnType<typeof mountPanel>>, id: string) =>
  view.get(`[data-testid="${id}"]`).text()
async function type(
  view: Awaited<ReturnType<typeof mountPanel>>,
  amount: string,
) {
  await view.get('[data-testid="swap-pay-amount"]').setValue(amount)
  jest.advanceTimersByTime(400)
  await flushPromises()
}
const click = async (
  view: Awaited<ReturnType<typeof mountPanel>>,
  id: string,
) => {
  await view.get(`[data-testid="${id}"]`).trigger('click')
  await flushPromises()
}
const receipt = (
  vector: { logs: unknown[] },
  status = 1,
): Record<string, unknown> => ({
  status,
  blockNumber: 1,
  gasUsed: 260_000n,
  gasPrice: 102n * 10n ** 9n,
  logs: vector.logs,
})

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
  jest.setSystemTime(1_800_000_000_000)
  mockSaved.length = 0
  mockStorageFull = false
  mockHistory.value = []
  mockOpen.mockReset()
})
afterEach(() => {
  jest.useRealTimers()
})

describe('the swap form', () => {
  it('names the venue honestly and shows balances read from the chain', async () => {
    scene()
    const view = await mountPanel()
    expect(text(view, 'swap-venue')).toBe('Uniswap v4')
    expect(text(view, 'swap-venue-note')).toBe(
      'Testnet deployment run by Monad, not by Uniswap Labs',
    )
    expect(text(view, 'swap-pay-balance')).toBe('Available: 1 MON')
    expect(text(view, 'swap-receive-balance')).toBe('Balance: 5 USDC')
    expect(view.find('[data-testid="swap-details"]').exists()).toBe(false)
    expect(text(view, 'swap-review-btn')).toBe('Enter an amount')
    expect(
      view.get('[data-testid="swap-review-btn"]').attributes('disabled'),
    ).toBeDefined()
    expect(view.text()).not.toMatch(/AVU|8\.75|MetaMask/)
  })

  it('shows what the quoter answered for the typed amount, with fee, impact and minimum', async () => {
    scene()
    const view = await mountPanel()
    await type(view, '0.02')
    expect(text(view, 'swap-receive-amount')).toBe('0.019996')
    expect(text(view, 'swap-rate')).toBe('1 MON ≈ 0.9998 USDC')
    expect(text(view, 'swap-price-impact')).toBe('0.02%')
    expect(text(view, 'swap-pool-fee')).toBe('0.05%')
    expect(text(view, 'swap-minimum-received')).toBe('0.019896 USDC')
    // 200,000 gas estimated, plus a fifth, at a 100 gwei fee cap.
    expect(text(view, 'swap-network-fee')).toBe('up to 0.024 MON')
    expect(text(view, 'swap-review-btn')).toBe('Review swap')
  })

  it('recomputes the minimum when the slippage setting changes', async () => {
    scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-slippage-100')
    expect(text(view, 'swap-minimum-received')).toBe('0.019796 USDC')
    await view.get('[data-testid="swap-slippage-custom"]').setValue('2.5')
    expect(text(view, 'swap-minimum-received')).toBe('0.019496 USDC')
    await view.get('[data-testid="swap-slippage-custom"]').setValue('80')
    expect(
      view.get('[data-testid="swap-review-btn"]').attributes('disabled'),
    ).toBeDefined()
  })

  it('never shows a quote beside an amount it was not made for', async () => {
    scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await view.get('[data-testid="swap-pay-amount"]').setValue('0.05')
    expect(view.find('[data-testid="swap-details"]').exists()).toBe(false)
    expect(view.find('[data-testid="swap-receive-amount"]').exists()).toBe(
      false,
    )
    jest.advanceTimersByTime(400)
    await flushPromises()
    expect(text(view, 'swap-receive-amount')).toBe('0.049996')
  })

  it('keeps a quote on screen current', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    s.node.pools.forEach(pool => {
      pool.quote = amountIn => amountIn / 10n ** 12n - 104n
    })
    jest.advanceTimersByTime(6_000)
    await flushPromises()
    expect(text(view, 'swap-receive-amount')).toBe('0.019896')
  })

  it('says plainly when the balance is too small, and blocks the swap', async () => {
    scene({ mainBalance: 10n ** 16n })
    const view = await mountPanel()
    await type(view, '0.02')
    expect(text(view, 'swap-problem')).toBe('Not enough MON')
    expect(text(view, 'swap-review-btn')).toBe('Not enough MON')
    expect(
      view.get('[data-testid="swap-review-btn"]').attributes('disabled'),
    ).toBeDefined()
  })

  it('counts the network fee against the native balance', async () => {
    scene({ mainBalance: 3n * 10n ** 16n })
    const view = await mountPanel()
    await type(view, '0.02')
    expect(text(view, 'swap-problem')).toBe(
      'Not enough MON for this amount plus the network fee',
    )
  })

  it('says other accounts of the wallet can cover a shortfall in the main account', async () => {
    scene({ mainBalance: 10n ** 16n, other: E18 })
    const view = await mountPanel()
    await type(view, '0.02')
    expect(text(view, 'swap-other-accounts')).toContain('1 MON more')
    expect(view.find('[data-testid="swap-problem"]').exists()).toBe(false)
  })

  it('says plainly when the pool cannot fill the amount or the pair has no pool', async () => {
    const s = scene()
    s.node.pools.forEach(pool => {
      pool.quote = () => {
        throw callRevert()
      }
    })
    const view = await mountPanel()
    await type(view, '0.5')
    expect(text(view, 'swap-problem')).toBe(
      'The pool cannot fill this amount. Try a smaller amount.',
    )
    await view.get('[data-testid="swap-pay-token"]').setValue('1')
    await view.get('[data-testid="swap-receive-token"]').setValue('2')
    await type(view, '1')
    expect(text(view, 'swap-problem')).toBe(
      'These two tokens cannot be swapped here.',
    )
  })

  it('says when a token needs approving first, for the exact amount', async () => {
    scene()
    const view = await mountPanel()
    await click(view, 'swap-flip-btn')
    await type(view, '0.015')
    expect(text(view, 'swap-receive-amount')).toBe('0.014999')
    expect(text(view, 'swap-approval-needed')).toContain(
      '2 approval transaction(s) first, for exactly this USDC amount',
    )
    expect(text(view, 'swap-network-fee')).toBe('estimated once approved')
  })

  it('reports a quote the node could not give without inventing one', async () => {
    const s = scene()
    const view = await mountPanel()
    s.reader.call = () => Promise.reject(new Error('socket hang up'))
    await type(view, '0.02')
    expect(text(view, 'swap-problem')).toBe(
      'Could not get a price from the network. Try again.',
    )
    expect(view.find('[data-testid="swap-details"]').exists()).toBe(false)
  })

  it('is in French when the app is', async () => {
    scene()
    const view = await mountPanel(fr)
    await type(view, '0.02')
    expect(text(view, 'swap-review-btn')).toBe('Vérifier l’échange')
    expect(text(view, 'swap-network-fee')).toBe('jusqu’à 0.024 MON')
  })

  it('says so when the wallet cannot swap', async () => {
    mockOpen.mockRejectedValue(new Error('wallet locked'))
    const view = await mountPanel()
    expect(text(view, 'swap-unavailable')).toBe(
      'The swap could not be loaded. Check your connection.',
    )
    expect(view.find('[data-testid="swap-review-btn"]').exists()).toBe(false)
  })
})

describe('confirming and executing', () => {
  it('asks for confirmation with the amounts, and sends nothing until confirmed', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    expect(text(view, 'swap-review-summary')).toBe(
      'Pay 0.02 MON and receive about 0.019996 USDC. If you would get less than 0.019896 USDC, the swap is cancelled and you keep your MON.',
    )
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
    await click(view, 'swap-back-btn')
    expect(view.find('[data-testid="swap-review"]').exists()).toBe(false)
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })

  it('records the swap before broadcast, then shows the amount from the receipt, not the quote', async () => {
    const s = scene()
    // The real receipt of 0.02 MON -> 0.019996 USDC; the form will be quoting a different amount.
    s.receipts.set('0xhash1', receipt(vectors.swapNativeIn))
    const view = await mountPanel()
    await type(view, '0.05')
    expect(text(view, 'swap-receive-amount')).toBe('0.049996')
    await click(view, 'swap-review-btn')
    await click(view, 'swap-confirm-btn')

    expect(s.wallet.sendContractCall).toHaveBeenCalledTimes(1)
    expect(s.events).toEqual(['broadcast 0xhash1 after 1 saved'])
    expect(mockSaved[0]).toMatchObject({
      status: 'pending',
      chain: 'monad',
      chainIdentifier: 'monad-testnet',
      fromAsset: 'MON',
      toAsset: 'USDC',
      fromAmount: '0.05',
      txHash: '0xhash1',
      recovery: {
        operationId: 'op-1',
        venueId: 'uniswap-v4',
        account,
        zeroForOne: true,
      },
    })
    expect(mockSaved[1]).toMatchObject({
      id: mockSaved[0]!.id,
      status: 'confirmed',
      toAmount: '0.019996',
      feeDisplay: '0.02652 MON',
    })
    expect(mockSaved[1]!.recovery).toBeUndefined()
    expect(text(view, 'swap-result')).toContain('Swap complete')
    expect(text(view, 'swap-result-received')).toBe('0.019996 USDC')
    expect(text(view, 'swap-result-fee')).toBe('Network fee paid: 0.02652 MON')
    expect(
      view.get('[data-testid="swap-result-explorer"]').attributes('href'),
    ).toBe('https://explorer.test/tx/0xhash1')
    await click(view, 'swap-new-btn')
    expect(text(view, 'swap-review-btn')).toBe('Enter an amount')
  })

  it('reads the price again before signing when the quote is more than a few seconds old', async () => {
    const s = scene()
    s.receipts.set('0xhash1', receipt(vectors.swapNativeIn))
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    const quoterCalls = () =>
      s.node.calls.filter(
        call => call.to.toLowerCase() === deployment.quoter.toLowerCase(),
      ).length
    const before = quoterCalls()
    jest.setSystemTime(Date.now() + 9_000)
    await click(view, 'swap-confirm-btn')
    expect(quoterCalls()).toBe(before + 1)
    expect(s.wallet.sendContractCall).toHaveBeenCalledTimes(1)
  })

  it('does not sign when the price fell beyond the slippage since the review; it shows the new amount', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    s.node.pools.forEach(pool => {
      pool.quote = amountIn => amountIn / 10n ** 12n - 2_000n
    })
    jest.setSystemTime(Date.now() + 9_000)
    await click(view, 'swap-confirm-btn')
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
    expect(text(view, 'swap-problem')).toBe(
      'The price moved beyond your slippage tolerance. Review the new amount.',
    )
    expect(text(view, 'swap-review-summary')).toContain('about 0.018 USDC')
  })

  it('does not sign when the node says the swap would fail on its minimum', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    s.node.gasEstimate = callRevert(tooLittleReceived(19_896n, 19_000n))
    await click(view, 'swap-confirm-btn')
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
    expect(mockSaved).toEqual([])
    expect(text(view, 'swap-problem')).toBe(
      'The price moved beyond your slippage tolerance. Review the new amount.',
    )
  })

  it('shows a reverted swap as not completed, with what it cost and no received amount', async () => {
    const s = scene()
    s.receipts.set('0xhash1', receipt({ logs: [] }, 0))
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    await click(view, 'swap-confirm-btn')
    expect(text(view, 'swap-result')).toContain('Swap not completed')
    expect(view.find('[data-testid="swap-result-received"]').exists()).toBe(
      false,
    )
    expect(mockSaved[1]).toMatchObject({ status: 'failed', toAmount: '0' })
  })

  it('shows a swap the network has not confirmed as pending and tells the user not to resend', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    await view.get('[data-testid="swap-confirm-btn"]').trigger('click')
    await flushPromises()
    expect(text(view, 'swap-progress')).toContain(
      'Submitted. Waiting for the network to confirm…',
    )
    for (let i = 0; i < 95; i++) {
      jest.advanceTimersByTime(1_000)
      await flushPromises()
    }
    expect(text(view, 'swap-result')).toContain('Submitted, not confirmed yet')
    expect(text(view, 'swap-result')).toContain('Do not send it again')
    expect(mockSaved[mockSaved.length - 1]).toMatchObject({
      status: 'pending',
      toAmount: '≥0.019896',
    })
    expect(s.wallet.sendContractCall).toHaveBeenCalledTimes(1)
  })

  it('refuses to sign for an account that is no longer the one signed in', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    s.signOut()
    await click(view, 'swap-confirm-btn')
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
    expect(text(view, 'swap-problem')).toBe(
      'The account changed. Review the swap again.',
    )
  })

  it('finishes a swap recorded as pending when the page opens again', async () => {
    const s = scene()
    s.receipts.set('0xold', receipt(vectors.swapNativeIn))
    const route = routesFor(deployment, MON, USDC)[0]!
    mockHistory.value = [
      {
        id: 'swap-old',
        timestamp: 1,
        chain: 'monad',
        chainIdentifier: 'monad-testnet',
        fromAsset: 'MON',
        toAsset: 'USDC',
        fromAmount: '0.02',
        toAmount: '≥0.019796',
        txHash: '0xold',
        route: 'Uniswap v4',
        feeDisplay: '',
        status: 'pending',
        recovery: {
          operationId: 'op-old',
          venueId: 'uniswap-v4',
          account,
          pool: { ...route.key },
          zeroForOne: true,
          call: { to: deployment.universalRouter, data: '0x00', value: '1' },
          toDecimals: 6,
        },
      },
    ]
    await mountPanel()
    await flushPromises()
    expect(mockSaved).toHaveLength(1)
    expect(mockSaved[0]).toMatchObject({
      id: 'swap-old',
      status: 'confirmed',
      toAmount: '0.019996',
    })
    expect(mockSaved[0]!.recovery).toBeUndefined()
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })

  it('does not broadcast when the swap cannot first be written to the history', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    mockStorageFull = true
    await click(view, 'swap-confirm-btn')
    // The wallet stub broadcasts only after `onSigned` returns; it threw.
    expect(s.wallet.sendContractCall).toHaveBeenCalledTimes(1)
    expect(s.events).toEqual([])
    expect(view.find('[data-testid="swap-result"]').exists()).toBe(false)
    expect(text(view, 'swap-problem')).toContain('The swap was not sent')
  })

  it('shows on the review card what will be moved into the main account, and moves exactly that once', async () => {
    // 0.01 MON in the main account, 1 MON in the wallet's other accounts.
    const s = scene({ mainBalance: 10n ** 16n, other: E18 })
    s.wallet.fundMainAccount.mockImplementation(async () => {
      s.node.nativeBalance = E18
    })
    s.receipts.set('0xhash1', receipt(vectors.swapNativeIn))
    const view = await mountPanel()
    await type(view, '0.02')
    expect(s.wallet.fundMainAccount).not.toHaveBeenCalled()
    await click(view, 'swap-review-btn')
    // 0.02 MON plus 240,000 gas at 100 gwei, less the 0.01 MON already there.
    expect(text(view, 'swap-review-move')).toBe(
      '0.034 MON will first be moved from your other accounts into your main account, which makes the swap.',
    )
    expect(s.wallet.fundMainAccount).not.toHaveBeenCalled()
    await click(view, 'swap-confirm-btn')
    expect(s.wallet.fundMainAccount).toHaveBeenCalledTimes(1)
    expect(s.wallet.fundMainAccount).toHaveBeenCalledWith({
      value: 34n * 10n ** 15n,
    })
    expect(text(view, 'swap-result')).toContain('Swap complete')
  })

  it('shows no such line when the main account can pay by itself', async () => {
    scene({ other: E18 })
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    expect(view.find('[data-testid="swap-review-move"]').exists()).toBe(false)
  })
})

describe('reviewing while the network is unreliable', () => {
  it('keeps the review card when a refresh fails: stale, Confirm off, Back on, and it recovers', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    const working = s.reader.call
    s.reader.call = () => Promise.reject(new Error('rate limited'))
    jest.advanceTimersByTime(6_000)
    await flushPromises()
    expect(view.find('[data-testid="swap-review"]').exists()).toBe(true)
    expect(text(view, 'swap-review-summary')).toContain('about 0.019996 USDC')
    expect(text(view, 'swap-review-stale')).toContain(
      'The price could not be refreshed',
    )
    expect(
      view.get('[data-testid="swap-confirm-btn"]').attributes('disabled'),
    ).toBeDefined()
    expect(
      view.get('[data-testid="swap-back-btn"]').attributes('disabled'),
    ).toBeUndefined()

    // The next refresh retries by itself, and Confirm comes back with a fresh quote.
    s.reader.call = working
    jest.advanceTimersByTime(6_000)
    await flushPromises()
    expect(view.find('[data-testid="swap-review-stale"]').exists()).toBe(false)
    expect(
      view.get('[data-testid="swap-confirm-btn"]').attributes('disabled'),
    ).toBeUndefined()
  })

  it('lets the user go back from a stale review to a working form', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    await click(view, 'swap-review-btn')
    s.reader.call = () => Promise.reject(new Error('rate limited'))
    jest.advanceTimersByTime(6_000)
    await flushPromises()
    await click(view, 'swap-back-btn')
    expect(view.find('[data-testid="swap-review"]').exists()).toBe(false)
    expect(
      view.get('[data-testid="swap-pay-amount"]').attributes('disabled'),
    ).toBeUndefined()
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })
})

describe('how much the form asks of the network', () => {
  const quoterCalls = (s: ReturnType<typeof scene>) =>
    s.node.calls.filter(
      call => call.to.toLowerCase() === deployment.quoter.toLowerCase(),
    ).length

  it('walks the wallet’s accounts once when it opens, never on a timer', async () => {
    const s = scene()
    await mountPanel()
    expect(s.wallet.getContractCallFunds).toHaveBeenCalledTimes(1)
    s.node.calls.length = 0
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(15_000)
      await flushPromises()
    }
    expect(s.wallet.getContractCallFunds).toHaveBeenCalledTimes(1)
    // Each 15 s tick read one ERC-20 balance by call (the other is the native balance).
    expect(s.node.calls).toHaveLength(4)
    expect(
      s.node.calls.every(
        call => call.to.toLowerCase() === USDC.address!.toLowerCase(),
      ),
    ).toBe(true)
  })

  it('stops refreshing in a hidden tab and starts again when it is shown', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    s.node.calls.length = 0
    jest.advanceTimersByTime(60_000)
    await flushPromises()
    expect(s.node.calls).toEqual([])
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(quoterCalls(s)).toBe(1)
    hidden.mockRestore()
  })

  it('stops refreshing after two minutes without input and starts again on the next touch', async () => {
    const s = scene()
    const view = await mountPanel()
    await type(view, '0.02')
    jest.advanceTimersByTime(121_000)
    await flushPromises()
    s.node.calls.length = 0
    jest.advanceTimersByTime(120_000)
    await flushPromises()
    expect(s.node.calls).toEqual([])
    await view.get('[data-testid="evm-swap-panel"]').trigger('pointerdown')
    await flushPromises()
    expect(quoterCalls(s)).toBe(1)
  })
})

describe('interface fee', () => {
  it('shows no fee line when the venue charges none', async () => {
    scene()
    const view = await mountPanel()
    await type(view, '0.02')
    expect(view.find('[data-testid="swap-interface-fee"]').exists()).toBe(false)
    expect(view.text()).not.toMatch(/Frank fee/)
  })

  it('shows Frank’s fee as its own line and the amount received after it', async () => {
    // The quoter answers 19,996 units; 50 bps of that is 99.
    scene({ feeBps: 50 })
    const view = await mountPanel()
    await type(view, '0.02')
    expect(text(view, 'swap-interface-fee')).toBe('0.000099 USDC')
    expect(view.text()).toContain('Frank fee (0.5%)')
    expect(text(view, 'swap-receive-amount')).toBe('0.019897')
    expect(text(view, 'swap-pool-fee')).toBe('0.05%')
    // 0.5% slippage on what the user receives, not on what the pool pays.
    expect(text(view, 'swap-minimum-received')).toBe('0.019797 USDC')
  })
})

describe('tokens', () => {
  it('labels a test token as one in the selectors', async () => {
    scene()
    const view = await mountPanel()
    const options = view
      .get('[data-testid="swap-receive-token"]')
      .findAll('option')
      .map(option => option.text())
    expect(options).toEqual(['MON', 'USDC', 'CHOMP · test token'])
  })

  it('on opening, hands back to the network a contract call that was signed and never landed', async () => {
    const s = scene()
    s.wallet.getUnresolvedContractCalls.mockReturnValue([
      { operationId: 'op-approve', txHash: '0xapprove' },
    ])
    await mountPanel()
    await flushPromises()
    expect(s.wallet.resumeNativeOperation).toHaveBeenCalledWith('op-approve')
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })
})
