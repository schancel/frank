/** Actual harness control flow, with synthetic host/stack boundaries. No accounts or services. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const MON = 10n ** 18n
const mockFund = jest.fn()
const mockStop = jest.fn(async () => undefined)
const mockStart = jest.fn(async () => undefined)
const mockHostStop = jest.fn(async () => undefined)
const mockOpenPlayer = jest.fn()
const mockReturn = jest.fn(async (_stack: unknown) => ({
  returnedWei: 0n,
  leftWei: 0n,
  unswept: 0,
}))
const mockStackStart = jest.fn()
const mockOwnedReturn = jest.fn()
const mockHost = {
  instances: new Map([
    [
      'blackjack',
      {
        context: { address: '0x' + '11'.repeat(20) },
        wallet: {
          getReceiveAddress: async () => ({ raw: '0x' + '22'.repeat(20) }),
        },
      },
    ],
  ]),
  register: jest.fn(async () => undefined),
  start: mockStart,
  stop: mockHostStop,
}

jest.mock('@frank/bot-framework', () => ({
  FrankBotHost: jest.fn(() => mockHost),
}))
jest.mock('@frank/wallet/chain/evm-chain', () => ({ loadMonadChainConfigFromEnv: () => ({}) }))
jest.mock('ethers', () => ({ Wallet: { createRandom: () => ({ privateKey: '00'.repeat(33) }) } }))
jest.mock('@frank/wallet/message-item-plugins/blackjack/hand', () => ({
  buildBet: () => ({ type: 'blackjack-hand', action: 'bet' }),
  checkWager: (_state: unknown, value: bigint) => value < 2n ? 'below-min-bet' : value > 20n ? 'above-max-bet' : undefined,
  payoutWei: () => 0n,
  foldHand: (events: Array<{ item: { action: string; gameId: string } }>) => ({ state: {
    minBetWei: 2n, maxBetWei: 20n, wagerWei: 2n, doubled: false,
    phase: events.some(event => event.item.action === 'reveal') ? 'resolved' : 'open',
    outcome: events.at(-1)?.item.gameId === 'win' ? 'player_win' : 'push',
    gameId: events.at(-1)?.item.gameId,
  } }),
}))
jest.mock('../../src/bots/blackjack-bot', () => ({
  BlackjackDealerBot: class {},
}))
jest.mock('./regtest-stack', () => ({
  startRegtestStack: (...args: unknown[]) => mockStackStart(...args),
}))
jest.mock('./monad-wallets', () => ({
  monadOf: () => ({ fund: mockFund, rpcUrl: 'http://127.0.0.1:1' }),
  openMonadWallet: (...args: unknown[]) => mockOpenPlayer(...args),
  returnToFaucet: (stack: unknown) => mockReturn(stack),
  returnBlackjackAvailableFunds: (...args: unknown[]) => mockOwnedReturn(...args),
  tickUntilSettled: async () => 1,
}))

import { main } from './blackjack-limits.livecheck'

it.each(['credited', 'exposed and pending'] as const)(
  'does not authorize another faucet payment after the original was %s and its answer was lost',
  async outcome => {
    const stateDir = mkdtempSync(join(tmpdir(), 'blackjack-funding-test-'))
    writeFileSync(join(stateDir, 'owner-marker'), 'synthetic original run')
    const stack = { stateDir, relayUrl: 'http://127.0.0.1:1', stop: mockStop }
    const failure = new Error(
      'Funding reply lost; original signed transaction may still land',
    )
    const obligations: bigint[] = []
    let credited = 0n
    mockFund
      .mockReset()
      .mockImplementation(async (_address: string, amount: bigint) => {
        obligations.push(amount)
        if (outcome === 'credited') credited += amount
        throw failure
      })
    mockStackStart.mockResolvedValue(stack)
    const output = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined)
    process.env.BLACKJACK_LIMITS_MIN_HANDS = '30'
    process.env.BLACKJACK_LIMITS_MAX_HANDS = '40'
    jest.useFakeTimers()
    try {
      const completed = main()
      await jest.runAllTimersAsync()
      expect(await completed).toBe(false)
      expect(mockFund).toHaveBeenCalledTimes(1)
      expect(obligations).toEqual([2n * MON])
      if (outcome === 'exposed and pending')
        credited = obligations.reduce((sum, value) => sum + value, 0n)
      expect(credited).toBe(2n * MON)
      expect(mockStackStart).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ FRANK_REGTEST_KEEP: '1' }),
        }),
      )
      expect(output.mock.calls.some(args => args.includes(failure))).toBe(true)
      expect(mockStart).not.toHaveBeenCalled()
      expect(mockOpenPlayer).not.toHaveBeenCalled()
      expect(mockReturn).not.toHaveBeenCalled()
      expect(mockHostStop).toHaveBeenCalledTimes(1)
      expect(mockStop).toHaveBeenCalledTimes(1)
      expect(existsSync(join(stateDir, 'owner-marker'))).toBe(true)
    } finally {
      jest.useRealTimers()
      jest.clearAllMocks()
      output.mockRestore()
      rmSync(stateDir, { recursive: true, force: true })
      delete process.env.BLACKJACK_LIMITS_MIN_HANDS
      delete process.env.BLACKJACK_LIMITS_MAX_HANDS
    }
  },
)

/** Complete game behavior is stubbed: these cases verify actual finally control flow only. */
it.each(['success', 'shutdown', 'return', 'close', 'stack'] as const)(
  'uses owned returns only after successful game/shutdown and reports %s cleanup outcome', async failureAt => {
    jest.clearAllMocks()
    mockFund.mockReset().mockResolvedValue('funded')
    mockHostStop.mockReset().mockResolvedValue(undefined)
    mockStop.mockReset().mockResolvedValue(undefined)
    mockOwnedReturn.mockReset().mockResolvedValue(undefined)
    const close = jest.fn(async () => undefined)
    if (failureAt === 'shutdown') mockHostStop.mockRejectedValue(new Error('shutdown failed'))
    if (failureAt === 'return') mockOwnedReturn.mockRejectedValue(new Error('original return uncertain'))
    if (failureAt === 'close') close.mockRejectedValue(new Error('player close failed'))
    if (failureAt === 'stack') mockStop.mockRejectedValue(new Error('stack close failed'))
    let received = 0
    const actions = ['challenge', 'refund', 'challenge', 'deal', 'reveal', 'challenge', 'deal', 'reveal']
    const player = {
      label: 'synthetic', address: 'player', mainAccount: 'main', close,
      send: jest.fn(async () => 'sent'), handle: { checkMessagePayment: async () => ({ receivedWei: 1n }) },
      receive: jest.fn(async () => {
        const index = received++
        return { payloadDigest: String(index), stampValueWei: index === 1 ? 1n : 0n,
          items: [{ type: 'blackjack-hand', action: actions[index], gameId: index >= 5 ? 'win' : 'push', minBetWei: '2', maxBetWei: '20' }] }
      }),
    }
    mockOpenPlayer.mockResolvedValue(player)
    mockStackStart.mockResolvedValue({ stateDir: '/synthetic-run', relayUrl: 'http://inert', stop: mockStop })
    const output = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    process.env.BLACKJACK_LIMITS_MIN_HANDS = '0'
    process.env.BLACKJACK_LIMITS_MAX_HANDS = '2'
    jest.useFakeTimers()
    try {
      const finished = main()
      await jest.runAllTimersAsync()
      expect(await finished).toBe(failureAt === 'success')
      expect(mockReturn).not.toHaveBeenCalled()
      expect(mockOwnedReturn).toHaveBeenCalledTimes(failureAt === 'shutdown' ? 0 : 1)
      if (failureAt !== 'shutdown') {
        expect(mockOwnedReturn).toHaveBeenCalledWith(expect.objectContaining({ player }))
        expect(mockOwnedReturn.mock.invocationCallOrder[0]).toBeGreaterThan(mockHostStop.mock.invocationCallOrder[0]!)
        expect(close.mock.invocationCallOrder[0]).toBeGreaterThan(mockOwnedReturn.mock.invocationCallOrder[0]!)
      }
      expect(close).toHaveBeenCalledTimes(1)
      expect(mockStop).toHaveBeenCalledTimes(1)
      expect(output.mock.calls.flat().join(' ')).not.toContain('monad-sweep-state')
    } finally {
      jest.useRealTimers()
      output.mockRestore()
      delete process.env.BLACKJACK_LIMITS_MIN_HANDS
      delete process.env.BLACKJACK_LIMITS_MAX_HANDS
    }
  },
)
