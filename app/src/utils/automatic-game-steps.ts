/**
 * The game steps a chat sends without asking: dealer steps that involve no choice and pay
 * nothing (blackjack deal, card, a reveal that owes nothing), and the free dice, rock-paper-
 * scissors and mental-poker steps.
 *
 * Only the account's active device sends them (`stores/leader.ts`). Every device of the account
 * computes the same step from the same messages, so two open devices would otherwise both send
 * it. The other devices still show the game; when the user acts on one of them it becomes the
 * active one and sends what is still owed.
 *
 * What the user already decided (a hand message that was cut off or failed) is not a step
 * here: the chat finishes that on whichever device holds it (`resumeHandMessages`).
 */
import type { MessageItem } from '@frank/cashweb/types/messages'
import { MENTAL_POKER_PLUGIN_ID } from '@frank/wallet/message-item-plugins/mental-poker'
import { automaticDealerSteps, type HandChatMessage } from './blackjack-hand'
import { automaticP2pGameSteps } from './p2p-games'
import { automaticMentalPokerSteps } from './p2p-mental-poker'

export function automaticGameSteps(
  messages: readonly HandChatMessage[],
  own: string,
  peer: string,
  { activeDevice }: { activeDevice: boolean },
): { key: string; item: MessageItem }[] {
  if (!activeDevice) return []
  const has = (match: (item: MessageItem) => boolean) =>
    messages.some(m => m.items?.some(match))
  return [
    ...(has(it => it.type === 'blackjack-hand')
      ? automaticDealerSteps(messages, own, peer)
      : []),
    ...(has(it => it.type === 'dice' || it.type === 'rps')
      ? automaticP2pGameSteps(messages, own, peer)
      : []),
    ...(has(
      it => it.type === 'application' && it.itemType === MENTAL_POKER_PLUGIN_ID,
    )
      ? automaticMentalPokerSteps(messages, own, peer)
      : []),
  ]
}
