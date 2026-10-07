/** @jest-environment jsdom */

import { setActivePinia, createPinia } from 'pinia'
import { useLeaderStore, generateInstanceId } from './leader'

describe('useLeaderStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('initializes with a persistent instance ID and defaults to active master', () => {
    const store = useLeaderStore()
    expect(store.myInstanceId).toBeDefined()
    expect(store.myInstanceId.length).toBeGreaterThan(0)
    expect(store.isActiveMaster).toBe(true)
    expect(store.isStandby).toBe(false)
  })

  it('updates state and yields active role when another instance claims leadership', () => {
    const store = useLeaderStore()
    expect(store.isActiveMaster).toBe(true)

    const otherInstanceId = 'other-device-uuid-1234'
    store.handleIncomingClaim({
      instanceId: otherInstanceId,
      deviceName: 'Alice Phone',
      claimedAt: Date.now(),
    })

    expect(store.masterInstanceId).toBe(otherInstanceId)
    expect(store.masterDeviceName).toBe('Alice Phone')
    expect(store.isActiveMaster).toBe(false)
    expect(store.isStandby).toBe(true)
  })

  it('claims master role and becomes active master again', () => {
    const store = useLeaderStore()

    // Step 1: Yield to other device
    store.handleIncomingClaim({
      instanceId: 'other-uuid',
      deviceName: 'Desktop',
      claimedAt: 1000,
    })
    expect(store.isActiveMaster).toBe(false)

    // Step 2: Claim master on this instance
    store.claimMasterRole()
    expect(store.isActiveMaster).toBe(true)
    expect(store.masterInstanceId).toBe(store.myInstanceId)
    expect(store.isStandby).toBe(false)
  })

  it('ignores older incoming claims', () => {
    const store = useLeaderStore()
    store.claimMasterRole()
    const myClaimTime = store.masterClaimedAt

    // Receive a stale claim from past
    store.handleIncomingClaim({
      instanceId: 'stale-uuid',
      deviceName: 'Old Tablet',
      claimedAt: myClaimTime - 10_000,
    })

    expect(store.isActiveMaster).toBe(true)
    expect(store.masterInstanceId).toBe(store.myInstanceId)
  })

  it('generates unique instance IDs', () => {
    const id1 = generateInstanceId()
    const id2 = generateInstanceId()
    expect(id1).not.toBe(id2)
  })
})
