/**
 * The buy-in escrow fields of the table games (poker key 19/20, liar's dice key 23/24): pinned
 * golden bytes for a table item carrying the arbiter's terms and a join carrying the player's
 * lock, and refusal of every malformed form on read and on write (AGENTS.md §4: a malformed
 * known item fails validation; it is never seated).
 */
import { decodeCanonical, encodeCanonical, type Encodable } from '@frank/codec'
import type {
  LiarsDiceItem,
  MessageItem,
  PokerItem,
} from '@frank/cashweb/types/messages'
import {
  MessageItemDecodeError,
  MessageItemEncodeError,
  type MessageItemPluginInit,
} from '@frank/cashweb/message-items/registry'
import { registryWith, standaloneDecodeContext } from './plugin-contract.testutil'
import { initPokerPlugin } from '../poker/plugin'
import { initLiarsDicePlugin } from '../liars-dice/plugin'

const TABLE_ID = '0f'.repeat(16)
const escrow = {
  arbiter: '0x' + 'ab'.repeat(20),
  hashLock: '0x' + 'cd'.repeat(32),
  expiresAt: 1_760_086_400,
}
const buyInLock = {
  lockId: '0x' + 'ef'.repeat(32),
  account: '0x' + '12'.repeat(20),
  signature: '0x' + 'ab'.repeat(65),
}

