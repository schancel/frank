/**
 * Address-normalization for `stores/chats.ts`/`stores/contacts.ts` (ticket #42 -- see `PLAN.md`'s
 * M9 section). `./address.ts`'s `toDisplayAddress`/`toAPIAddress` are Lotus-specific (bitcore
 * `Address` parsing) and throw on any non-Lotus-shaped string, including every real Monad `0x...`
 * address now flowing through the app post ticket #41 -- so every address-as-storage-key call site
 * in those two stores needs a chain-agnostic replacement, not just their network-calling entry
 * points (`refresh`/`fetchAndAddContact`). See #42's handoff for the full reasoning.
 *
 * Mirrors `toDisplayAddress`'s *role* -- a single canonical string used as the actual key in
 * `state.chats`/`state.contacts` (`@frank/wallet/chain/active-chain.ts`'s `ChainAddress` doc comment:
 * "the canonical string form ... for storage keys") -- via `activeChain.parseAddress`/
 * `formatAddress` instead of bitcore.
 */
import { activeChain } from '@frank/wallet/chain'

/** Canonicalizes `address` to `activeChain`'s own canonical string form -- the same value used as
 * the key in `state.chats`/`state.contacts`. Throws if `address` doesn't parse as a valid address
 * for the active chain, matching `toDisplayAddress`'s old fail-fast behavior on a malformed
 * address rather than silently keying data under an unparseable string. */
export function toChainDisplayAddress(address: string): string {
  const parsed = activeChain.parseAddress(address)
  if (!parsed) {
    throw new Error(
      `Invalid ${activeChain.name} address, cannot derive a store key: ${address}`,
    )
  }
  return activeChain.formatAddress(parsed)
}
