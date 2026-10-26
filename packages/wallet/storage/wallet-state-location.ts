/**
 * Where one wallet's durable state lives: the one naming function for it.
 *
 * A wallet's stores (coin list, received coins, stealth preparations, contact payments, the
 * mailbox-scan record, the native operation journal, stamp journals, the sent-message store and
 * the pool records) all sit under one location, each in its own namespace (`<location>/<name>`;
 * in a browser each is the IndexedDB database `level-js-<location>/<name>`). The location names
 * the canonical network exactly once, so the same address on two networks never shares a store
 * (AGENTS.md §1):
 *
 *     <base>-<chainIdentifier>-<owner>        e.g. frank-wallet-state-monad-testnet-evm-0xabc…
 *
 * `base` is the host's choice (a directory for Node hosts, `frank-wallet-state` in the browser);
 * `owner` names the wallet within the network (`evm-<main address>`, `pathusd-<address>`).
 *
 * Earlier builds named the state differently: a Monad wallet with no network at all
 * (`frank-monad-wallet-state-evm-<address>`, shared by every Monad network), and other EVM
 * networks with the network twice. Nothing reads those names any more and nothing migrates or
 * deletes them (AGENTS.md §6). A wallet that still has one says so at open
 * ({@link findEarlierWalletState}) instead of presenting an empty wallet as complete.
 *
 * Development reset: see `wallet-state-location.md` beside this file.
 */
import { getChainRegistryEntry } from '../chain/chains-registry'

/** The browser's base name for wallet state. Chain-neutral: every network family shares it. */
export const DEFAULT_WALLET_STATE_BASE = 'frank-wallet-state'

/** The base earlier browser builds used, with no network in the name for Monad wallets. */
export const EARLIER_BROWSER_WALLET_STATE_BASE = 'frank-monad-wallet-state'

/** The owner part of an EVM wallet's location: its main account. */
export function evmWalletStateOwner(mainAddress: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(mainAddress))
    throw new Error('EVM wallet state owner must be a 0x address')
  return `evm-${mainAddress.toLowerCase()}`
}

/** The location of one wallet's state on one canonical network. */
export function walletStateLocation(params: {
  readonly base: string
  readonly chainIdentifier: string
  readonly owner: string
}): string {
  const { base, chainIdentifier, owner } = params
  if (base.trim().length === 0) throw new Error('Wallet state base must not be empty')
  if (getChainRegistryEntry(chainIdentifier)?.id !== chainIdentifier)
    throw new Error(`Wallet state requires a canonical network, not ${JSON.stringify(chainIdentifier)}`)
  if (!/^[0-9a-z]+(?:-[0-9a-z]+)*$/i.test(owner))
    throw new Error('Wallet state owner must be a plain name')
  return `${base}-${chainIdentifier}-${owner}`
}

/**
 * The locations earlier builds gave this wallet's state, other than the current one: the base
 * with no network (`<base>-<owner>`), with the network twice, and the same under the earlier
 * browser base. Only names; nothing is opened.
 */
export function earlierWalletStateLocations(params: {
  readonly base: string
  readonly chainIdentifier: string
  readonly owner: string
}): string[] {
  const current = walletStateLocation(params)
  const { base, chainIdentifier, owner } = params
  const names = new Set<string>()
  for (const earlierBase of [base, EARLIER_BROWSER_WALLET_STATE_BASE]) {
    names.add(`${earlierBase}-${owner}`)
    names.add(`${earlierBase}-${chainIdentifier}-${chainIdentifier}-${owner}`)
    names.add(`${earlierBase}-${chainIdentifier}-${owner}`)
  }
  names.delete(current)
  return [...names]
}

/**
 * Which of these locations still hold state. Looked for, never opened: a Node host has each
 * store as a directory under the location, a browser as an IndexedDB database
 * `level-js-<location>/<namespace>`. Returns the locations found, in the order given. A host
 * that cannot list its databases reports none (the notice is advice, not a gate).
 */
export async function findEarlierWalletState(
  locations: readonly string[],
): Promise<string[]> {
  if (locations.length === 0) return []
  const globals = globalThis as {
    window?: unknown
    indexedDB?: { databases?: () => Promise<{ name?: string }[]> }
  }
  try {
    if (globals.window !== undefined && globals.indexedDB !== undefined) {
      const names = ((await globals.indexedDB.databases?.()) ?? []).flatMap(
        database => (database.name === undefined ? [] : [database.name]),
      )
      return locations.filter(location =>
        names.some(name => name.startsWith(`level-js-${location}/`)),
      )
    }
    // Keep Node's filesystem module outside browser bundles.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { existsSync } = require('fs') as typeof import('fs')
    return locations.filter(location => existsSync(location))
  } catch {
    return []
  }
}

/** What a wallet found of its earlier-named state at open: the locations, for the notice. */
export interface EarlierWalletState {
  readonly chainIdentifier: string
  /** The location this wallet reads now. */
  readonly location: string
  /** Locations earlier builds wrote for this wallet, still present and no longer read. */
  readonly earlierLocations: readonly string[]
}
