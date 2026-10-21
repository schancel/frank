/** @jest-environment jsdom */
import { webcrypto } from 'crypto'
import { exportHistoricalCodex32Backup } from '@frank/account-recovery'
import {
  isAccountBackedUp,
  markAccountBackedUp,
  clearAccountBackedUp,
  verifyAccountBackup,
} from './backup-status'
import { bip39Descriptor } from './custody/bip39'
import type { PublicAccount } from './custody'

describe('backup-status tracking', () => {
  beforeEach(() => {
    localStorage.clear()
    clearAccountBackedUp()
  })

  it('reports false for null or undefined accountId', () => {
    expect(isAccountBackedUp(null)).toBe(false)
    expect(isAccountBackedUp(undefined)).toBe(false)
    expect(isAccountBackedUp('')).toBe(false)
  })

  it('reports false for unbacked account and true after marking backed up', () => {
    const id = 'acc-123'
    expect(isAccountBackedUp(id)).toBe(false)
    markAccountBackedUp(id)
    expect(isAccountBackedUp(id)).toBe(true)
  })

  it('persists backed up account IDs in localStorage across calls', () => {
    markAccountBackedUp('acc-1')
    markAccountBackedUp('acc-2')
    expect(isAccountBackedUp('acc-1')).toBe(true)
    expect(isAccountBackedUp('acc-2')).toBe(true)
    expect(isAccountBackedUp('acc-3')).toBe(false)
  })

  it('allows clearing backed up status', () => {
    markAccountBackedUp('acc-1')
    expect(isAccountBackedUp('acc-1')).toBe(true)
    clearAccountBackedUp('acc-1')
    expect(isAccountBackedUp('acc-1')).toBe(false)
  })

  describe('verifyAccountBackup for a historical BIP39 account', () => {
    const random = (length: number) =>
      webcrypto.getRandomValues(new Uint8Array(length))
    const seed = Uint8Array.from({ length: 64 }, (_, i) => i + 1)
    const other = Uint8Array.from({ length: 64 }, (_, i) => 200 - i)
    const account = {
      displayName: '',
      descriptor: bip39Descriptor(seed).descriptor,
      receipt: { context: { accountId: 'historical' } },
    } as unknown as PublicAccount
    const sharesOf = (secret: Uint8Array) => [
      ...exportHistoricalCodex32Backup({
        seed: secret.slice(),
        threshold: 2,
        shareCount: 3,
        randomBytes: random,
      }),
    ]

    it('marks the account backed up when its own shares verify', () => {
      verifyAccountBackup(account, sharesOf(seed).slice(0, 2).join('\n'))
      expect(isAccountBackedUp('historical')).toBe(true)
    })

    it("rejects another seed's shares and records nothing", () => {
      expect(() =>
        verifyAccountBackup(account, sharesOf(other).slice(0, 2).join('\n')),
      ).toThrow(/descriptor-mismatch/)
      expect(isAccountBackedUp('historical')).toBe(false)
    })
  })
})