const games: Array<{
  type: 'poker' | 'liars-dice'
  init: MessageItemPluginInit
  table: MessageItem
  join: MessageItem
  keys: { escrow: number; buyInLock: number }
  golden: { table: string; join: string }
}> = [
  {
    type: 'poker',
    init: initPokerPlugin,
    table: {
      type: 'poker',
      tableId: TABLE_ID,
      action: 'create',
      buyInWei: '100000000000000000',
      smallBlind: 10,
      bigBlind: 20,
      pot: 0,
      escrow,
    } satisfies PokerItem,
    join: {
      type: 'poker',
      tableId: TABLE_ID,
      action: 'join',
      smallBlind: 10,
      bigBlind: 20,
      pot: 0,
      buyInLock,
    } satisfies PokerItem,
    keys: { escrow: 19, buyInLock: 20 },
    golden: { table: 'a7007820306630663066306630663066306630663066306630663066306630663066306601666372656174650272313030303030303030303030303030303030030a0414060013a300782a307861626162616261626162616261626162616261626162616261626162616261626162616261626162017842307863646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364021a68e8c980', join: 'a6007820306630663066306630663066306630663066306630663066306630663066306601646a6f696e030a0414060014a300784230786566656665666566656665666566656665666566656665666566656665666566656665666566656665666566656665666566656665666566656665666566656601782a307831323132313231323132313231323132313231323132313231323132313231323132313231323132027884307861626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162' },
  },
  {
    type: 'liars-dice',
    init: initLiarsDicePlugin,
    table: {
      type: 'liars-dice',
      tableId: TABLE_ID,
      action: 'create',
      buyInWei: '100000000000000000',
      maxPlayers: 4,
      escrow,
    } satisfies LiarsDiceItem,
    join: {
      type: 'liars-dice',
      tableId: TABLE_ID,
      action: 'join',
      buyInLock,
    } satisfies LiarsDiceItem,
    keys: { escrow: 23, buyInLock: 24 },
    golden: { table: 'a5007820306630663066306630663066306630663066306630663066306630663066306601666372656174650272313030303030303030303030303030303030030417a300782a307861626162616261626162616261626162616261626162616261626162616261626162616261626162017842307863646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364021a68e8c980', join: 'a3007820306630663066306630663066306630663066306630663066306630663066306601646a6f696e1818a300784230786566656665666566656665666566656665666566656665666566656665666566656665666566656665666566656665666566656665666566656665666566656601782a307831323132313231323132313231323132313231323132313231323132313231323132313231323132027884307861626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162' },
  },
]

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe.each(games)('$type buy-in escrow fields', game => {
  const registry = registryWith(game.type, game.init)
  const decode = (bytes: Uint8Array) =>
    registry.decodeItem(game.type, bytes, standaloneDecodeContext())
  /** The item's own bytes with field `key` replaced by `value` (or removed when undefined). */
  const withField = (item: MessageItem, key: number, value?: Encodable) => {
    const decoded = decodeCanonical(registry.encodeItem(item).bytes) as Map<
      bigint,
      Encodable
    >
    const map = new Map<number, Encodable>(
      [...decoded.entries()].map(([k, v]) => [Number(k), v]),
    )
    if (value === undefined) map.delete(key)
    else map.set(key, value)
    return encodeCanonical(map)
  }

  it('golden bytes: the table item with the escrow terms and the join with the lock', () => {
    const table = registry.encodeItem(game.table).bytes
    const join = registry.encodeItem(game.join).bytes
    expect(hex(table)).toBe(game.golden.table)
    expect(hex(join)).toBe(game.golden.join)
    expect(decode(table)).toEqual({ kind: 'item', item: game.table })
    expect(decode(join)).toEqual({ kind: 'item', item: game.join })
  })

  const lockMap = (
    lockId: Encodable,
    account: Encodable,
    signature: Encodable = buyInLock.signature,
  ) =>
    new Map<number, Encodable>([
      [0, lockId],
      [1, account],
      [2, signature],
    ])
  const termsMap = (arbiter: Encodable, hashLock: Encodable, expiresAt: Encodable) =>
    new Map<number, Encodable>([
      [0, arbiter],
      [1, hashLock],
      [2, expiresAt],
    ])

  it.each([
    ['an upper-case lock id', lockMap(buyInLock.lockId.toUpperCase().replace('0X', '0x'), buyInLock.account)],
    ['a lock id without 0x', lockMap(buyInLock.lockId.slice(2), buyInLock.account)],
    ['a 31-byte lock id', lockMap(buyInLock.lockId.slice(0, -2), buyInLock.account)],
    ['a lock id as bytes', lockMap(new Uint8Array(32), buyInLock.account)],
    ['an account that is not an address', lockMap(buyInLock.lockId, '0x1234')],
    ['no account', new Map<number, Encodable>([[0, buyInLock.lockId], [2, buyInLock.signature]])],
    ['no signature', new Map<number, Encodable>([[0, buyInLock.lockId], [1, buyInLock.account]])],
    ['a 64-byte signature', lockMap(buyInLock.lockId, buyInLock.account, buyInLock.signature.slice(0, -2))],
    ['an upper-case signature', lockMap(buyInLock.lockId, buyInLock.account, '0x' + 'AB'.repeat(65))],
    ['an unknown key', new Map<number, Encodable>([...lockMap(buyInLock.lockId, buyInLock.account), [3, 1n]])],
  ])('refuses a join whose lock has %s', (_, lock) => {
    expect(() => decode(withField(game.join, game.keys.buyInLock, lock))).toThrow(
      MessageItemDecodeError,
    )
  })

  it.each([
    ['a zero deadline', termsMap(escrow.arbiter, escrow.hashLock, 0n)],
    ['a 31-byte hash lock', termsMap(escrow.arbiter, escrow.hashLock.slice(0, -2), BigInt(escrow.expiresAt))],
    ['an arbiter that is not an address', termsMap('arbiter', escrow.hashLock, BigInt(escrow.expiresAt))],
    ['no hash lock', new Map<number, Encodable>([[0, escrow.arbiter], [2, BigInt(escrow.expiresAt)]])],
  ])('refuses table terms with %s', (_, terms) => {
    expect(() => decode(withField(game.table, game.keys.escrow, terms))).toThrow(
      MessageItemDecodeError,
    )
  })

  it('refuses a buy-in lock on anything but a join, on read and on write', () => {
    const notJoin = { ...game.table, buyInLock } as MessageItem
    expect(() => registry.encodeItem(notJoin)).toThrow(MessageItemEncodeError)
    expect(() =>
      decode(withField(game.table, game.keys.buyInLock, lockMap(buyInLock.lockId, buyInLock.account))),
    ).toThrow(MessageItemDecodeError)
  })
})
