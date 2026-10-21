/**
 * The app's message-item registry: which item types this app understands.
 *
 * This is the app's composition point for message items. The registry is built here, once, by an
 * explicit list of plugin `init` calls (`createDefaultMessageItemRegistry`); nothing registers
 * itself by being imported. The chat store (sidebar previews, notification text, message value)
 * and the message bubble's fallback line both read this one registry, so a type can never have a
 * preview in one place and not in the other.
 *
 * Plugins are lent wallet capabilities at `init`. The wallet does not provide them yet, so the app
 * passes the provider whose every method rejects with a typed error.
 */
import { installGroupMessageItemPlugins } from '@frank/group-messaging/groups/plugin'
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
} from '@frank/cashweb/message-items/registry'
import { createSwapHandshakePlugin } from '@frank/wallet/message-item-plugins/swap-handshake'
import { createWebRtcCallPlugin } from '@frank/wallet/message-item-plugins/webrtc-call'

export function createAppMessageItemRegistry(): MessageItemRegistry {
  const registry = installGroupMessageItemPlugins(
    createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable),
    pluginCapabilitiesNotYetAvailable,
  )
  registry.registerApplication(
    createNegotiationMessagePlugin(TESTNET_NEGOTIATION_POLICY),
  )
  registry.registerApplication(createNewsletterArticlePlugin())
  registry.registerApplication(createArticlePlugin())
  registry.registerApplication(createInvoicePlugin())
  registry.registerApplication(createMentalPokerPlugin())
  registry.registerApplication(createWebRtcCallPlugin())
  registry.registerApplication(createSwapHandshakePlugin())
  return registry
}

export const messageItems: MessageItemRegistry = createAppMessageItemRegistry()
