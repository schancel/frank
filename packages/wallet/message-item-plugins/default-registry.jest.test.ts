import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import * as ts from 'typescript'

import type { MessageItem } from '@frank/cashweb/types/messages'

import {
  DEFAULT_MESSAGE_ITEM_PLUGINS,
  createDefaultMessageItemRegistry,
  installMessageItemPlugin,
} from './default-registry'
import {
  MessageItemPluginAlreadyRegisteredError,
  createMessageItemRegistry,
  pluginCapabilitiesNotYetAvailable,
  type MessageItemCapabilityProvider,
} from './registry'

// Adding a member to `MessageItem` without listing it here does not compile.
const EVERY_ITEM_TYPE: Record<MessageItem['type'], true> = {
  'stealth': true,
  'p2pkh': true,
  'text': true,
  'reply': true,
  'image': true,
  'blackjack-move': true,
  'blackjack-hand': true,
  'digital-goods': true,
  'raffle': true,
  'swap-offer': true,
  'swap-record': true,
  'received-coin': true,
  'conversation-state': true,
  'device-claim': true,
  'rps': true,
  'dice': true,
  'liars-dice': true,
  'poker': true,
  'channel-update': true,
  'wallet-sync': true,
  'payment-transfer': true,
  'email': true,
  // Not a plugin: what a reader keeps in place of an item it cannot interpret.
  'unsupported': true,
}

/** `MessageItem` members that deliberately have no plugin. */
const NOT_PLUGINS = new Set(['unsupported'])

/** The `type` literals of `MessageItem`, read from the declaration by the TypeScript checker, so
 * this does not depend on the list above being kept in step by hand. */
function declaredItemTypes(): string[] {
  const walletRoot = join(__dirname, '..')
  const configPath = join(walletRoot, 'tsconfig.json')
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    walletRoot,
  )
  const file = join(walletRoot, '..', 'cashweb', 'types', 'messages.ts')
  const program = ts.createProgram([file], { ...config.options, noEmit: true })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(file)
  if (!source) throw new Error('messages.ts not loaded')
  const alias = source.statements.find(
    (s): s is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(s) && s.name.text === 'MessageItem',
  )
  if (!alias) throw new Error('MessageItem not found')
  const union = checker.getTypeAtLocation(alias.name)
  const members = union.isUnion() ? union.types : [union]
  const out = new Set<string>()
  for (const member of members) {
    const property = member.getProperty('type')
    if (!property) throw new Error('a MessageItem member has no type property')
    const type = checker.getTypeOfSymbolAtLocation(property, alias)
    for (const literal of type.isUnion() ? type.types : [type]) {
      if (!literal.isStringLiteral())
        throw new Error('a MessageItem type is not a string literal')
      out.add(literal.value)
    }
  }
  return [...out].sort()
}

