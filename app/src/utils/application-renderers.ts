/** Explicit app composition. Feature imports perform no renderer registration. */
import { markRaw, type Component } from 'vue'
import { ARTICLE_PLUGIN_ID } from '@frank/wallet/message-item-plugins/article'
import { INVOICE_PLUGIN_ID } from '@frank/wallet/message-item-plugins/invoice'
import { MENTAL_POKER_PLUGIN_ID } from '@frank/wallet/message-item-plugins/mental-poker'
import { NEWSLETTER_ARTICLE_ITEM_TYPE } from '@frank/wallet/message-item-plugins/newsletter'
import { WEBRTC_CALL_PLUGIN_ID } from '@frank/wallet/message-item-plugins/webrtc-call'
import ChatMessageArticle from '../components/chat/messages/ChatMessageArticle.vue'
import ChatMessageInvoice from '../components/chat/messages/ChatMessageInvoice.vue'
import ChatMessageMentalPoker from '../components/chat/messages/ChatMessageMentalPoker.vue'
import ChatMessageNewsletterArticle from '../components/chat/messages/ChatMessageNewsletterArticle.vue'
import ChatMessageWebRtcCall from '../components/chat/messages/ChatMessageWebRtcCall.vue'
import SignedNegotiationCard from '../swap/SignedNegotiationCard.vue'
const renderers: ReadonlyMap<string, Component> = new Map([
  ['swap-negotiation-v1', markRaw(SignedNegotiationCard)],
  [NEWSLETTER_ARTICLE_ITEM_TYPE, markRaw(ChatMessageNewsletterArticle)],
  [ARTICLE_PLUGIN_ID, markRaw(ChatMessageArticle)],
  [INVOICE_PLUGIN_ID, markRaw(ChatMessageInvoice)],
  [MENTAL_POKER_PLUGIN_ID, markRaw(ChatMessageMentalPoker)],
  [WEBRTC_CALL_PLUGIN_ID, markRaw(ChatMessageWebRtcCall)],
])
export function applicationRenderer(itemType: string): Component | undefined {
  return renderers.get(itemType)
}
