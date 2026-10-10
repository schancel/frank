/** @jest-environment jsdom */
/**
 * The panel's states, with the swap session stubbed at its composable. What a real session does
 * against devnet and Jupiter is covered in packages/wallet (recorded responses and the
 * livecheck); nothing here is evidence about a chain.
 */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import en from '../../i18n/en-us'
import fr from '../../i18n/fr-fr'

enableAutoUnmount(afterEach)

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k'
const OWNER = '5wayWDQy8rpri5SZtKFDXSZLqu9sRDbmZmqAXDtjuvmy'

const mockOpenSession = jest.fn()

jest.mock('src/composables/useSolanaSwap', () => {
  class SolanaSwapError extends Error {
    constructor(readonly code: string, readonly detail?: string) {
      super(code)
    }
  }
  class PendingSwapsUnreadableError extends Error {}
  return {
    SolanaSwapError,
    PendingSwapsUnreadableError,
    openSolanaSwapSession: (...args: unknown[]) => mockOpenSession(...args),
  }
})

const { SolanaSwapError, PendingSwapsUnreadableError } =
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('src/composables/useSolanaSwap') as {
    SolanaSwapError: new (code: string, detail?: string) => Error
    PendingSwapsUnreadableError: new () => Error
  }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SolanaSwapPanel = require('./SolanaSwapPanel.vue').default

function translator(messages: unknown) {
  return (key: string, params?: Record<string, unknown>) => {
    let text = key
      .split('.')
      .reduce(
        (value: unknown, part) =>
          (value as Record<string, unknown> | undefined)?.[part],
        messages,
      ) as string
    if (typeof text !== 'string') return key
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
    return text
  }
}

const passthrough = { template: '<div><slot /></div>' }
const stubs = {
  QCard: passthrough,
  QCardSection: passthrough,
  QList: passthrough,
  QItem: passthrough,
  QItemSection: passthrough,
  QSpinner: { template: '<i />' },
  QIcon: { template: '<i />' },
  QBanner: { template: '<div><slot /><slot name="action" /></div>' },
  QInput: {
    props: ['modelValue', 'error', 'errorMessage', 'readonly'],
    emits: ['update:modelValue'],
    template: `<div>
      <input :value="modelValue" :readonly="readonly"
        @input="$emit('update:modelValue', $event.target.value)" />
      <span v-if="error" class="field-error">{{ errorMessage }}</span>
    </div>`,
  },
  QSelect: {
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template: `<select :value="modelValue"
      @change="$emit('update:modelValue', $event.target.value)">
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>`,
  },
  QBtn: {
    props: ['label', 'disable'],
    template: '<button :disabled="disable">{{ label }}<slot /></button>',
  },
  QBtnToggle: {
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template: `<div><button v-for="o in options" :key="o.value" :data-value="o.value"
      @click="$emit('update:modelValue', o.value)">{{ o.label }}</button></div>`,
  },
}

function quoteFor(amount: bigint, overrides: Record<string, unknown> = {}) {
  return {
    chainIdentifier: 'solana-devnet',
    venueId: 'orca-whirlpools',
    venueName: 'Orca Whirlpools (devnet)',
    owner: OWNER,
    inputMint: SOL,
    outputMint: USDC,
    inputAmount: amount,
    expectedOutputAmount: 222_201n,
    minOutputAmount: 221_089n,
    slippageBps: 50,
    priceImpactBps: 0.04,
    route: [{ label: 'Orca Whirlpool', inputMint: SOL, outputMint: USDC }],
    tradeFee: { amount: 20_000n, mint: SOL },
    networkFeeLamports: 5000n,
    accountRentLamports: 1_488_440n,
    temporaryRentLamports: 1_488_440n,
    fetchedAt: Date.now(),
    transaction: {},
    lastValidBlockHeight: 100n,
    recheck: async () => undefined,
    ...overrides,
  }
}

