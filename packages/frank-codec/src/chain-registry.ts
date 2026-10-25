// Canonical chain identifiers from the protocol registry (docs/protocol/chains/v1.json, the one
// source; see its README). A payment that names the chain it settles on must name one of these.
import protocolChains from '../../../docs/protocol/chains/v1.json'

const PROTOCOL_CHAIN_IDS: ReadonlySet<string> = new Set(
  protocolChains.chains.map(chain => chain.id),
)

/** True when `id` is exactly a canonical `id` in `docs/protocol/chains/v1.json`. */
export function isProtocolChainIdentifier(id: string): boolean {
  return PROTOCOL_CHAIN_IDS.has(id)
}
