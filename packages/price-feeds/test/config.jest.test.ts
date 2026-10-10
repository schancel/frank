import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  BINANCE_API_BASE,
  BINANCE_US_API_BASE,
  BLOCKCHAIR_API_BASE,
  COINBASE_API_BASE,
  COINGECKO_API_BASE,
  DEFAULT_ARBITRUM_RPC,
  KRAKEN_API_BASE,
  ORACLE_ENDPOINTS,
  ORACLE_REFRESH_INTERVAL_MS,
  PYTH_HERMES_URL,
} from '../src'

const SRC = join(__dirname, '..', 'src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      // Bundled data files name the public sources they were copied from; nothing there is fetched.
      return entry.name === 'historical' ? [] : sourceFiles(path)
    }
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('oracle configuration', () => {
  it('is the only file that names an endpoint', () => {
    const elsewhere = sourceFiles(SRC)
      .filter(path => path !== join(SRC, 'config.ts'))
      .filter(path => /https?:\/\//.test(readFileSync(path, 'utf8')))
    expect(elsewhere).toEqual([])
  })

  it('is where every provider reads its endpoint from', () => {
    expect([
      DEFAULT_ARBITRUM_RPC,
      PYTH_HERMES_URL,
      COINBASE_API_BASE,
          KRAKEN_API_BASE,
          COINGECKO_API_BASE,
          BINANCE_API_BASE,
      BINANCE_US_API_BASE,
          BLOCKCHAIR_API_BASE,
    ]).toEqual(
      Object.values(ORACLE_ENDPOINTS).flatMap(provider =>
        Object.values(provider),
      ),
    )
  })

  it('refreshes every ten minutes', () => {
    expect(ORACLE_REFRESH_INTERVAL_MS).toBe(10 * 60 * 1000)
  })
})