const pendingRecord = {
  transactionId: 'OLDSIG',
  chainIdentifier: 'solana-devnet',
  venueId: 'orca-whirlpools',
  venueName: 'Orca Whirlpools (devnet)',
  route: 'Orca Whirlpool',
  account: OWNER,
  assetIn: { symbol: 'SOL', address: null, decimals: 9 },
  amountIn: '10000000',
  assetOut: { symbol: 'devUSDC', address: USDC, decimals: 6 },
  quotedAmountOut: '222201',
  minimumAmountOut: '221089',
  interfaceFeeAmount: '0',
  networkFeeLamports: '5000',
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    chainIdentifier: 'solana-devnet',
    networkName: 'Solana Devnet',
    isTestnet: true,
    venueId: 'orca-whirlpools',
    venueName: 'Orca Whirlpools (devnet)',
    venueDescription: '',
    owner: OWNER,
    loadTokens: jest.fn().mockResolvedValue([
      {
        mint: SOL,
        symbol: 'SOL',
        name: 'Solana',
        decimals: 9,
        amount: 1_100_000_000n,
        native: true,
      },
      {
        mint: USDC,
        symbol: 'devUSDC',
        name: 'Orca devnet USDC',
        decimals: 6,
        amount: 5_000_000n,
        native: false,
      },
    ]),
    quote: jest.fn(async (params: { amount: bigint; slippageBps: number }) =>
      quoteFor(params.amount, { slippageBps: params.slippageBps }),
    ),
    execute: jest.fn(),
    pending: jest.fn().mockReturnValue(undefined),
    resume: jest.fn(),
    ...overrides,
  }
}

type Wrapper = ReturnType<typeof mount>

async function mountPanel(
  session: ReturnType<typeof fakeSession> | undefined | Error,
  messages: unknown = en,
  props: Record<string, string> = {},
): Promise<Wrapper> {
  if (session instanceof Error) mockOpenSession.mockRejectedValue(session)
  else mockOpenSession.mockResolvedValue(session)
  const wrapper = mount(SolanaSwapPanel, {
    props,
    global: { mocks: { $t: translator(messages) }, stubs },
  })
  await flushPromises()
  return wrapper
}

async function enterAmount(wrapper: Wrapper, text: string) {
  await wrapper.find('[data-testid="solana-swap-amount"] input').setValue(text)
  jest.advanceTimersByTime(500)
  await flushPromises()
}

const button = (wrapper: Wrapper, id: string) =>
  wrapper.find(`[data-testid="${id}"]`).element as HTMLButtonElement
const text = (wrapper: Wrapper, id: string) =>
  wrapper.find(`[data-testid="${id}"]`).text()

async function toReview(wrapper: Wrapper, amount = '0.01') {
  await enterAmount(wrapper, amount)
  await wrapper.find('[data-testid="solana-swap-review-btn"]').trigger('click')
  await flushPromises()
}

const confirmed = {
  status: 'confirmed',
  signature: 'SIG123',
  finalized: false,
  receivedAmount: 222_000n,
  spentAmount: 10_000_000n,
  networkFeeLamports: 5000n,
  accountRentLamports: 1_488_440n,
}

