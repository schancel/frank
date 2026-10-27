import { GroupWritePriceRefusedError } from '@frank/cashweb/groups/group-relay-client'
import type { GroupWritePriceView } from '../stores/chats'
import {
  displayToRawAmount,
  formatRawAmount,
  registryAmountAdapter,
} from './chain-amount'

/** A group write price in its network's unit, exactly as it is paid ("0.000001 MON"). Empty when
 * the price is not known yet or names a network without a native unit: nothing is guessed. */
export function groupWritePriceLabel(
  network: string | undefined,
  priceWei: string | bigint | undefined,
): string {
  if (!network || priceWei === undefined) return ''
  const chain = registryAmountAdapter(network)
  return chain ? formatRawAmount(chain, priceWei) : ''
}

export function groupWritePriceViewLabel(view?: GroupWritePriceView): string {
  return groupWritePriceLabel(view?.network, view?.priceWei)
}

/** A price typed in the network's display unit, in base units; undefined when it does not
 * parse or is not positive. */
export function parseGroupWritePriceInput(
  network: string,
  display: string,
): bigint | undefined {
  const chain = registryAmountAdapter(network)
  if (!chain || !display.trim()) return undefined
  try {
    const raw = displayToRawAmount(chain, display)
    return raw > 0n ? raw : undefined
  } catch {
    return undefined
  }
}

/** The i18n key and values that explain why a host refused a price. */
export function groupWritePriceRefusalMessage(
  error: unknown,
  network: string,
): { key: string; values?: Record<string, string> } | undefined {
  if (!(error instanceof GroupWritePriceRefusedError)) return undefined
  if (error.reason === 'below_minimum' && error.minPriceWei !== undefined)
    return {
      key: 'groupChat.writePriceBelowMinimum',
      values: { minimum: groupWritePriceLabel(network, error.minPriceWei) },
    }
  if (error.reason === 'conflict')
    return { key: 'groupChat.writePriceConflict' }
  return { key: 'groupChat.writePriceRefused' }
}
