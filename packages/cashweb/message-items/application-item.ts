import { isPluginItemType, MAX_DEPTH, MAX_ITEMS } from '@frank/codec'
import type { MessageItem } from '../types/messages'

/** The dispatch identifier is independent of the neutral carrier's discriminator. */
export function messageItemType(
  item: Pick<MessageItem, 'type'> & { itemType?: unknown },
): string {
  if (item.type !== 'application') return item.type
  if (
    !('itemType' in item) ||
    !isPluginItemType(item.itemType) ||
    item.itemType === 'application'
  )
    throw new TypeError('Invalid application item identifier')
  return item.itemType
}

/** Raw application values survive ordinary JSON storage without a custom reader or migration. */
export function validateApplicationValue(value: unknown): void {
  const ancestors = new Set<object>()
  let items = 0
  function visit(node: unknown, depth: number): void {
    if (++items > MAX_ITEMS || depth > MAX_DEPTH)
      throw new TypeError('Application value exceeds structural limits')
    if (node === null || typeof node === 'string' || typeof node === 'boolean')
      return
    if (
      typeof node === 'number' &&
      Number.isFinite(node) &&
      !Object.is(node, -0)
    )
      return
    if (typeof node !== 'object' || node === null || ancestors.has(node))
      throw new TypeError('Application value must be JSON-safe')
    if (Array.isArray(node) && Object.getPrototypeOf(node) !== Array.prototype)
      throw new TypeError('Application value must contain plain arrays')
    if (
      !Array.isArray(node) &&
      Object.getPrototypeOf(node) !== Object.prototype &&
      Object.getPrototypeOf(node) !== null
    )
      throw new TypeError(
        'Application value must contain plain objects or arrays',
      )
    ancestors.add(node)
    if (Reflect.ownKeys(node).some(key => typeof key !== 'string'))
      throw new TypeError('Application value must not contain symbol keys')
    for (const [key, property] of Object.entries(
      Object.getOwnPropertyDescriptors(node),
    )) {
      if (Array.isArray(node) && key === 'length') continue
      if (!property.enumerable || !('value' in property))
        throw new TypeError(
          'Application value must contain enumerable data properties',
        )
      visit(property.value, depth + 1)
    }
    if (
      Array.isArray(node) &&
      (Object.keys(node).length !== node.length ||
        Object.keys(node).some((key, index) => key !== String(index)))
    )
      throw new TypeError('Application value must contain dense arrays')
    ancestors.delete(node)
  }
  visit(value, 0)
}
