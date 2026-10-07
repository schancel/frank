/** @jest-environment jsdom */
import { setActivePinia, createPinia } from 'pinia'
import {
  useTabCoordinatorStore,
  generateTabId,
  type TabSyncMessage,
} from './tab-coordinator'
import { accountSession, accountStatus } from '../accounts/session'
import { useLeaderStore } from './leader'

jest.mock('../accounts/session', () => ({
  accountStatus: jest.requireActual('vue').reactive({
    status: 'ready',
    revision: 1,
    account: { receipt: { context: { accountId: 'acc-1' } } },
    pending: null,
    pendingReady: false,
    pendingError: null,
    error: null,
  }),
  accountSession: {
    initialize: jest.fn(async () => undefined),
    retry: jest.fn(async () => undefined),
    yieldCustody: jest.fn(async () => undefined),
    setStandby: jest.fn(),
  },
}))

jest.mock('./leader', () => ({
  useLeaderStore: jest.fn(() => ({
    claimMasterRole: jest.fn(),
  })),
}))

describe('TabCoordinatorStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    accountStatus.status = 'ready'
  })

  afterEach(() => {
    const store = useTabCoordinatorStore()
    store.resetForTesting()
  })

  it('generates unique tab IDs', () => {
    const id1 = generateTabId()
    const id2 = generateTabId()
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })

  it('responds to TAB_PING with TAB_PONG when this tab has active custody', async () => {
    const store = useTabCoordinatorStore()
    const broadcastSpy = jest.spyOn(store, 'broadcast')

    await store.handleMessage({
      type: 'TAB_PING',
      tabId: 'other-tab-123',
    })

    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TAB_PONG',
        tabId: store.tabId,
        targetTabId: 'other-tab-123',
        hasCustody: true,
        status: 'ready',
      }),
    )
  })

  it('does not respond to TAB_PING if this tab does not have ready custody', async () => {
    accountStatus.status = 'fresh'
    const store = useTabCoordinatorStore()
    const broadcastSpy = jest.spyOn(store, 'broadcast')

    await store.handleMessage({
      type: 'TAB_PING',
      tabId: 'other-tab-123',
    })

    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  it('detects an active tab from TAB_PONG with hasCustody=true', async () => {
    const store = useTabCoordinatorStore()
    expect(store.otherTabActive).toBe(false)

    await store.handleMessage({
      type: 'TAB_PONG',
      tabId: 'tab-peer-456',
      hasCustody: true,
    })

    expect(store.otherTabActive).toBe(true)
    expect(store.activeTabId).toBe('tab-peer-456')
  })

  it('yields custody when receiving TAKEOVER_REQUEST and replies with TAKEOVER_GRANTED', async () => {
    const store = useTabCoordinatorStore()
    const broadcastSpy = jest.spyOn(store, 'broadcast')

    await store.handleMessage({
      type: 'TAKEOVER_REQUEST',
      requesterTabId: 'new-tab-789',
      targetTabId: store.tabId,
    })

    expect(store.isYielded).toBe(true)
    expect(store.otherTabActive).toBe(true)
    expect(store.activeTabId).toBe('new-tab-789')
    expect(accountSession.yieldCustody).toHaveBeenCalled()
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TAKEOVER_GRANTED',
        fromTabId: store.tabId,
        toTabId: 'new-tab-789',
      }),
    )
  })

  it('performs takeover request: awaits grant, re-runs retry, claims leader, and announces claim', async () => {
    const store = useTabCoordinatorStore()
    store.otherTabActive = true
    store.activeTabId = 'tab-peer-456'
    store.isYielded = true

    const broadcastSpy = jest.spyOn(store, 'broadcast')

    // Simulate peer granting takeover shortly after request
    const takeoverPromise = store.requestTakeover()
    expect(store.isTakingOver).toBe(true)

    // Simulate receiving TAKEOVER_GRANTED
    await store.handleMessage({
      type: 'TAKEOVER_GRANTED',
      fromTabId: 'tab-peer-456',
      toTabId: store.tabId,
    })

    await takeoverPromise

    expect(store.isTakingOver).toBe(false)
    expect(store.isYielded).toBe(false)
    expect(store.otherTabActive).toBe(false)
    expect(store.activeTabId).toBe(store.tabId)
    expect(accountSession.retry).toHaveBeenCalled()
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TAB_CLAIM_CUSTODY',
        tabId: store.tabId,
      }),
    )
  })

  it('automatically unlocks and retries custody when active tab closes', async () => {
    accountStatus.status = 'standby'
    const store = useTabCoordinatorStore()
    store.otherTabActive = true
    store.activeTabId = 'closing-tab'
    store.isYielded = true

    await store.handleMessage({
      type: 'TAB_CLOSING',
      tabId: 'closing-tab',
      hadCustody: true,
    })

    expect(store.otherTabActive).toBe(false)
    expect(store.activeTabId).toBeNull()
    expect(store.isYielded).toBe(false)
    expect(store.wasAutoReleased).toBe(true)
    expect(accountSession.retry).toHaveBeenCalled()
  })

  it('yields when TAB_CLAIM_CUSTODY is received from another tab', async () => {
    const store = useTabCoordinatorStore()

    await store.handleMessage({
      type: 'TAB_CLAIM_CUSTODY',
      tabId: 'remote-claimer',
    })

    expect(store.otherTabActive).toBe(true)
    expect(store.activeTabId).toBe('remote-claimer')
    expect(store.isYielded).toBe(true)
    expect(accountSession.yieldCustody).toHaveBeenCalled()
  })
})
