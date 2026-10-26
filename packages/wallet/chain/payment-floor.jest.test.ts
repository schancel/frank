import protocolChains from '../../../docs/protocol/chains/v1.json'
import {
  EVM_TRANSFER_GAS,
  PAYMENT_FLOOR_MULTIPLE,
  evmPaymentFloorWei,
} from './payment-floor'
import { projectPaymentFloorMultiple } from './protocol-chain-registry'

/** The owner's rule: a stamp is at least ten times the gas of moving it. */
describe('the payment floor', () => {
  test('the factor is the registry value: ten', () => {
    expect(protocolChains.payment_floor_multiple).toBe(10)
    expect(PAYMENT_FLOOR_MULTIPLE).toBe(10n)
    expect(EVM_TRANSFER_GAS).toBe(21_000n)
  })

  test('at solonet and Monad gas prices a received stamp is worth ten moves of it', () => {
    // eth_gasPrice on solonet, Monad testnet and mainnet (2026-10-25): 102 gwei.
    const price = 102_000_000_000n
    const floor = evmPaymentFloorWei(price)
    expect(floor).toBe(21_420_000_000_000_000n) // 0.02142 MON
    expect(floor).toBe(10n * 21_000n * price)
    // The stamp the owner saw refused as unspendable: 0.0021 MON is below one move.
    expect(2_100_000_000_000_000n).toBeLessThan(21_000n * price)
    expect(2_100_000_000_000_000n).toBeLessThan(floor)
  })

  test("the wallet's floor is never below the relay's deterministic one", () => {
    // The relay's floor: the same multiple at the registry's minimum gas price.
    for (const id of ['monad-mainnet', 'monad-testnet', 'monad-regtest']) {
      const row = protocolChains.chains.find(chain => chain.id === id) as
        | { min_gas_price_wei?: string }
        | undefined
      const minimum = BigInt(row!.min_gas_price_wei!)
      expect(minimum).toBe(100_000_000_000n)
      const relayFloor = evmPaymentFloorWei(minimum)
      expect(relayFloor).toBe(21_000_000_000_000_000n)
      // A node's gas price is the base fee (never below the minimum) plus a tip.
      expect(evmPaymentFloorWei(minimum + 2_000_000_000n)).toBeGreaterThan(relayFloor)
    }
  })

  test('the registry projection refuses a missing or non-positive multiple', () => {
    expect(projectPaymentFloorMultiple({ payment_floor_multiple: 3 })).toBe(3n)
    for (const bad of [{}, { payment_floor_multiple: 0 }, { payment_floor_multiple: -1 },
      { payment_floor_multiple: 1.5 }, { payment_floor_multiple: '10' }])
      expect(() => projectPaymentFloorMultiple(bad)).toThrow(/payment_floor_multiple/)
    expect(() => evmPaymentFloorWei(-1n)).toThrow(RangeError)
  })
})
