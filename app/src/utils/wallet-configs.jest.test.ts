import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'
import { MAIN_WALLET_ID, WALLET_CONFIGS } from './wallet-configs'
import { walletNetworkMetadata } from './wallet-support'

it('preserves established wallet row order and covers each registry kind once', () => {
  const ids = WALLET_CONFIGS.map(row => row.id)
  expect(ids).toEqual([
    'monad',
    'bitcoin',
    'bitcoincash',
    'dogecoin',
    'ecash',
    'solana',
    'tempo',
    'ethereum',
    'hyperliquid',
    'litecoin',
    'bnb',
    'polygon',
    'base',
    'arbitrum',
  ])
  expect(new Set(ids).size).toBe(ids.length)
  expect(new Set(ids)).toEqual(
    new Set(Object.values(PROTOCOL_CHAINS).map(entry => entry.kind)),
  )
  expect(MAIN_WALLET_ID).toBe('monad')
  expect(WALLET_CONFIGS.filter(row => row.isMain).map(row => row.id)).toEqual([
    'monad',
  ])
})

it('retains real metadata consumers across EVM, Solana and UTXO wallet rows', () => {
  const metadata = WALLET_CONFIGS.map(row =>
    walletNetworkMetadata(row.id, true, 'monad-testnet'),
  )
  expect(metadata.every(entry => entry !== undefined)).toBe(true)
  expect(new Set(metadata.map(entry => entry?.family))).toEqual(
    new Set(['evm', 'solana', 'bitcoin']),
  )
  for (const [index, row] of WALLET_CONFIGS.entries()) {
    expect(metadata[index]?.kind).toBe(row.id)
  }
})
