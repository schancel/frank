/** @jest-environment jsdom */

import { setActivePinia, createPinia } from 'pinia'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import {
  CLAIM_RETRY_MS,
  generateInstanceId,
  laterClaim,
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
    store.selectAccount(ME)
    expect(store.isActiveMaster).toBe(true)

    const otherInstanceId = 'other-device-uuid-1234'
    store.handleIncomingClaim(
      {
        instanceId: otherInstanceId,
        deviceName: 'Alice Phone',
        claimedAt: Date.now(),
      },
      ME,
    )

    expect(store.masterInstanceId).toBe(otherInstanceId)
    expect(store.masterDeviceName).toBe('Alice Phone')
    expect(store.isActiveMaster).toBe(false)
    expect(store.isStandby).toBe(true)
  })

  it('claims master role and becomes active master again', () => {
    const store = useLeaderStore()
    store.selectAccount(ME)

    // Step 1: Yield to other device
    store.handleIncomingClaim(
      { instanceId: 'other-uuid', deviceName: 'Desktop', claimedAt: 1000 },
      ME,
    )
    expect(store.isActiveMaster).toBe(false)

    // Step 2: Claim master on this instance
    store.claimMasterRole()
    expect(store.isActiveMaster).toBe(true)
    expect(store.masterInstanceId).toBe(store.myInstanceId)
    expect(store.isStandby).toBe(false)
  })

  it('ignores older incoming claims', () => {
    const store = useLeaderStore()
    store.selectAccount(ME)
    store.claimMasterRole()
    const myClaimTime = store.masterClaimedAt

    // Receive a stale claim from past
    store.handleIncomingClaim(
      {
        instanceId: 'stale-uuid',
        deviceName: 'Old Tablet',
        claimedAt: myClaimTime - 10_000,
      },
      ME,
    )

    expect(store.isActiveMaster).toBe(true)
    expect(store.masterInstanceId).toBe(store.myInstanceId)
  })

  it('generates unique instance IDs', () => {
    const id1 = generateInstanceId()
    const id2 = generateInstanceId()
    expect(id1).not.toBe(id2)
  })

  it('orders two claims of the same millisecond by instance ID, the same way everywhere', () => {
    const a = { instanceId: 'aaaa', claimedAt: 5_000 }
    const b = { instanceId: 'bbbb', claimedAt: 5_000 }
    expect(laterClaim(b, a)).toBe(true)
    expect(laterClaim(a, b)).toBe(false)
    expect(laterClaim(a, a)).toBe(false)
    const store = useLeaderStore()
    store.selectAccount(ME)
    store.handleIncomingClaim(b, ME)
    store.handleIncomingClaim(a, ME)
    expect(store.masterInstanceId).toBe('bbbb')
    setActivePinia(createPinia())
    localStorage.clear()
    const other = useLeaderStore()
    other.selectAccount(ME)
    other.handleIncomingClaim(a, ME)
    other.handleIncomingClaim(b, ME)
    expect(other.masterInstanceId).toBe('bbbb')
  })

  it('drops a claim about another account than the selected one', () => {
    const store = useLeaderStore()
    store.selectAccount(ME)
    store.handleIncomingClaim(
      { instanceId: 'other', claimedAt: Date.now() + 1_000 },
      '0x' + '22'.repeat(20),
    )
    expect(store.isActiveMaster).toBe(true)
    // Before any account is selected, no claim is taken.
    setActivePinia(createPinia())
    const fresh = useLeaderStore()
    fresh.handleIncomingClaim({ instanceId: 'other', claimedAt: 1 }, ME)
    expect(fresh.masterInstanceId).toBeNull()
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
      jest.useRealTimers()
      jest.restoreAllMocks()
    })
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }

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
      window.dispatchEvent(new Event('focus'))
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('claims at start only after the first mailbox read', async () => {
      let done!: () => void
      const firstRead = new Promise<void>(resolve => {
        done = resolve
      })
      stop = startActiveDeviceClaims({ wallet: WALLET, firstRead }).stop
      await flush()
      expect(send).not.toHaveBeenCalled()
      done()
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('a device loaded in the background claims on focus or input, not when its screen wakes', async () => {
      hidden = true
      const store = useLeaderStore()
      store.selectAccount(ME)
      store.handleIncomingClaim(
        { instanceId: 'phone', claimedAt: Date.now() },
        ME,
      )
      stop = startActiveDeviceClaims({ wallet: WALLET }).stop
      await flush()
      expect(send).not.toHaveBeenCalled()
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      await flush()
      expect(store.isActiveMaster).toBe(false)
      expect(send).not.toHaveBeenCalled()
      window.dispatchEvent(new Event('focus'))
      await flush()
      expect(store.isActiveMaster).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('after a reload it still knows which device is active', () => {
      const store = useLeaderStore()
      store.selectAccount(ME)
      store.handleIncomingClaim({ instanceId: 'phone', claimedAt: 5_000 }, ME)
      setActivePinia(createPinia())
      const reloaded = useLeaderStore()
      reloaded.selectAccount(ME)
      expect(reloaded.masterInstanceId).toBe('phone')
      expect(reloaded.isActiveMaster).toBe(false)
      // Another account's devices are not this account's.
      reloaded.selectAccount('0x' + '22'.repeat(20))
      expect(reloaded.isActiveMaster).toBe(true)
    })

    it('a claim that could not be sent is sent again on a timer, with backoff, without any user action', async () => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      })
      send
        .mockRejectedValueOnce(new Error('relay unreachable'))
        .mockRejectedValueOnce(new Error('relay unreachable'))
      jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      stop = startActiveDeviceClaims({ wallet: WALLET }).stop
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      // A user action meanwhile does not send it again at once.
      document.dispatchEvent(new Event('keydown'))
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(CLAIM_RETRY_MS)
      await flush()
      expect(send).toHaveBeenCalledTimes(2)
      // Twice as long the second time.
      jest.advanceTimersByTime(CLAIM_RETRY_MS)
      await flush()
      expect(send).toHaveBeenCalledTimes(2)
      jest.advanceTimersByTime(CLAIM_RETRY_MS)
      await flush()
      expect(send).toHaveBeenCalledTimes(3)
      expect(useLeaderStore().claimNoted).toBe(true)
      jest.advanceTimersByTime(10 * CLAIM_RETRY_MS)
      document.dispatchEvent(new Event('keydown'))
      await flush()
      expect(send).toHaveBeenCalledTimes(3)
    })

    it('stops retrying once another device claims, and when the session stops', async () => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      })
      send.mockRejectedValue(new Error('relay unreachable'))
      jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      const session = startActiveDeviceClaims({ wallet: WALLET })
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      useLeaderStore().handleIncomingClaim(
        { instanceId: 'phone', claimedAt: Date.now() + 60_000 },
        ME,
      )
      jest.advanceTimersByTime(CLAIM_RETRY_MS * 4)
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      // The user acts here again: a new claim, and its retries end with the session.
      document.dispatchEvent(new Event('pointerdown'))
      await flush()
      expect(send).toHaveBeenCalledTimes(2)
      session.stop()
      jest.advanceTimersByTime(CLAIM_RETRY_MS * 4)
      await flush()
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('a claim made while an earlier one is being sent is sent once that one settles', async () => {
      let release!: () => void
      send.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = () => resolve({})
          }),
      )
      const store = useLeaderStore()
      stop = startActiveDeviceClaims({ wallet: WALLET }).stop
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      const first = send.mock.calls[0][0].items[0].claimedAt as number
      // Another device claims, then the user acts here again, while the first send is open.
      store.handleIncomingClaim(
        { instanceId: 'phone', claimedAt: first + 10 },
        ME,
      )
      document.dispatchEvent(new Event('pointerdown'))
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      release()
      await store.claimIdle()
      expect(send).toHaveBeenCalledTimes(2)
      const second = send.mock.calls[1][0].items[0].claimedAt as number
      expect(second).toBeGreaterThan(first + 10)
      expect(store.masterClaimedAt).toBe(second)
      expect(store.claimNoted).toBe(true)
    })
  })
})
