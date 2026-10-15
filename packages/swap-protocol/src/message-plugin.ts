/** Inert transport projection. Schema/signature validation never admits an operation. */
import { standaloneItemBudget, type NestedItemBudget } from '@frank/codec'
import {
  decodeNegotiationEventSchema,
  negotiationLimits,
  type NegotiationEvent,
  type NegotiationPairPolicy,
} from './negotiation'

export const NEGOTIATION_ITEM_TYPE = 'swap-negotiation-v1'
export interface NegotiationMessageValue {
  readonly eventHex: string
}

/** Structural descriptor consumed by the application's neutral carrier registry. */
export function createNegotiationMessagePlugin(
  selectedPolicy: NegotiationPairPolicy,
) {
  const policy = Object.freeze({ ...selectedPolicy })
  // Only plugin-created frozen projections are trusted here. JSON-restored values must be
  // validated again. This avoids parsing a received payload twice when the bridge calls read.
  const validated = new WeakMap<
    NegotiationMessageValue,
    NegotiationEvent['kind']
  >()
  function projection(
    eventHex: string,
    kind: NegotiationEvent['kind'],
  ): NegotiationMessageValue {
    const value = Object.freeze({ eventHex })
    validated.set(value, kind)
    return value
  }
  function bytes(eventHex: string): Uint8Array {
    return Uint8Array.from(eventHex.match(/../g) ?? [], byte =>
      parseInt(byte, 16),
    )
  }
  function parse(
    encoded: Uint8Array,
    budget: NestedItemBudget,
  ): NegotiationEvent {
    const parsed = decodeNegotiationEventSchema(encoded, policy, budget)
    if (!parsed.ok)
      throw new TypeError(`Invalid negotiation event: ${parsed.error.code}`)
    return parsed.value
  }
  function read(raw: unknown): NegotiationMessageValue {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      (Object.getPrototypeOf(raw) !== Object.prototype &&
        Object.getPrototypeOf(raw) !== null)
    )
      throw new TypeError('Expected negotiation projection')
    const keys = Reflect.ownKeys(raw)
    const field = Object.getOwnPropertyDescriptor(raw, 'eventHex')
    if (
      keys.length !== 1 ||
      keys[0] !== 'eventHex' ||
      !field?.enumerable ||
      !('value' in field) ||
      typeof field.value !== 'string' ||
      field.value.length === 0 ||
      field.value.length > negotiationLimits.eventBytes * 2 ||
      !/^(?:[0-9a-f]{2})+$/.test(field.value)
    )
      throw new TypeError('Expected exact canonical eventHex projection')
    const value = raw as NegotiationMessageValue
    if (validated.has(value)) return value
    const event = parse(bytes(field.value), standaloneItemBudget())
    return projection(field.value, event.kind)
  }
  return {
    itemType: NEGOTIATION_ITEM_TYPE,
    read,
    encode(value: NegotiationMessageValue): Uint8Array {
      return bytes(read(value).eventHex)
    },
    decode(
      encoded: Uint8Array,
      context: { budget: NestedItemBudget },
    ): NegotiationMessageValue {
      const owned = new Uint8Array(encoded)
      const event = parse(owned, context.budget)
      const eventHex = Array.from(owned, byte =>
        byte.toString(16).padStart(2, '0'),
      ).join('')
      return projection(eventHex, event.kind)
    },
    previewText(value: NegotiationMessageValue): string {
      const kind = validated.get(read(value))
      return kind === 'offer'
        ? 'Swap offer'
        : kind === 'accept'
        ? 'Swap acceptance message'
        : 'Swap rejection message'
    },
  }
}
