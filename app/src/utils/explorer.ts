/**
 * Transaction explorer links, keyed by the canonical chain identifier.
 *
 * The page of a transaction is client presentation configuration: each network's
 * `transactionExplorerUrl` in `CLIENT_CHAIN_EXTENSIONS` (packages/wallet/chain/chains-registry.ts).
 * A network without one (a local regtest chain, or a network nobody has configured) gets no link,
 * and so does an identifier that is not canonical. There is no default network: a link to another
 * network's explorer would open a page that does not show this transaction.
 */
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'

/** The placeholder a `transactionExplorerUrl` template carries for the transaction id. */
export const EXPLORER_TRANSACTION_PLACEHOLDER = '{transaction}'

/**
 * The explorer page of one transaction on the network named by its canonical identifier, or
 * undefined when that network has no configured explorer.
 */
export function transactionExplorerUrl(
  txId: string | undefined,
  chainIdentifier: string | undefined,
): string | undefined {
  if (!txId || !chainIdentifier) return undefined
  if (!Object.prototype.hasOwnProperty.call(PROTOCOL_CHAINS, chainIdentifier))
    return undefined
  const template = PROTOCOL_CHAINS[chainIdentifier].transactionExplorerUrl
  if (!template) return undefined
  return template.replace(
    EXPLORER_TRANSACTION_PLACEHOLDER,
    encodeURIComponent(txId),
  )
}
