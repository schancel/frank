// What the open wallets saw arrive for a message, read once per wallet into a digest map: no
// request, and no per-message scan of the coin list (review finding A7).
import { verifiedReceiptsReader } from './message-receipts'

const DIGEST = 'ab'.repeat(32)
const payment = (over: Record<string, unknown>) => ({
  address: '0x1',
  origin: 'stealth',
  status: 'received',
  amountWei: 0n,
  claimedAmountWei: 10n ** 21n,
  spendable: true,
  payloadDigest: DIGEST,
  ...over,
})
const monad = {
  chainIdentifier: 'monad-testnet',
  getReceivedPayments: jest.fn(() => [
    payment({ receivedAmountWei: 10n ** 18n }),
    payment({ receivedAmountWei: 2n, status: 'pending', partial: true }),
    // Claimed only: nothing seen arriving.
    payment({ status: 'pending', receivedAmountWei: undefined }),
    payment({ status: 'not-received' }),
    // A stamp coin is counted with the message's stamp, not here.
    payment({ origin: 'stamp', receivedAmountWei: 5n }),
    payment({ payloadDigest: 'cd'.repeat(32), receivedAmountWei: 7n }),
  ]),
}
const sepolia = {
  chainIdentifier: 'ethereum-sepolia',
  getReceivedPayments: jest.fn(() => [payment({ receivedAmountWei: 3n })]),
}
let mockPrimary: unknown = monad
jest.mock('../accounts/session', () => ({
  accountSession: { peekWallet: () => mockPrimary },
}))
jest.mock('../accounts/evm-wallets', () => ({
  peekOpenedEvmWallets: () => [{ wallet: monad }, { wallet: sepolia }],
}))

beforeEach(() => {
  monad.getReceivedPayments.mockClear()
  sepolia.getReceivedPayments.mockClear()
  mockPrimary = monad
})

it('reads each wallet once, however many messages are looked up', () => {
  const read = verifiedReceiptsReader()
  for (let i = 0; i < 50; i += 1) read(DIGEST)
  expect(monad.getReceivedPayments).toHaveBeenCalledTimes(1)
  expect(sepolia.getReceivedPayments).toHaveBeenCalledTimes(1)
})

it('counts only what was seen arriving, per digest and per wallet chain', () => {
  const read = verifiedReceiptsReader()
  expect(read(`0x${DIGEST.toUpperCase()}`)).toEqual([
    { chainIdentifier: 'monad-testnet', baseUnits: 10n ** 18n + 2n },
    { chainIdentifier: 'ethereum-sepolia', baseUnits: 3n },
  ])
  expect(read('cd'.repeat(32))).toEqual([
    { chainIdentifier: 'monad-testnet', baseUnits: 7n },
  ])
  expect(read('ef'.repeat(32))).toEqual([])
})

it('verifies nothing when no session can answer', () => {
  mockPrimary = undefined
  monad.getReceivedPayments.mockImplementationOnce(() => {
    throw new Error('closed')
  })
  expect(verifiedReceiptsReader()(DIGEST)).toEqual([
    { chainIdentifier: 'ethereum-sepolia', baseUnits: 3n },
  ])
})
