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
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import {
  pluginCapabilitiesNotYetAvailable,
  type MessageItemRegistry,
} from '@frank/wallet/message-item-plugins/registry'

export const messageItems: MessageItemRegistry =
  createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable)
