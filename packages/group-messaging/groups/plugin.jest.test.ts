import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import {
  encodeCanonical,
  encodeFrame,
  validateFrame,
  type Encodable,
  fromHex,
  standaloneItemBudget,
  toHex,
} from '@frank/codec'
import {
  createMessageItemRegistry,
  MessageItemDecodeError,
  MessageItemUnsupportedError,
  pluginCapabilitiesNotYetAvailable,
} from '@frank/cashweb/message-items/registry'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import {
  decodeItemFrames,
  encodeItemFrames,
} from '@frank/wallet/message-item-plugins/wire'
import { messageItems as appRegistry } from '../../../app/src/utils/message-items'
import { overTheWire as botReceive } from '../../bot/src/bots/wire.testutil'
import { installGroupMessageItemPlugins } from './plugin'
import type { GroupWelcomeItem, GroupControlItem } from '../types'
import fixtures from '../fixtures/wire-v1.json'

const samples = fixtures as Array<{
  item: GroupWelcomeItem | GroupControlItem
  hex: string
}>
const caps = pluginCapabilitiesNotYetAvailable
const registry = () =>
  installGroupMessageItemPlugins(createMessageItemRegistry(), caps)

it('preserves exact pre-extraction CBOR bytes and round trips both feature payloads', () => {
  const host = registry()
  for (const { item, hex } of samples) {
    expect(toHex(host.encodeItem(item).bytes)).toBe(hex)
    expect(
      host.decodeItem(item.type, fromHex(hex), {
        budget: standaloneItemBudget(),
      }),
    ).toEqual({ kind: 'item', item })
  }
})

it('requires explicit runtime installation even when feature types and modules are imported', () => {
  const host = createDefaultMessageItemRegistry(caps)
  for (const { item, hex } of samples) {
    expect(host.has(item.type)).toBe(false)
    expect(() => host.encodeItem(item)).toThrow(MessageItemUnsupportedError)
    expect(
      host.decodeItem(item.type, fromHex(hex), {
        budget: standaloneItemBudget(),
      }),
    ).toEqual({ kind: 'unsupported', type: item.type, bytes: fromHex(hex) })
  }
  installGroupMessageItemPlugins(host, caps)
  expect(host.has('group-welcome')).toBe(true)
  expect(host.has('group-control')).toBe(true)
  expect(createMessageItemRegistry().types()).toEqual([])
})

it('keeps an unknown feature opaque but rejects malformed known payloads', () => {
  const host = registry()
  const bytes = encodeCanonical(new Map([[0, 'invalid-certificate']]))
  expect(
    host.decodeItem('group-future', bytes, { budget: standaloneItemBudget() })
      .kind,
  ).toBe('unsupported')
  for (const { item } of samples)
    expect(() =>
      host.decodeItem(item.type, bytes, { budget: standaloneItemBudget() }),
    ).toThrow(MessageItemDecodeError)
})

it('charges certificate traversal to the enclosing budget without resetting it', () => {
  for (const { item, hex } of samples) {
    const host = registry()
    const budget = standaloneItemBudget()
    // Consume all 16,384 container slots in the enclosing validation session first.
    const containers = encodeCanonical(Array.from({ length: 8_191 }, () => []))
    budget.decodeCbor(containers)
    budget.decodeCbor(containers)
    expect(() => host.decodeItem(item.type, fromHex(hex), { budget })).toThrow(
      MessageItemDecodeError,
    )
    expect(
      host.decodeItem(item.type, fromHex(hex), {
        budget: standaloneItemBudget(),
      }).kind,
    ).toBe('item')
  }
})

it('the app composition sends both group payloads to a headless bot and accepts its reply', () => {
  const items = samples.map(sample => sample.item)
  const frames = encodeItemFrames(appRegistry, items)
  // The bot's real composition and wire reader round-trip what the app writer produced.
  const revision = validateFrame(
    encodeFrame(
      { typeId: 20, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([
        [0, 'frank'],
        [1, frames],
      ]),
    ),
  )
  if (revision.kind !== 'parsed' || revision.typed?.type !== 20)
    throw new Error('expected revision')
  const decoded = decodeItemFrames(
    registry(),
    revision.typed.items,
    standaloneItemBudget(),
  )
  expect(decoded).toEqual(items)
  expect(botReceive(decoded)).toEqual(items)
  expect(appRegistry.previewText(botReceive(items)[0]!)).toBe(
    'Group invite: Shared Mailbox Team',
  )
})

it('enforces feature ownership and neutral dependency direction without a wallet backedge', () => {
  const root = resolve(__dirname, '../../..')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      if (name === 'node_modules' || name === 'dist') return []
      const path = join(dir, name)
      return statSync(path).isDirectory()
        ? files(path)
        : /\.ts$/.test(name) &&
          !/\.(?:jest\.test|testutil|livecheck)\.ts$/.test(name)
        ? [path]
        : []
    })
  for (const path of [
    ...files(join(root, 'packages/group-messaging')),
    ...files(join(root, 'packages/cashweb/message-items')),
  ])
    expect(readFileSync(path, 'utf8')).not.toMatch(
      /(?:from|import)\s*(?:\()?['"][^'"]*(?:@frank\/wallet|\/wallet\/)/,
    )
  for (const path of files(join(root, 'packages/wallet')))
    expect(readFileSync(path, 'utf8')).not.toMatch(
      /(?:from|import)\s*(?:\()?['"]@frank\/group-messaging/,
    )
  for (const name of [
    'welcome-codec.ts',
    'control-codec.ts',
    'epoch-certificate.ts',
  ])
    expect(readFileSync(join(__dirname, name), 'utf8')).not.toMatch(
      /(?:from|import)\s*(?:\()?['"][^'"]*(?:vue|pinia|wallet|group-relay-client|plugin)/,
    )
  expect(
    readFileSync(join(root, 'packages/cashweb/types/messages.ts'), 'utf8'),
  ).not.toMatch(/group-welcome|group-control|@frank\/group-messaging/)
})
