/**
 * The Solana `dex` entries a network's row in the chain registry lists (`chains-registry.ts`):
 * the exchanges a swap can be made on. Entries are facts only; no rate or quote lives here.
 *
 * An entry is `{ id, adapter, enabled, displayName, maintainer, <program ids / endpoints>,
 * interfaceFee? }`. The common fields are the shape shared with the EVM lists; the rest is what
 * a Solana exchange needs. `adapter` names the class that speaks to the exchange (solana-swap/dex.ts
 * maps the key to the class explicitly).
 *
 * Availability is decided here and nowhere else: an entry with `enabled: false`, or no entry,
 * means no swap on that network through that exchange. No code checks the network.
 * - solana-devnet: Orca Whirlpools, enabled: every listed pool was traded for real.
 * - solana-mainnet: Jupiter and Orca Whirlpools are listed with `enabled: false`: both quote
 *   against real mainnet state, but no swap has been executed there (no funded mainnet
 *   account; #1376). Turn one on by setting `enabled: true`.
 *
 * The common fields are `SwapVenue` from ./dex-entries.ts, the same as EVM entries; a row's
 * `dex` list is a union of entry types discriminated by `adapter`.
 *
 * Provenance (checked 2026-10-10):
 * - Orca Whirlpools, devnet: program and pools from Orca's devnet index
 *   (https://api.devnet.orca.so/v2/solana/pools/<address>); each pool was then traded for real
 *   on devnet (packages/wallet/solana-swap.livecheck.ts `pools`).
 * - Orca Whirlpools, mainnet: SOL/USDC pool from Orca's index (https://api.orca.so/v2/solana/pools,
 *   highest TVL for the pair) and read on chain (owned by the program, funded vaults).
 * - Jupiter: https://api.jup.ag/swap/v1 (keyless at 0.5 requests/second) and its program id as
 *   it appears in the transactions that API returns. Jupiter aggregates MAINNET liquidity only,
 *   so it cannot be a devnet exchange.
 * Every pool is re-checked on chain each time it is read (solana-swap/orca.ts `decodeWhirlpool`).
 *
 * `maxNetworkFeeLamports`:
 * - Orca Whirlpools: the wallet builds the transaction with one signature and no priority fee,
 *   so it costs the base fee of 5 000 lamports; the limit is twice that.
 * - Jupiter: 1 000 000 lamports (0.001 SOL). Jupiter's API sets a priority fee from recent
 *   network conditions; it is asked to keep it under this limit, and its transactions observed
 *   on 2026-10-10 carried about 100 000 lamports.
 *
 * `interfaceFee`: Frank's own fee, off everywhere until fee-collecting accounts exist (#1375).
 * With none configured nothing fee-related is put in a transaction.
 */
import {
  MAX_INTERFACE_FEE_BPS,
  type InterfaceFee,
  type SwapVenue,
} from './dex-entries'

/** The wrapped-SOL mint. A swap that pays or receives SOL wraps and unwraps through it. */
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112'

/** A configured interface fee above this is a configuration mistake, refused at load. */
export const MAX_PLATFORM_FEE_BPS = MAX_INTERFACE_FEE_BPS

export interface SolanaSwapToken {
  readonly mint: string
  readonly symbol: string
  readonly name: string
}

/** Frank's fee on an exchange: whole basis points, and the wallet (not a token account) that
 * collects it. The shared entry's `InterfaceFee`. */
export type SolanaSwapPlatformFee = InterfaceFee

/** The fields every chain family's `dex` entry has (`SwapVenue`), plus what Solana needs. */
interface VenueBase extends SwapVenue {
  readonly tokens: readonly SolanaSwapToken[]
  /**
   * The most a swap through this exchange may pay the network, in lamports: the base fee plus
   * any priority fee (compute-unit limit times price). A transaction that could be charged more
   * is refused, never shown or signed. Whoever builds the transaction (for Jupiter, its API)
   * chooses the priority fee, so this is what stops a bad response from burning the wallet's
   * SOL as fees.
   */
  readonly maxNetworkFeeLamports: number
}

