/** Pure explicit composition for the all-bots target; no bot startup or runtime effects. */
import { createNegotiationMessagePlugin } from '@frank/swap-protocol/src/message-plugin'
import { TESTNET_NEGOTIATION_POLICY } from '@frank/swap-protocol/src/negotiation'
import { createArticlePlugin } from '@frank/wallet/message-item-plugins/article'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { createInvoicePlugin } from '@frank/wallet/message-item-plugins/invoice'
import { createMentalPokerPlugin } from '@frank/wallet/message-item-plugins/mental-poker'
import { createNewsletterArticlePlugin } from '@frank/wallet/message-item-plugins/newsletter'
import {
  pluginCapabilitiesNotYetAvailable,
  type MessageItemRegistry,
} from '@frank/wallet/message-item-plugins/registry'

export function createBotMessageItemRegistry(): MessageItemRegistry {
  const registry = createDefaultMessageItemRegistry(
    pluginCapabilitiesNotYetAvailable,
  )
  registry.registerApplication(
    createNegotiationMessagePlugin(TESTNET_NEGOTIATION_POLICY),
  )
  registry.registerApplication(createNewsletterArticlePlugin())
  registry.registerApplication(createArticlePlugin())
  registry.registerApplication(createInvoicePlugin())
  registry.registerApplication(createMentalPokerPlugin())
  return registry
}
