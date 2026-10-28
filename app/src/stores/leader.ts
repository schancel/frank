/**
 * Which of an account's devices is active.
 *
 * A user types on one device at a time. The device the user last acted on (opened in the
 * foreground, clicked, tapped, typed: sending and paying are reached that way) is the active
 * one. It says so to the account's other devices with a free note to self carrying a
 * `device-claim` item, and to this device's other tabs over BroadcastChannel('frank:leader-sync').
 * The latest claim wins. A claim is always later than every claim the claiming device has seen,
 * whatever its clock says, so a device whose clock is behind still takes over when its user acts.
 *
 * Only the active device STARTS automatic work that signs something new on the user's behalf
 * and that no one asked this device for: background coin maintenance (`startOutgoingReconciliation`)
 * and the free automatic game steps a chat sends without asking (`utils/automatic-game-steps.ts`).
 * Every device still reads, syncs and shows everything.
 *
 * Finishing work the user already authorized is never gated. A send, a payment or a merge
 * signed on a device is held in that device's own journal, and only that device holds its signed
 * bytes: it goes on resubmitting, reconciling and recovering that operation every time it is
 * open, active or not. Nothing waits for it to become active again, and no other device starts a
 * fresh payment for the same message.
 */
import { defineStore } from 'pinia'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import { uuidv5Bytes } from '@frank/cashweb/relay/conversation-id'
import type { DeviceClaimItem } from '@frank/cashweb/types/messages'

export interface LeaderState {
  myInstanceId: string
  myDeviceName: string
  masterInstanceId: string | null
  masterDeviceName: string | null
  masterClaimedAt: number
  /** The account whose devices the claim above is about (its identity address, lowercase). */
  accountKey: string | null
  /** This device's current claim has reached the account's mailbox. */
  claimNoted: boolean
}

function getStoredValue(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key)
    }
  } catch {
    // ignore security / iframe errors
  }
  return null
}

function setStoredValue(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value)
    }
  } catch {
    // ignore
  }
}

export function generateInstanceId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  const rand = Math.random().toString(36).substring(2, 10)
  const time = Date.now().toString(36)
  return `inst-${rand}-${time}`
}

export function detectDeviceName(): string {
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const ua = navigator.userAgent
    if (/iPad|iPhone|iPod/.test(ua)) return 'iOS Device'
    if (/Android/.test(ua)) return 'Android Device'
    if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
    if (/Windows/.test(ua)) return 'Windows PC'
    if (/Linux/.test(ua)) return 'Linux PC'
  }
  return 'Browser Client'
}

/** Where this device keeps the last claim it knows of for an account, so a reload (also one in
 * a background tab) still knows which device is active. */
const CLAIM_KEY_PREFIX = 'frank:active-device:'

/** After a claim note could not be sent, the next user action tries again no sooner than this. */
export const CLAIM_RETRY_MS = 15_000

/** Sends one claim to the account's own mailbox. */
export type SendDeviceClaim = (item: DeviceClaimItem) => Promise<unknown>

let syncChannel: BroadcastChannel | null = null
let claimInFlight: Promise<void> | undefined
let lastClaimAttemptAt = -Infinity