export interface OrcaWhirlpoolsVenue extends VenueBase {
  readonly adapter: 'orca-whirlpools'
  readonly programId: string
  /** Pools the app may trade against. Mints, vaults and price are read from each account. */
  readonly pools: readonly string[]
}

export interface JupiterVenue extends VenueBase {
  readonly adapter: 'jupiter'
  readonly apiBaseUrl: string
  /** Jupiter's swap program; its transaction must call this program exactly once. */
  readonly programId: string
}

/** Every Solana dex entry type; one per adapter. */
export type SolanaDexEntry = OrcaWhirlpoolsVenue | JupiterVenue

/** The adapters a Solana row may name. */
export const SOLANA_DEX_ADAPTERS: readonly string[] = [
  'orca-whirlpools',
  'jupiter',
]

const SOL: SolanaSwapToken = {
  mint: NATIVE_SOL_MINT,
  symbol: 'SOL',
  name: 'Solana',
}
const USDC: SolanaSwapToken = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  name: 'USD Coin',
}
const ORCA_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const ORCA_MAX_NETWORK_FEE_LAMPORTS = 10_000

/** The `dex` list of the `solana-devnet` row of the chain registry. */
export const SOLANA_DEVNET_DEX: readonly SolanaDexEntry[] = [
  {
    id: 'orca-whirlpools',
    adapter: 'orca-whirlpools',
    enabled: true,
    displayName: 'Orca Whirlpools (devnet)',
    maintainer: 'Orca',
    maxNetworkFeeLamports: ORCA_MAX_NETWORK_FEE_LAMPORTS,
    programId: ORCA_PROGRAM_ID,
    pools: [
      '3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt', // SOL / devUSDC
      '63cMwvN8eoaD39os9bKP8brmA7Xtov9VxahnPufWCSdg', // devUSDC / devUSDT
      'EgxU92G34jw6QDG9RuTX9StFg1PmHuDqkRKAE5kVEiZ4', // devSAMO / devUSDC
      'H3xhLrSEyDFm6jjG42QezbvhSxF5YHW75VdGUnqeEg5y', // devTMAC / devUSDC
    ],
    tokens: [
      SOL,
      {
        mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
        symbol: 'devUSDC',
        name: 'Orca devnet USDC',
      },
      {
        mint: 'H8UekPGwePSmQ3ttuYGPU1szyFfjZR4N53rymSFwpLPm',
        symbol: 'devUSDT',
        name: 'Orca devnet USDT',
      },
      {
        mint: 'Jd4M8bfJG3sAkd82RsGWyEXoaBXQP7njFzBwEaCTuDa',
        symbol: 'devSAMO',
        name: 'Orca devnet SAMO',
      },
      {
        mint: 'Afn8YB1p4NsoZeS5XJBZ18LTfEy5NFPwN46wapZcBQr6',
        symbol: 'devTMAC',
        name: 'Orca devnet TMAC',
      },
    ],
  },
]

/** The `dex` list of the `solana-mainnet` row of the chain registry. */
export const SOLANA_MAINNET_DEX: readonly SolanaDexEntry[] = [
  {
    id: 'jupiter',
    adapter: 'jupiter',
    enabled: false,
    displayName: 'Jupiter',
    maintainer: 'Jupiter',
    maxNetworkFeeLamports: 1_000_000,
    apiBaseUrl: 'https://api.jup.ag/swap/v1',
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    tokens: [
      SOL,
      USDC,
      {
        mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        symbol: 'USDT',
        name: 'Tether USD',
      },
      {
        mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
        symbol: 'JUP',
        name: 'Jupiter',
      },
    ],
  },
  {
    id: 'orca-whirlpools',
    adapter: 'orca-whirlpools',
    enabled: false,
    displayName: 'Orca Whirlpools',
    maintainer: 'Orca',
    maxNetworkFeeLamports: ORCA_MAX_NETWORK_FEE_LAMPORTS,
    programId: ORCA_PROGRAM_ID,
    pools: ['Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'], // SOL / USDC
    tokens: [SOL, USDC],
  },
]
