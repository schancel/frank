/** @jest-environment jsdom */

import { setActivePinia, createPinia } from 'pinia'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import {
  CLAIM_RETRY_MS,
  generateInstanceId,
  startActiveDeviceClaims,
  useLeaderStore,
} from './leader'

const ME = '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a'
const WALLET = { identity: { address: { raw: ME } } } as unknown as WalletHandle

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

  describe("claims of the account's active device", () => {
    let send: jest.SpyInstance
    let hidden = false
    let stop: (() => void) | undefined
    beforeEach(() => {
      hidden = false
      send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValue({} as never)
      jest
        .spyOn(document, 'visibilityState', 'get')
        .mockImplementation(() => (hidden ? 'hidden' : 'visible'))
      jest.spyOn(document, 'hasFocus').mockImplementation(() => !hidden)
    })
    afterEach(() => {
      stop?.()
      stop = undefined
      useLeaderStore().resetForTesting()
      jest.restoreAllMocks()
    })
    const flush = () => new Promise(resolve => setTimeout(resolve, 0))

    it('a device opened in the foreground claims once, as a free note to self', async () => {
      stop = startActiveDeviceClaims({ wallet: WALLET }).stop
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      const params = send.mock.calls[0][0]
      expect(params.recipient).toBe(WALLET.identity.address)
      expect(params.stampValue).toBe(0n)
      expect(params.items).toEqual([
        expect.objectContaining({
          type: 'device-claim',
          instanceId: useLeaderStore().myInstanceId,
        }),
      ])
      document.dispatchEvent(new Event('pointerdown'))
      document.dispatchEvent(new Event('keydown'))
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('a device loaded in the background claims when its user acts on it', async () => {
      hidden = true
      const store = useLeaderStore()
      store.selectAccount(ME)
      store.handleIncomingClaim({ instanceId: 'phone', claimedAt: Date.now() })
      stop = startActiveDeviceClaims({ wallet: WALLET }).stop
      await flush()
      expect(send).not.toHaveBeenCalled()
      expect(store.isActiveMaster).toBe(false)
      hidden = false
      document.dispatchEvent(new Event('pointerdown'))
      await flush()
      expect(store.isActiveMaster).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('after a reload it still knows which device is active', async () => {
      const store = useLeaderStore()
      store.selectAccount(ME)
      store.handleIncomingClaim({ instanceId: 'phone', claimedAt: 5_000 })
      setActivePinia(createPinia())
      const reloaded = useLeaderStore()
      reloaded.selectAccount(ME)
      expect(reloaded.masterInstanceId).toBe('phone')
      expect(reloaded.isActiveMaster).toBe(false)
      // Another account's devices are not this account's.
      reloaded.selectAccount('0x' + '22'.repeat(20))
      expect(reloaded.isActiveMaster).toBe(true)
    })

    it('a claim that could not be sent is sent on a later action, not on every one', async () => {
      send.mockRejectedValueOnce(new Error('relay unreachable'))
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
      stop = startActiveDeviceClaims({ wallet: WALLET }).stop
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      document.dispatchEvent(new Event('keydown'))
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      now.mockReturnValue(1_000_000 + CLAIM_RETRY_MS)
      document.dispatchEvent(new Event('keydown'))
      await flush()
      expect(send).toHaveBeenCalledTimes(2)
      expect(useLeaderStore().claimNoted).toBe(true)
      document.dispatchEvent(new Event('keydown'))
      await flush()
      expect(send).toHaveBeenCalledTimes(2)
    })
  })
})
