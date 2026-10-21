/**
 * Wallet-local composition: names the plugins still owned here. Hosts build this base registry and explicitly install external feature plugins. Nothing is registered by
 * importing this file; a registry exists only once `createDefaultMessageItemRegistry` is called,
 * and each call builds a separate one.
 *
 * Only this file imports the plugins. Wallet send, receive and custody code takes a
 * `MessageItemRegistry` (`@frank/cashweb/message-items/registry`) and never imports from here or from a plugin directory.
 */
import { initBlackjackHandPlugin } from './blackjack-hand/plugin'
import { initBlackjackMovePlugin } from './blackjack-move/plugin'
import { initCalendarInvitePlugin } from './calendar-invite/plugin'
import { initCalendarRsvpPlugin } from './calendar-rsvp/plugin'
import { initChannelUpdatePlugin } from './channel-update/plugin'
import { initContactCardPlugin } from './contact-card/plugin'
import { initConversationStatePlugin } from './conversation-state/plugin'
import { initDeviceClaimPlugin } from './device-claim/plugin'
import { initDicePlugin } from './dice/plugin'
import { initDigitalGoodsPlugin } from './digital-goods/plugin'
import { initEmailPlugin } from './email/plugin'
import { initImagePlugin } from './image/plugin'
import { initJournalCheckpointPlugin } from './journal-checkpoint/plugin'
import { initLiarsDicePlugin } from './liars-dice/plugin'
import { initMessageTombstonePlugin } from './message-tombstone/plugin'
import { initOutboxMessagePlugin } from './outbox-message/plugin'
import { initP2pkhPlugin } from './p2pkh/plugin'
import { initPaymentTransferPlugin } from './payment-transfer/plugin'
import { initRecipientAssetPaymentPlugin } from './stealth-asset/plugin'
import { initPokerPlugin } from './poker/plugin'
import { initRafflePlugin } from './raffle/plugin'
import { initReceivedCoinPlugin } from './received-coin/plugin'
import { initReplyPlugin } from './reply/plugin'
import { initRpsPlugin } from './rps/plugin'
import { initStealthPlugin } from './stealth/plugin'
import { initSwapOfferPlugin } from './swap-offer/plugin'
import { initSwapRecordPlugin } from './swap-record/plugin'
import { initTextPlugin } from './text/plugin'
import { initWalletSyncPlugin } from './wallet-sync/plugin'
import {
  createMessageItemRegistry,
  installMessageItemPlugin,
  type MessageItemCapabilityProvider,
  type MessageItemPluginInit,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'

/** Every plugin, as `[item type, init]`. The type is what the plugin's capabilities are bound to
 * and the only type its `init` may register. */
export const DEFAULT_MESSAGE_ITEM_PLUGINS: ReadonlyArray<
  readonly [type: string, init: MessageItemPluginInit]
> = [
  ['text', initTextPlugin],
  ['image', initImagePlugin],
  ['reply', initReplyPlugin],
  ['stealth', initStealthPlugin],
  ['stealth-asset', initRecipientAssetPaymentPlugin],
  ['p2pkh', initP2pkhPlugin],
  ['email', initEmailPlugin],
  ['channel-update', initChannelUpdatePlugin],
  ['wallet-sync', initWalletSyncPlugin],
  ['payment-transfer', initPaymentTransferPlugin],
  ['device-claim', initDeviceClaimPlugin],
  ['swap-offer', initSwapOfferPlugin],
  ['swap-record', initSwapRecordPlugin],
  ['received-coin', initReceivedCoinPlugin],
  ['conversation-state', initConversationStatePlugin],
  ['outbox-message', initOutboxMessagePlugin],
  ['message-tombstone', initMessageTombstonePlugin],
  ['journal-checkpoint', initJournalCheckpointPlugin],
  ['digital-goods', initDigitalGoodsPlugin],
  ['raffle', initRafflePlugin],
  ['blackjack-move', initBlackjackMovePlugin],
  ['blackjack-hand', initBlackjackHandPlugin],
  ['rps', initRpsPlugin],
  ['dice', initDicePlugin],
  ['liars-dice', initLiarsDicePlugin],
  ['poker', initPokerPlugin],
  ['calendar-invite', initCalendarInvitePlugin],
  ['calendar-rsvp', initCalendarRsvpPlugin],
  ['contact-card', initContactCardPlugin],
]

/** A new registry holding every plugin. `capabilities` is required: no plugin is installed
 * without the capabilities bound to its type. */
export function createDefaultMessageItemRegistry(
  capabilities: MessageItemCapabilityProvider,
): MessageItemRegistry {
  const registry = createMessageItemRegistry()
  for (const [type, init] of DEFAULT_MESSAGE_ITEM_PLUGINS) {
    installMessageItemPlugin(registry, capabilities, type, init)
  }
  return registry
}
