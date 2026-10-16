/** Explicit app composition. Feature imports perform no renderer registration. */
import { markRaw, type Component } from 'vue'
import SignedNegotiationCard from '../swap/SignedNegotiationCard.vue'
const renderers: ReadonlyMap<string, Component> = new Map([
  ['swap-negotiation-v1', markRaw(SignedNegotiationCard)],
])
export function applicationRenderer(itemType: string): Component | undefined {
  return renderers.get(itemType)
}
