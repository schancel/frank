/** Runtime installation is explicit and independent of type augmentation/imports. */
import {
  installMessageItemPlugin,
  type MessageItemCapabilityProvider,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { initGroupWelcomePlugin } from './welcome-plugin'
import { initGroupControlPlugin } from './control-plugin'

export function installGroupMessageItemPlugins(
  registry: MessageItemRegistry,
  capabilities: MessageItemCapabilityProvider,
): MessageItemRegistry {
  installMessageItemPlugin(
    registry,
    capabilities,
    'group-welcome',
    initGroupWelcomePlugin,
  )
  installMessageItemPlugin(
    registry,
    capabilities,
    'group-control',
    initGroupControlPlugin,
  )
  return registry
}
