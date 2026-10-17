/** Explicit app composition. Feature imports perform no renderer registration. */
import { markRaw, type Component } from 'vue'
import { NEWSLETTER_ARTICLE_ITEM_TYPE } from '@frank/wallet/message-item-plugins/newsletter'
import ChatMessageNewsletterArticle from '../components/chat/messages/ChatMessageNewsletterArticle.vue'
import SignedNegotiationCard from '../swap/SignedNegotiationCard.vue'
const renderers: ReadonlyMap<string, Component> = new Map([
  ['swap-negotiation-v1', markRaw(SignedNegotiationCard)],
  [NEWSLETTER_ARTICLE_ITEM_TYPE, markRaw(ChatMessageNewsletterArticle)],
])
export function applicationRenderer(itemType: string): Component | undefined {
  return renderers.get(itemType)
}
