/**
 * Which network is the account's base wallet (balance, receive, send, history), by configuration.
 *
 * This is separate from the messaging chain (`ActiveChain`, EVM: identity, directory, DM stamps),
 * which stage 1 of the Lotus v2 base-coin plan leaves on Monad (docs/plans/lotus-v2-base). Host
 * composition reads `QCLI_FRANK_BASE_CHAIN` (browser) or `FRANK_BASE_CHAIN` (Node) and passes it
 * here. Absent: there is no separate base wallet and the messaging chain's wallet is the base, as
 * before. Present: it must be a canonical identifier whose client registry row has a wallet; an
 * unknown, unsupported or walletless identifier is refused, never replaced by a default network.
 */
import { getChainRegistryEntry, type ChainRegistryEntry } from "./chains-registry";

export class UnsupportedBaseChainError extends Error {
  constructor(readonly chainIdentifier: string, reason: string) {
    super(`Base chain ${JSON.stringify(chainIdentifier)} is not supported: ${reason}`);
    this.name = "UnsupportedBaseChainError";
  }
}

/** The configured base network's registry entry, or undefined when none is configured. */
export function resolveBaseChain(configured: string | undefined): ChainRegistryEntry | undefined {
  if (configured === undefined || configured.trim() === "") return undefined;
  const entry = getChainRegistryEntry(configured);
  if (!entry) throw new UnsupportedBaseChainError(configured, "not a canonical chain identifier");
  if (!entry.wallet) throw new UnsupportedBaseChainError(configured, "the app has no wallet on it");
  // Bitcoin-family base wallets are opened through `openRelayUtxoChain`, which picks the adapter
  // by registry kind; EVM base wallets are the messaging chain's own. Solana has no base adapter.
  if (entry.family === "solana")
    throw new UnsupportedBaseChainError(configured, "no base-wallet adapter for the solana family");
  return entry;
}