export const useLeaderStore = defineStore('leader', {
  state: (): LeaderState => {
    let instanceId = getStoredValue('frank:instance-id')
    if (!instanceId) {
      instanceId = generateInstanceId()
      setStoredValue('frank:instance-id', instanceId)
    }

    let deviceName = getStoredValue('frank:device-name')
    if (!deviceName) {
      deviceName = detectDeviceName()
      setStoredValue('frank:device-name', deviceName)
    }

    return {
      myInstanceId: instanceId,
      myDeviceName: deviceName,
      masterInstanceId: null,
      masterDeviceName: null,
      masterClaimedAt: 0,
      accountKey: null,
      claimNoted: false,
    }
  },

  getters: {
    /**
     * True if this device is the active one, or if no device has claimed yet.
     */
    isActiveMaster(state): boolean {
      if (state.masterInstanceId === null) return true
      return state.masterInstanceId === state.myInstanceId
    },

    /**
     * True if another device is the active one.
     */
    isStandby(): boolean {
      return !this.isActiveMaster
    },
  },

  actions: {
    initSyncChannel() {
      if (syncChannel) return
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          syncChannel = new BroadcastChannel('frank:leader-sync')
          syncChannel.onmessage = (event: MessageEvent) => {
            const data = event.data
            if (data?.type === 'leader-claim') {
              this.handleIncomingClaim({
                instanceId: data.instanceId,
                deviceName: data.deviceName,
                claimedAt: data.claimedAt,
              })
            }
          }
        } catch {
          // BroadcastChannel unsupported or restricted in environment
        }
      }
    },

    /**
     * The claim this store holds is about this account from now on: the last claim this device
     * saw for it is loaded, and nothing of another account's devices is kept.
     */
    selectAccount(accountKey: string) {
      const key = accountKey.toLowerCase()
      if (this.accountKey === key) return
      this.accountKey = key
      this.masterInstanceId = null
      this.masterDeviceName = null
      this.masterClaimedAt = 0
      this.claimNoted = false
      const saved = getStoredValue(CLAIM_KEY_PREFIX + key)
      if (!saved) return
      try {
        const claim = JSON.parse(saved) as {
          instanceId?: unknown
          deviceName?: unknown
          claimedAt?: unknown
        }
        if (
          typeof claim.instanceId === 'string' &&
          typeof claim.claimedAt === 'number' &&
          Number.isFinite(claim.claimedAt)
        ) {
          this.masterInstanceId = claim.instanceId
          this.masterDeviceName =
            typeof claim.deviceName === 'string' ? claim.deviceName : null
          this.masterClaimedAt = claim.claimedAt
        }
      } catch {
        // An unreadable saved claim is no claim.
      }
    },

    persistClaim() {
      if (!this.accountKey || this.masterInstanceId === null) return
      setStoredValue(
        CLAIM_KEY_PREFIX + this.accountKey,
        JSON.stringify({
          instanceId: this.masterInstanceId,
          deviceName: this.masterDeviceName,
          claimedAt: this.masterClaimedAt,
        }),
      )
    },

    claimMasterRole(params?: {
      sendSelfMessage?: boolean
      ownAddress?: string
      wallet?: WalletHandle
      sendDirectMessage?: (options: {
        wallet: WalletHandle
        address: string
        items: Array<{
          type: 'device-claim'
          instanceId: string
          deviceName?: string
          claimedAt: number
        }>
        stampValue?: bigint
      }) => Promise<unknown>
    }) {
      // Later than any claim this device has seen, whatever its clock says.
      const now = Math.max(Date.now(), this.masterClaimedAt + 1)
      this.masterInstanceId = this.myInstanceId
      this.masterDeviceName = this.myDeviceName
      this.masterClaimedAt = now
      this.claimNoted = false
      this.persistClaim()

      // 1. Broadcast locally across tabs
      if (typeof BroadcastChannel !== 'undefined') {
        this.initSyncChannel()
        try {
          syncChannel?.postMessage({
            type: 'leader-claim',
            instanceId: this.myInstanceId,
            deviceName: this.myDeviceName,
            claimedAt: now,
          })
        } catch {
          // ignore
        }
      }

      // 2. Cross-device synchronization via self-message if requested
      if (
        params?.sendSelfMessage &&
        params.ownAddress &&
        params.wallet &&
        params.sendDirectMessage
      ) {
        void params
          .sendDirectMessage({
            wallet: params.wallet,
            address: params.ownAddress,
            items: [
              {
                type: 'device-claim',
                instanceId: this.myInstanceId,
                deviceName: this.myDeviceName,
                claimedAt: now,
              },
            ],
          })
          .catch((err: unknown) => {
            console.warn(
              '[leader] Failed to send cross-device claim message:',
              err,
            )
          })
      }
    },

    /**
     * The user acted on this device: it becomes the active one, and the account's other devices
     * are told once (a free note to self). Acting again on the active device sends nothing more;
     * a note that could not be sent is tried again on a later action, at most every
     * {@link CLAIM_RETRY_MS}.
     */
    noteUserActivity(send?: SendDeviceClaim): Promise<void> {
      const mine = this.masterInstanceId === this.myInstanceId
      if (mine && (this.claimNoted || !send)) return Promise.resolve()
      if (!mine) this.claimMasterRole()
      if (!send) return Promise.resolve()
      if (claimInFlight) return claimInFlight
      if (mine && Date.now() - lastClaimAttemptAt < CLAIM_RETRY_MS)
        return Promise.resolve()
      lastClaimAttemptAt = Date.now()
      const item: DeviceClaimItem = {
        type: 'device-claim',
        instanceId: this.myInstanceId,
        deviceName: this.myDeviceName,
        claimedAt: this.masterClaimedAt,
      }
      const run = send(item).then(
        () => {
          if (
            this.masterInstanceId === item.instanceId &&
            this.masterClaimedAt === item.claimedAt
          )
            this.claimNoted = true
        },
        (err: unknown) => {
          console.warn('[leader] device claim not sent; will retry:', err)
        },
      )
      const tracked = run.finally(() => {
        if (claimInFlight === tracked) claimInFlight = undefined
      })
      claimInFlight = tracked
      return tracked
    },

    handleIncomingClaim(claim: {
      instanceId: string
      deviceName?: string
      claimedAt: number
    }) {
      if (claim.claimedAt > this.masterClaimedAt) {
        this.masterInstanceId = claim.instanceId
        this.masterDeviceName = claim.deviceName || null
        this.masterClaimedAt = claim.claimedAt
        if (claim.instanceId !== this.myInstanceId) this.claimNoted = false
        this.persistClaim()
      }
    },

    setDeviceName(name: string) {
      this.myDeviceName = name
      setStoredValue('frank:device-name', name)
    },

    resetForTesting() {
      this.masterInstanceId = null
      this.masterDeviceName = null
      this.masterClaimedAt = 0
      this.accountKey = null
      this.claimNoted = false
      claimInFlight = undefined
      lastClaimAttemptAt = -Infinity
      if (syncChannel) {
        syncChannel.close()
        syncChannel = null
      }
    },
  },
})

