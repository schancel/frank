/**
 * Which wallet is the account's main balance: chosen here, by the host, from configuration.
 *
 * `QCLI_FRANK_BASE_CHAIN` names a canonical chain identifier (docs/protocol/chains/v1.json), for
 * example `lotus-v2-regtest`. `resolveBaseChain` refuses an unknown, walletless or adapterless
 * identifier, and this module refuses one the running network mode cannot open (a regtest or
 * testnet base under a mainnet build), so a misconfigured build fails at start instead of
 * showing another network's balance.
 *
 * Not set: the main balance is the messaging chain's own wallet, the EVM network the build runs
 * on (`QCLI_MONAD_RPC_CHAIN`, `activeChain`), exactly as before the setting existed. That choice
 * is made here, explicitly; shared services never pick a base network themselves.
 *
 * The messaging chain is unchanged either way (plan D2, docs/plans/lotus-v2-base): identity, the
 * directory and DM stamps stay on the EVM wallet, which remains in the wallet list.
 */
import { activeChain } from '@frank/wallet/chain'
// The seam's own module, not the package index: suites that stub the index keep it real.
import {
  resolveBaseChain,
  UnsupportedBaseChainError,
} from '@frank/wallet/chain/base-chain'
import type { ChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import { readViteEnv } from '@frank/wallet/chain/vite-env'

/** The one public build setting that names the base chain. */
export const BASE_CHAIN_SETTING = 'QCLI_FRANK_BASE_CHAIN'

/**
 * The configured main-balance network when it is not the messaging chain's wallet; undefined
 * when the messaging chain's wallet is the main balance (nothing configured, or it names the
 * messaging chain itself).
 */
export function resolveMainWalletChain(
  configured: string | undefined,
  messaging: { chainIdentifier: string; isTestnet?: boolean } = activeChain,
): ChainRegistryEntry | undefined {
  const entry = resolveBaseChain(configured)
  if (!entry || entry.id === messaging.chainIdentifier) return undefined
  if (entry.isTestnet !== (messaging.isTestnet ?? false))
    throw new UnsupportedBaseChainError(
      entry.id,
      `this build runs on ${messaging.chainIdentifier}, a ${
        messaging.isTestnet ? 'test' : 'main'
      } network`,
    )
  return entry
}

/** Read once at start: the build's environment does not change while the app runs. */
export const MAIN_WALLET_CHAIN: ChainRegistryEntry | undefined =
  resolveMainWalletChain(readViteEnv(BASE_CHAIN_SETTING))
