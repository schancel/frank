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
    if (outcome === 'exposed and pending')
      mockReturn.mockRejectedValueOnce(
        new Error('Synthetic recovery temporarily unavailable'),
      )
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
      expect(mockReturn).toHaveBeenCalledTimes(1)
      expect(mockReturn).toHaveBeenCalledWith(stack)
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
