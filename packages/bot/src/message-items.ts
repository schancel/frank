/** Pure explicit composition for the all-bots target; no bot startup or runtime effects. */
import { createNegotiationMessagePlugin } from '@frank/swap-protocol/src/message-plugin'
import { TESTNET_NEGOTIATION_POLICY } from '@frank/swap-protocol/src/negotiation'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
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
  return registry
}