describe('SolanaSwapPanel', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    mockOpenSession.mockReset()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('opens the network and exchange the swap view selected', async () => {
    await mountPanel(fakeSession(), en, {
      chainIdentifier: 'solana-devnet',
      walletId: 'solana',
      venueId: 'orca-whirlpools',
    })
    expect(mockOpenSession).toHaveBeenCalledWith(
      'solana-devnet',
      'orca-whirlpools',
    )
  })

  it('says plainly when the network has no exchange turned on', async () => {
    const wrapper = await mountPanel(undefined)
    expect(text(wrapper, 'solana-swap-unsupported')).toContain(
      'Swaps are not available on this network',
    )
    expect(
      wrapper.find('[data-testid="solana-swap-review-btn"]').exists(),
    ).toBe(false)
  })

  it('offers a retry when the tokens cannot be loaded', async () => {
    const session = fakeSession({
      loadTokens: jest
        .fn()
        .mockRejectedValueOnce(new Error('relay offline'))
        .mockResolvedValue([]),
    })
    const wrapper = await mountPanel(session)
    expect(text(wrapper, 'solana-swap-load-error')).toContain(
      'Could not load your Solana tokens.',
    )
    expect(text(wrapper, 'solana-swap-load-error')).toContain('relay offline')
    await wrapper.find('[data-testid="solana-swap-reload"]').trigger('click')
    await flushPromises()
    expect(
      wrapper.find('[data-testid="solana-swap-load-error"]').exists(),
    ).toBe(false)
  })

  it('does not show a form when the record of a swap in progress cannot be read', async () => {
    const session = fakeSession({
      pending: jest.fn(() => {
        throw new PendingSwapsUnreadableError()
      }),
    })
    const wrapper = await mountPanel(session)
    expect(text(wrapper, 'solana-swap-load-error')).toContain(
      'it is not known whether a swap is still pending',
    )
    expect(wrapper.find('[data-testid="solana-swap-amount"]').exists()).toBe(
      false,
    )
  })

  it('names the exchange and network truthfully, in both languages', async () => {
    const devnet = await mountPanel(fakeSession())
    expect(text(devnet, 'solana-swap-venue')).toBe(
      'Trading on Orca Whirlpools (devnet), Solana Devnet: test tokens with no real value.',
    )
    const mainnet = await mountPanel(
      fakeSession({
        isTestnet: false,
        venueName: 'Jupiter',
        networkName: 'Solana',
      }),
      fr,
    )
    expect(text(mainnet, 'solana-swap-venue')).toBe(
      'Échange sur Jupiter, Solana. Cet échange utilise des fonds réels.',
    )
  })

  it('shows the chain balance and quotes the exact input in base units', async () => {
    const session = fakeSession()
    const wrapper = await mountPanel(session)
    expect(text(wrapper, 'solana-swap-pay-balance')).toContain('1.1 SOL')
    expect(button(wrapper, 'solana-swap-review-btn').disabled).toBe(true)

    await enterAmount(wrapper, '0.01')
    expect(session.quote).toHaveBeenCalledWith({
      inputMint: SOL,
      outputMint: USDC,
      amount: 10_000_000n,
      slippageBps: 50,
    })
    expect(
      (
        wrapper.find('[data-testid="solana-swap-receive-amount"] input')
          .element as HTMLInputElement
      ).value,
    ).toBe('0.222201 devUSDC')
    expect(text(wrapper, 'solana-swap-quote-rate')).toBe(
      '1 SOL ≈ 22.2201 devUSDC',
    )
    expect(text(wrapper, 'solana-swap-quote-impact')).toBe('< 0.01%')
    expect(text(wrapper, 'solana-swap-quote-minimum')).toBe('0.221089 devUSDC')
    expect(text(wrapper, 'solana-swap-quote-trade-fee')).toBe('0.00002 SOL')
    expect(text(wrapper, 'solana-swap-quote-network-fee')).toBe('0.000005 SOL')
    expect(text(wrapper, 'solana-swap-quote-route')).toBe(
      'Orca Whirlpools (devnet) · Orca Whirlpool',
    )
    expect(wrapper.text()).toContain('Frank adds no fee to this swap.')
    expect(button(wrapper, 'solana-swap-review-btn').disabled).toBe(false)
  })

  it('re-quotes when the slippage changes and drops the old quote meanwhile', async () => {
    const session = fakeSession()
    const wrapper = await mountPanel(session)
    await enterAmount(wrapper, '0.01')
    await wrapper
      .find('[data-testid="solana-swap-slippage"] [data-value="100"]')
      .trigger('click')
    expect(wrapper.find('[data-testid="solana-swap-quote"]').exists()).toBe(
      false,
    )
    expect(button(wrapper, 'solana-swap-review-btn').disabled).toBe(true)
    jest.advanceTimersByTime(500)
    await flushPromises()
    expect(session.quote).toHaveBeenLastCalledWith(
      expect.objectContaining({ slippageBps: 100 }),
    )
  })

  it('does not ask for a quote the wallet cannot pay for, or for a malformed amount', async () => {
    const session = fakeSession()
    const wrapper = await mountPanel(session)
    await enterAmount(wrapper, '2')
    expect(wrapper.find('.field-error').text()).toBe('Not enough SOL')
    await enterAmount(wrapper, '0.0000000001')
    expect(wrapper.find('.field-error').text()).toBe(
      'Enter an amount with at most 9 decimal places',
    )
    expect(session.quote).not.toHaveBeenCalled()
    expect(button(wrapper, 'solana-swap-review-btn').disabled).toBe(true)
  })

  it('shows a real quote the wallet cannot carry out, with the reason, and blocks review', async () => {
    const session = fakeSession({
      quote: jest.fn(async (params: { amount: bigint }) =>
        quoteFor(params.amount, {
          blocker: new SolanaSwapError('insufficient-sol'),
        }),
      ),
    })
    const wrapper = await mountPanel(session)
    await enterAmount(wrapper, '0.01')
    expect(wrapper.find('[data-testid="solana-swap-quote"]').exists()).toBe(
      true,
    )
    expect(text(wrapper, 'solana-swap-error')).toBe(
      'Not enough SOL to cover this swap, its network fee and its deposits.',
    )
    expect(button(wrapper, 'solana-swap-review-btn').disabled).toBe(true)
  })

  it('turns a quote failure into plain language, keeping the chain wording as detail', async () => {
    const session = fakeSession({
      quote: jest
        .fn()
        .mockRejectedValue(
          new SolanaSwapError('simulation-failed', 'Program log: custom error'),
        ),
    })
    const wrapper = await mountPanel(session)
    await enterAmount(wrapper, '0.01')
    expect(text(wrapper, 'solana-swap-error')).toContain(
      'The network would reject this swap, so it was not sent.',
    )
    expect(text(wrapper, 'solana-swap-error')).toContain(
      'Program log: custom error',
    )
  })

  it('keeps the quote current while the user is active, and stops asking when they are not', async () => {
    const session = fakeSession()
    const wrapper = await mountPanel(session)
    await enterAmount(wrapper, '0.01')
    expect(session.quote).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(11_000)
    await flushPromises()
    expect(session.quote).toHaveBeenCalledTimes(2)

    // Two minutes with no input: no more quotes by itself.
    jest.advanceTimersByTime(120_000)
    await flushPromises()
    const whileActive = session.quote.mock.calls.length
    jest.advanceTimersByTime(60_000)
    await flushPromises()
    expect(session.quote).toHaveBeenCalledTimes(whileActive)

    // Asking to review a stale quote fetches a current one first.
    await wrapper
      .find('[data-testid="solana-swap-review-btn"]')
      .trigger('click')
    await flushPromises()
    expect(session.quote).toHaveBeenCalledTimes(whileActive + 1)
    expect(wrapper.find('[data-testid="solana-swap-review"]').exists()).toBe(
      true,
    )
  })

  it('does not re-quote while the tab is hidden', async () => {
    const session = fakeSession()
    const wrapper = await mountPanel(session)
    await enterAmount(wrapper, '0.01')
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    jest.advanceTimersByTime(30_000)
    await flushPromises()
    expect(session.quote).toHaveBeenCalledTimes(1)
    hidden.mockRestore()
    expect(wrapper.exists()).toBe(true)
  })

  it('reviews the whole swap in plain figures before anything is signed', async () => {
    const session = fakeSession()
    const wrapper = await mountPanel(session)
    await toReview(wrapper)
    expect(session.execute).not.toHaveBeenCalled()
    expect(text(wrapper, 'solana-swap-review-where')).toBe(
      'On Orca Whirlpools (devnet), on Solana Devnet. These are test tokens with no real value.',
    )
    expect(text(wrapper, 'solana-swap-review-pay')).toBe('0.01 SOL')
    expect(text(wrapper, 'solana-swap-review-network-fee')).toBe('0.000005 SOL')
    expect(text(wrapper, 'solana-swap-review-rent')).toBe('0.00148844 SOL')
    // Input, fee and the deposit that stays in the new account, in one figure.
    expect(text(wrapper, 'solana-swap-review-total')).toBe('0.01149344 SOL')
    // The temporary account's deposit is shown apart: the same transaction returns it.
    expect(text(wrapper, 'solana-swap-review-temporary')).toBe('0.00148844 SOL')
    expect(text(wrapper, 'solana-swap-review-receive')).toBe('0.222201 devUSDC')
    expect(text(wrapper, 'solana-swap-review-minimum')).toBe('0.221089 devUSDC')
    expect(text(wrapper, 'solana-swap-review-net')).toBe(
      'In all: 0.01149344 SOL leaves your wallet and about 0.222201 devUSDC arrives (never less than 0.221089 devUSDC, or the swap does not happen).',
    )
    // Fee and deposit are 14.9% of the 0.01 SOL swapped: above a tenth, so it is said.
    expect(text(wrapper, 'solana-swap-cost-warning')).toBe(
      'Fees and deposits (0.00149344 SOL) are 14.9% of the 0.01 SOL being swapped.',
    )
    expect(
      wrapper.find('[data-testid="solana-swap-review-platform-fee"]').exists(),
    ).toBe(false)

    await wrapper.find('[data-testid="solana-swap-back"]').trigger('click')
    expect(wrapper.find('[data-testid="solana-swap-amount"]').exists()).toBe(
      true,
    )
  })

  it('shows costs in their own assets, with no warning it cannot justify', async () => {
    // Paying a token for another token's worth of SOL: token and SOL are not added together.
    const session = fakeSession({
      quote: jest.fn(async (params: { amount: bigint }) =>
        quoteFor(params.amount, {
          inputMint: USDC,
          outputMint: SOL,
          expectedOutputAmount: 100_000_000n,
          minOutputAmount: 99_500_000n,
          accountRentLamports: 0n,
          tradeFee: undefined,
        }),
      ),
    })
    const wrapper = await mountPanel(session)
    await wrapper.find('[data-testid="solana-swap-flip"]').trigger('click')
    await toReview(wrapper, '2.5')
    expect(text(wrapper, 'solana-swap-review-total')).toBe(
      '2.5 devUSDC + 0.000005 SOL',
    )
    expect(
      wrapper.find('[data-testid="solana-swap-review-rent"]').exists(),
    ).toBe(false)
    expect(
      wrapper.find('[data-testid="solana-swap-cost-warning"]').exists(),
    ).toBe(false)
  })

  it("shows Frank's fee only when the exchange has one configured", async () => {
    const session = fakeSession({
      quote: jest.fn(async (params: { amount: bigint }) =>
        quoteFor(params.amount, {
          platformFee: { amount: 100_000n, mint: SOL, bps: 100 },
        }),
      ),
    })
    const wrapper = await mountPanel(session)
    await toReview(wrapper)
    expect(wrapper.text()).not.toContain('Frank adds no fee to this swap.')
    expect(text(wrapper, 'solana-swap-review-platform-fee')).toBe('0.0001 SOL')
    expect(wrapper.text()).toContain('Frank fee (1%)')
    expect(wrapper.text()).toContain('Part of what you pay.')
  })

  it('never confirms figures older than a few seconds', async () => {
    const session = fakeSession()
    const wrapper = await mountPanel(session)
    await toReview(wrapper)
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    jest.advanceTimersByTime(12_000) // the quote goes stale; hidden, so nothing refreshed it
    await flushPromises()
    hidden.mockRestore()
    expect(button(wrapper, 'solana-swap-confirm').textContent).toContain(
      'Get current quote',
    )
    const before = session.quote.mock.calls.length
    await wrapper.find('[data-testid="solana-swap-confirm"]').trigger('click')
    await flushPromises()
    expect(session.quote).toHaveBeenCalledTimes(before + 1)
    expect(session.execute).not.toHaveBeenCalled()
    expect(button(wrapper, 'solana-swap-confirm').textContent).toContain(
      'Confirm swap',
    )
  })

  it('signs through the session, shows progress, then what the chain charged and delivered', async () => {
    let finish: (outcome: unknown) => void = () => undefined
    const session = fakeSession()
    session.execute.mockImplementation(
      (
        _quote: unknown,
        _assets: unknown,
        onSubmitted: (record: { transactionId: string }) => void,
      ) =>
        new Promise(resolve => {
          finish = outcome => resolve(outcome)
          setTimeout(() => onSubmitted({ transactionId: 'SIG123' }), 10)
        }),
    )
    const wrapper = await mountPanel(session)
    await toReview(wrapper)
    await wrapper.find('[data-testid="solana-swap-confirm"]').trigger('click')
    expect(session.execute.mock.calls[0][0].inputAmount).toBe(10_000_000n)
    expect(session.execute.mock.calls[0][1]).toEqual({
      assetIn: { symbol: 'SOL', address: null, decimals: 9 },
      assetOut: { symbol: 'devUSDC', address: USDC, decimals: 6 },
    })
    expect(text(wrapper, 'solana-swap-stage')).toBe('Signing…')
    expect(wrapper.find('[data-testid="solana-swap-confirm"]').exists()).toBe(
      false,
    )

    jest.advanceTimersByTime(10)
    await flushPromises()
    expect(text(wrapper, 'solana-swap-stage')).toBe(
      'Sent. Waiting for the network to confirm…',
    )
    expect(
      wrapper.find('[data-testid="solana-swap-explorer"]').attributes('href'),
    ).toContain('SIG123')
    expect(wrapper.find('[data-testid="solana-swap-new"]').exists()).toBe(false)

    // The chain delivered slightly less than quoted: that is what must be shown.
    session.loadTokens.mockClear()
    finish(confirmed)
    await flushPromises()
    expect(text(wrapper, 'solana-swap-stage')).toBe('Swap complete')
    expect(text(wrapper, 'solana-swap-result-paid')).toBe('0.01 SOL')
    expect(text(wrapper, 'solana-swap-result-network-fee')).toBe('0.000005 SOL')
    expect(text(wrapper, 'solana-swap-result-rent')).toBe('0.00148844 SOL')
    expect(text(wrapper, 'solana-swap-result-total')).toBe('0.01149344 SOL')
    expect(text(wrapper, 'solana-swap-result-received')).toBe('0.222 devUSDC')
    expect(session.loadTokens).toHaveBeenCalled()

    await wrapper.find('[data-testid="solana-swap-new"]').trigger('click')
    expect(
      wrapper.find('[data-testid="solana-swap-review-btn"]').exists(),
    ).toBe(true)
  })

  it('returns to the form with the reason when nothing was sent', async () => {
    const session = fakeSession()
    session.execute.mockRejectedValue(new SolanaSwapError('slippage'))
    const wrapper = await mountPanel(session)
    await toReview(wrapper)
    await wrapper.find('[data-testid="solana-swap-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="solana-swap-progress"]').exists()).toBe(
      false,
    )
    expect(text(wrapper, 'solana-swap-error')).toContain(
      'The price moved beyond your slippage tolerance.',
    )
  })

  it('never offers a new swap while a sent one is unresolved', async () => {
    const session = fakeSession()
    session.execute.mockImplementation(
      async (
        _quote: unknown,
        _assets: unknown,
        onSubmitted: (record: { transactionId: string }) => void,
      ) => {
        onSubmitted({ transactionId: 'SIG123' })
        throw new Error('network unreachable')
      },
    )
    const wrapper = await mountPanel(session)
    await toReview(wrapper)
    await wrapper.find('[data-testid="solana-swap-confirm"]').trigger('click')
    await flushPromises()
    expect(text(wrapper, 'solana-swap-stage')).toBe('Still checking this swap')
    expect(text(wrapper, 'solana-swap-stage-note')).toContain(
      'It has not been sent again as a new swap.',
    )
    expect(wrapper.find('[data-testid="solana-swap-new"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="solana-swap-confirm"]').exists()).toBe(
      false,
    )

    // "Check again" follows the recorded transaction; it does not build another swap.
    session.pending.mockReturnValue({
      ...pendingRecord,
      transactionId: 'SIG123',
    })
    session.resume.mockResolvedValue({
      status: 'failed',
      signature: 'SIG123',
      reason: 'x',
      networkFeeLamports: 5000n,
    })
    await wrapper
      .find('[data-testid="solana-swap-check-again"]')
      .trigger('click')
    await flushPromises()
    expect(session.execute).toHaveBeenCalledTimes(1)
    expect(text(wrapper, 'solana-swap-stage')).toBe('Swap failed')
    expect(text(wrapper, 'solana-swap-result-network-fee')).toBe('0.000005 SOL')
  })

  it('picks up a swap sent earlier instead of showing the form', async () => {
    const session = fakeSession()
    session.pending.mockReturnValue(pendingRecord)
    let finish: (outcome: unknown) => void = () => undefined
    session.resume.mockImplementation(
      () => new Promise(resolve => (finish = resolve)),
    )
    const wrapper = await mountPanel(session)
    expect(text(wrapper, 'solana-swap-stage')).toBe(
      'Sent. Waiting for the network to confirm…',
    )
    expect(text(wrapper, 'solana-swap-result-paid')).toBe('0.01 SOL')
    expect(
      wrapper.find('[data-testid="solana-swap-review-btn"]').exists(),
    ).toBe(false)
    expect(session.resume).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'OLDSIG' }),
    )

    finish({ status: 'expired', signature: 'OLDSIG' })
    await flushPromises()
    expect(text(wrapper, 'solana-swap-stage')).toBe('Swap was not processed')
    expect(wrapper.find('[data-testid="solana-swap-new"]').exists()).toBe(true)
  })

  it('leaving mid-swap loses nothing: the swap finishes without the panel and is not offered again', async () => {
    let finish: (outcome: unknown) => void = () => undefined
    const session = fakeSession()
    session.execute.mockImplementation(
      (
        _quote: unknown,
        _assets: unknown,
        onSubmitted: (record: { transactionId: string }) => void,
      ) =>
        new Promise(resolve => {
          finish = resolve
          onSubmitted({ transactionId: 'SIG123' })
        }),
    )
    const wrapper = await mountPanel(session)
    await toReview(wrapper)
    await wrapper.find('[data-testid="solana-swap-confirm"]').trigger('click')
    await flushPromises()
    wrapper.unmount()
    // The session (not the panel) decides and records the outcome; the panel only displays.
    finish(confirmed)
    await flushPromises()

    // Back on the tab while still pending: the same swap is followed, no form.
    const again = fakeSession()
    again.pending.mockReturnValue({ ...pendingRecord, transactionId: 'SIG123' })
    again.resume.mockResolvedValue(confirmed)
    const back = await mountPanel(again)
    await flushPromises()
    expect(again.execute).not.toHaveBeenCalled()
    expect(text(back, 'solana-swap-stage')).toBe('Swap complete')
    expect(text(back, 'solana-swap-result-received')).toBe('0.222 devUSDC')
  })
})