/** Sends a claim as a free note to the account's own mailbox. The same claim always has the
 * same message ID. */
export function deviceClaimSender(wallet: WalletHandle): SendDeviceClaim {
  return item =>
    activeChain.directMessages.send({
      wallet,
      recipient: wallet.identity.address,
      items: [item],
      stampValue: 0n,
      messageId: uuidv5Bytes(
        new Uint8Array(16),
        `frank-device-claim:${item.instanceId}:${item.claimedAt}`,
      ),
    })
}

/** What counts as the user acting on this device. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown'] as const

/**
 * Makes this device the active one whenever its user acts on it, for one account's session:
 * when the app is open in the foreground at start, when it comes back to the foreground, and on
 * any click, tap or key press (sending and paying are reached through those). A device loaded in
 * a background tab claims nothing until its user looks at it.
 */
export function startActiveDeviceClaims({ wallet }: { wallet: WalletHandle }): {
  stop: () => void
} {
  const leader = useLeaderStore()
  leader.selectAccount(activeChain.formatAddress(wallet.identity.address))
  leader.initSyncChannel()
  const send = deviceClaimSender(wallet)
  let stopped = false
  const act = () => {
    if (!stopped) void leader.noteUserActivity(send)
  }
  const doc = typeof document !== 'undefined' ? document : undefined
  const win = typeof window !== 'undefined' ? window : undefined
  const foreground = () =>
    !!doc &&
    doc.visibilityState !== 'hidden' &&
    (typeof doc.hasFocus !== 'function' || doc.hasFocus())
  const onVisibility = () => {
    if (foreground()) act()
  }
  if (foreground()) act()
  doc?.addEventListener?.('visibilitychange', onVisibility)
  win?.addEventListener?.('focus', act)
  for (const name of ACTIVITY_EVENTS)
    doc?.addEventListener?.(name, act, { capture: true, passive: true })
  return {
    stop: () => {
      stopped = true
      doc?.removeEventListener?.('visibilitychange', onVisibility)
      win?.removeEventListener?.('focus', act)
      for (const name of ACTIVITY_EVENTS)
        doc?.removeEventListener?.(name, act, { capture: true })
    },
  }
}
