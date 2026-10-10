/**
 * The canonical chain identifiers, read from the shared protocol registry itself
 * (docs/protocol/chains/v1.json), so a plugin can check a `chainIdentifier` field without
 * depending on any wallet implementation. Only the `id` values are used here.
 */
import protocolChains from '../../../../docs/protocol/chains/v1.json'

const CANONICAL_CHAIN_IDENTIFIERS: ReadonlySet<string> = new Set(
  (protocolChains as { chains: Array<{ id: string }> }).chains.map(
    chain => chain.id,
  ),
)

/** Whether `value` is exactly one of the registry's `id` values. No alias is accepted. */
export function isCanonicalChainIdentifier(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_CHAIN_IDENTIFIERS.has(value)
}