describe('default message item registry', () => {
  it('importing the plugins registers nothing', () => {
    // Every plugin module is loaded by the import of ./default-registry above.
    expect(DEFAULT_MESSAGE_ITEM_PLUGINS.length).toBeGreaterThan(0)
    expect(createMessageItemRegistry().types()).toEqual([])
  })

  it('installs one plugin per listed type, in order, into a fresh registry each call', () => {
    const first = createDefaultMessageItemRegistry(
      pluginCapabilitiesNotYetAvailable,
    )
    const second = createDefaultMessageItemRegistry(
      pluginCapabilitiesNotYetAvailable,
    )
    const listed = DEFAULT_MESSAGE_ITEM_PLUGINS.map(([type]) => type)
    expect(first.types()).toEqual(listed)
    expect(second.types()).toEqual(listed)
    expect(first).not.toBe(second)
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('covers every MessageItem type declared in cashweb, and nothing else', () => {
    const declared = declaredItemTypes()
    expect(Object.keys(EVERY_ITEM_TYPE).sort()).toEqual(declared)
    expect(DEFAULT_MESSAGE_ITEM_PLUGINS.map(([type]) => type).sort()).toEqual(
      declared.filter(type => !NOT_PLUGINS.has(type)),
    )
    // An item no reader could interpret is never given a plugin, so it can never be sent.
    const registry = createDefaultMessageItemRegistry(
      pluginCapabilitiesNotYetAvailable,
    )
    for (const type of NOT_PLUGINS) expect(registry.has(type)).toBe(false)
  }, 120_000)

  it('has exactly one directory per plugin, each with plugin.ts and codec.ts', () => {
    const notPlugins = new Set(['shared', 'blackjack'])
    const directories = readdirSync(__dirname)
      .filter(name => statSync(join(__dirname, name)).isDirectory())
      .filter(name => !notPlugins.has(name))
      .sort()
    expect(directories).toEqual(
      DEFAULT_MESSAGE_ITEM_PLUGINS.map(([type]) => type).sort(),
    )
    for (const directory of directories) {
      const files = readdirSync(join(__dirname, directory))
      expect(files).toEqual(expect.arrayContaining(['plugin.ts', 'codec.ts']))
    }
  })

  it('binds each plugin to capabilities for its own type', () => {
    const asked: string[] = []
    const provider: MessageItemCapabilityProvider = {
      forPlugin(type) {
        asked.push(type)
        return pluginCapabilitiesNotYetAvailable.forPlugin(type)
      },
    }
    const registry = createDefaultMessageItemRegistry(provider)
    expect(asked).toEqual(registry.types())
  })

  it('cannot be built without a capability provider', () => {
    expect(() => createDefaultMessageItemRegistry(undefined as never)).toThrow()
  })

  it('refuses a plugin that registers another type, or the same type twice', () => {
    const [, initText] = DEFAULT_MESSAGE_ITEM_PLUGINS.find(
      ([t]) => t === 'text',
    )!
    const registry = createMessageItemRegistry()
    expect(() =>
      installMessageItemPlugin(
        registry,
        pluginCapabilitiesNotYetAvailable,
        'image',
        initText,
      ),
    ).toThrow('must register exactly its own type')
    expect(() =>
      installMessageItemPlugin(
        registry,
        pluginCapabilitiesNotYetAvailable,
        'text',
        initText,
      ),
    ).toThrow(MessageItemPluginAlreadyRegisteredError)
  })

  it('no file outside the composition imports a plugin module', () => {
    // The wallet's send, receive and custody code may depend on ./registry only.
    const walletRoot = join(__dirname, '..')
    const offenders: string[] = []
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name)
        if (name === 'node_modules' || name === 'message-item-plugins') continue
        if (statSync(path).isDirectory()) visit(path)
        else if (
          /\.ts$/.test(name) &&
          !/\.(jest\.test|testutil|livecheck)\.ts$/.test(name) &&
          /message-item-plugins\/(default-registry|[a-z0-9-]+\/(plugin|codec))['"]/.test(
            readFileSync(path, 'utf8'),
          )
        )
          offenders.push(path.slice(walletRoot.length + 1))
      }
    }
    visit(walletRoot)
    expect(offenders).toEqual([])
  })

  it('the canonical message path takes its items from the registry contract and the wire rule only', () => {
    const importsOf = (file: string) =>
      [
        ...readFileSync(join(__dirname, '..', file), 'utf8').matchAll(
          /from\s+['"]([^'"]*message-item-plugins[^'"]*|\.\/[^'"]*)['"]/g,
        ),
      ].map(match => match[1])
    expect(
      importsOf('chain/monad-canonical-dm.ts').filter(path =>
        path.includes('message-item-plugins'),
      ),
    ).toEqual([
      '../message-item-plugins/registry',
      '../message-item-plugins/wire',
    ])
    // The contract and the wire rule themselves name no plugin and no composition.
    expect(importsOf('message-item-plugins/registry.ts')).toEqual([])
    expect(importsOf('message-item-plugins/wire.ts')).toEqual(['./registry'])
    // The old hard-coded chain is gone: the path encodes and projects no item type itself.
    const source = readFileSync(
      join(__dirname, '..', 'chain/monad-canonical-dm.ts'),
      'utf8',
    )
    expect(source).not.toMatch(
      /encode(BlackjackHandV3|ChannelUpdate|EmailMessage|StealthMessage)Item|directMessageText|cannot carry/,
    )
  })
})
