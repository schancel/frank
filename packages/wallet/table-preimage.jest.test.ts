/**
 * The game-table HTLC preimage (`frank/table-htlc-preimage/v1`, `table-preimage.ts`): pinned
 * vectors from the public domain-root test vectors, the same on every handle of one account and
 * different for another table, another game or another account, and never the swap preimage of
 * the same bytes. The pinned values were checked against an independent HKDF-SHA256
 * (Python `hmac`). The roots here are published test data, not any account's keys.
 */
import { Mnemonic, getBytes } from 'ethers'
import vectors from '../domain-roots/vectors/domain-roots-v1.json'
import { BIP39_DERIVATION } from '../domain-roots/src'
import type { DomainPurpose, DomainRoot } from '../domain-roots/src'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from './evm-wallet-material'
import {
  TABLE_PREIMAGE_LABEL,
  deriveTablePreimage,
  tablePreimageInfo,
} from './table-preimage'
import { deriveSwapPreimage } from './swap-preimage'

function roots(index: number): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: new Uint8Array(
      Buffer.from(vectors.vectors[index]!.outputs[purpose], 'hex'),
    ),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const tableA = Uint8Array.from({ length: 16 }, (_, i) => i)
const tableB = Uint8Array.from({ length: 16 }, (_, i) => 0xff - i)

/** Pinned: changing any of these is a new derivation version (AGENTS.md §6). */
const PINNED = {
  account0: {
    pokerA: '17938716dd9938e384c32eda6e2e7cc499894ba4a28cd97c75dd282d7a99af1b',
    pokerB: '7606fca02c31f6b119cde79f904448cece19a41544903b1cf8f3b88b784e72ac',
    diceA: 'da4c9b1a0c99c26848617342d8a47e4de6b1f2671a9594dea8493e778f270646',
  },
  account1PokerA:
    'f0322f9717bb801ae106d3c17b3218cbc6fbd89751d7d879cf7c4e684d143d5c',
  historicalPokerA:
    '59a12bcf783729e4dd91b96645540913e08be9d994cf3e8d590f45b1e91fd0e4',
}

describe('table HTLC preimage derivation (frank/table-htlc-preimage/v1)', () => {
  it('is the pinned value, the same on two handles of one account', () => {
    const one = createMonadWalletMaterial(roots(0))
    const two = createMonadWalletMaterial(roots(0))
    try {
      const a = one.canonicalRoles!.tablePreimage({
        game: 'poker',
        tableId: tableA,
      })
      expect(a).toHaveLength(32)
      expect(hex(a)).toBe(PINNED.account0.pokerA)
      expect(
        hex(two.canonicalRoles!.tablePreimage({ game: 'poker', tableId: tableA })),
      ).toBe(PINNED.account0.pokerA)
      // A fresh copy each time: wiping one does not change the next.
      a.fill(0)
      expect(
        hex(one.canonicalRoles!.tablePreimage({ game: 'poker', tableId: tableA })),
      ).toBe(PINNED.account0.pokerA)
    } finally {
      one.dispose()
      two.dispose()
    }
  })

  it('differs by table id, by game and by account, and from the swap preimage', () => {
    const zero = createMonadWalletMaterial(roots(0))
    const one = createMonadWalletMaterial(roots(1))
    try {
      const p = (m: typeof zero, game: string, tableId: Uint8Array) =>
        hex(m.canonicalRoles!.tablePreimage({ game, tableId }))
      expect(p(zero, 'poker', tableB)).toBe(PINNED.account0.pokerB)
      expect(p(zero, 'liars-dice', tableA)).toBe(PINNED.account0.diceA)
      expect(p(one, 'poker', tableA)).toBe(PINNED.account1PokerA)
      const all = [
        p(zero, 'poker', tableA),
        p(zero, 'poker', tableB),
        p(zero, 'liars-dice', tableA),
        p(one, 'poker', tableA),
        // The same name and bytes under the swap label: another secret.
        hex(
          deriveSwapPreimage(
            roots(0).messaging.bytes,
            'poker',
            Uint8Array.of(...tableA, ...tableA),
          ),
        ),
      ]
      expect(new Set(all).size).toBe(all.length)
    } finally {
      zero.dispose()
      one.dispose()
    }
  })

  it('a historical BIP39 account derives from its whole seed, the same on every handle', () => {
    const phrase = 'test test test test test test test test test test test junk'
    const seed = () => getBytes(Mnemonic.fromPhrase(phrase).computeSeed())
    const one = createMonadWalletMaterial({
      derivation: BIP39_DERIVATION,
      seed: seed(),
    })
    const two = createMonadWalletMaterial({
      derivation: BIP39_DERIVATION,
      seed: seed(),
    })
    try {
      const value = hex(
        one.canonicalRoles!.tablePreimage({ game: 'poker', tableId: tableA }),
      )
      expect(value).toBe(PINNED.historicalPokerA)
      expect(
        hex(two.canonicalRoles!.tablePreimage({ game: 'poker', tableId: tableA })),
      ).toBe(value)
      expect(hex(deriveTablePreimage(seed(), 'poker', tableA))).toBe(value)
    } finally {
      one.dispose()
      two.dispose()
    }
  })

  it('is HKDF-SHA256 under the label, with a length-prefixed game name', () => {
    expect(TABLE_PREIMAGE_LABEL).toBe('frank/table-htlc-preimage/v1')
    expect(hex(tablePreimageInfo('ab', tableA))).toBe('02' + '6162' + hex(tableA))
    expect(
      hex(tablePreimageInfo('a', Uint8Array.of(0x62, ...tableA.slice(0, 15)))),
    ).not.toBe(hex(tablePreimageInfo('ab', tableA)))
    expect(
      hex(deriveTablePreimage(roots(0).messaging.bytes, 'poker', tableA)),
    ).toBe(PINNED.account0.pokerA)
  })

  it('refuses a bad table id or game, and a disposed account', () => {
    const material = createMonadWalletMaterial(roots(0))
    const roles = material.canonicalRoles!
    for (const tableId of [
      new Uint8Array(15),
      new Uint8Array(32),
      'ab' as never,
    ])
      expect(() => roles.tablePreimage({ game: 'poker', tableId })).toThrow(
        'Table id',
      )
    for (const game of ['', 'x'.repeat(256), 7 as never])
      expect(() => roles.tablePreimage({ game, tableId: tableA })).toThrow(
        'Table game',
      )
    expect(() => deriveTablePreimage(new Uint8Array(16), 'poker', tableA)).toThrow(
      RangeError,
    )
    material.dispose()
    expect(() => roles.tablePreimage({ game: 'poker', tableId: tableA })).toThrow(
      'disposed',
    )
  })
})
