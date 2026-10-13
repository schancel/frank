/** @jest-environment jsdom */
import {
  isAccountBackedUp,
  markAccountBackedUp,
  clearAccountBackedUp,
} from './backup-status'

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
})
