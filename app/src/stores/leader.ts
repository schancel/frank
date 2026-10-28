/**
 * Which of an account's devices is active.
 *
 * A user types on one device at a time. The device the user last acted on (opened in the
 * foreground, clicked, tapped, typed: sending and paying are reached that way) is the active
 * one. It says so to the account's other devices with a free note to self carrying a
 * `device-claim` item, and to this device's other tabs over BroadcastChannel('frank:leader-sync').
 * The latest claim wins; two claims of the same millisecond are ordered by instance ID, the same
 * way on every device. A claim is always later than every claim the claiming device has seen,
 * whatever its clock says, so a device whose clock is behind still takes over when its user acts.
 * A claim not yet in the mailbox is sent again on a timer, with backoff, until it is.
 *
 * Only the active device STARTS automatic work that signs something new on the user's behalf
 * and that no one asked this device for: background coin maintenance (`startOutgoingReconciliation`,
 * (new merges only) and the free automatic game steps a chat sends without asking
 * (`utils/automatic-game-steps.ts`).
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

/** A claim that could not be sent is sent again after this, then after twice as long each time,
 * up to {@link CLAIM_RETRY_MAX_MS}. */
export const CLAIM_RETRY_MS = 5_000
export const CLAIM_RETRY_MAX_MS = 300_000

/** Sends one claim to the account's own mailbox. */
export type SendDeviceClaim = (item: DeviceClaimItem) => Promise<unknown>

/** One claim, as the ordering needs it. */
interface Claim {
  instanceId: string
  claimedAt: number
}

/** Whether claim `a` is later than claim `b`: by time, then by instance ID. */
export function laterClaim(a: Claim, b: Claim | null): boolean {
  if (!b) return true
  if (a.claimedAt !== b.claimedAt) return a.claimedAt > b.claimedAt
  return a.instanceId > b.instanceId
}

let syncChannel: BroadcastChannel | null = null
/** Sending this device's claim: one send at a time, for one account's session. */
let claimInFlight: Promise<void> | undefined
let claimAgain = false
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryDelayMs = CLAIM_RETRY_MS
/** The claim the pending retry is for. */
let retryClaimedAt = 0
/** Bumped whenever the session changes: a send of an earlier session records nothing. */
let claimGeneration = 0

function resetClaimSending(): void {
  claimGeneration += 1
  if (retryTimer !== undefined) clearTimeout(retryTimer)
  retryTimer = undefined
  claimInFlight = undefined
  claimAgain = false
  retryDelayMs = CLAIM_RETRY_MS
}

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
            if (
              data?.type === 'leader-claim' &&
              data.accountKey === this.accountKey
            ) {
              this.handleIncomingClaim(
                {
                  instanceId: data.instanceId,
                  deviceName: data.deviceName,
                  claimedAt: data.claimedAt,
                },
                data.accountKey,
              )
            }
          }
        } catch {
          // BroadcastChannel unsupported or restricted in environment
        }
      }
    },

    /**
     * The claim this store holds is about this account from now on: the last claim this device
     * saw for it is loaded, nothing of another account's devices is kept, and a claim still being
     * sent for another account is forgotten.
     */
    selectAccount(accountKey: string) {
      const key = accountKey.toLowerCase()
      if (this.accountKey === key) return
      resetClaimSending()
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

    /** The session that sends this device's claims has ended: nothing more is sent for it. */
    endClaimSession() {
      resetClaimSending()
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

    /** This device becomes the active one, here and in this device's other tabs. The account's
     * other devices are told by {@link noteUserActivity}. */
    claimMasterRole() {
      // Later than any claim this device has seen, whatever its clock says.
      const now = Math.max(Date.now(), this.masterClaimedAt + 1)
      this.masterInstanceId = this.myInstanceId
      this.masterDeviceName = this.myDeviceName
      this.masterClaimedAt = now
      this.claimNoted = false
      this.persistClaim()

      if (typeof BroadcastChannel !== 'undefined') {
        this.initSyncChannel()
        try {
          syncChannel?.postMessage({
            type: 'leader-claim',
            accountKey: this.accountKey,
            instanceId: this.myInstanceId,
            deviceName: this.myDeviceName,
            claimedAt: now,
          })
        } catch {
          // ignore
        }
      }
    },

    /**
     * The user acted on this device: it becomes the active one, and the account's other devices
     * are told (a free note to self). Acting again on the active device sends nothing more.
     * Resolves once nothing is being sent.
     */
    noteUserActivity(send?: SendDeviceClaim): Promise<void> {
      if (this.masterInstanceId !== this.myInstanceId) this.claimMasterRole()
      if (send) this.sendClaim(send)
      return this.claimIdle()
    },

    /**
     * Sends this device's current claim, unless it is in the mailbox already or another device
     * is active. One send at a time: a claim made while an earlier one is on its way is sent
     * when that one settles. A claim that could not be sent is sent again on a timer, with
     * backoff, until it is in the mailbox or another device claims.
     */
    sendClaim(send: SendDeviceClaim): void {
      if (this.masterInstanceId !== this.myInstanceId || this.claimNoted) return
      if (claimInFlight) {
        claimAgain = true
        return
      }
      // The same claim waiting out its backoff is not hurried by a user action.
      if (retryTimer !== undefined && retryClaimedAt === this.masterClaimedAt)
        return
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      const generation = claimGeneration
      const item: DeviceClaimItem = {
        type: 'device-claim',
        instanceId: this.myInstanceId,
        deviceName: this.myDeviceName,
        claimedAt: this.masterClaimedAt,
      }
      const current = () =>
        generation === claimGeneration &&
        this.masterInstanceId === this.myInstanceId
      claimInFlight = send(item)
        .then(
          () => {
            if (current() && this.masterClaimedAt === item.claimedAt) {
              this.claimNoted = true
              retryDelayMs = CLAIM_RETRY_MS
            }
          },
          (err: unknown) => {
            console.warn('[leader] device claim not sent; will retry:', err)
          },
        )
        .finally(() => {
          if (generation !== claimGeneration) return
          claimInFlight = undefined
          const newer = claimAgain && this.masterClaimedAt !== item.claimedAt
          claimAgain = false
          if (!current() || this.claimNoted) return
          // A newer claim goes at once; the same claim again after the backoff.
          if (newer) return this.sendClaim(send)
          const delay = retryDelayMs
          retryDelayMs = Math.min(retryDelayMs * 2, CLAIM_RETRY_MAX_MS)
          retryClaimedAt = item.claimedAt
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            if (generation === claimGeneration) this.sendClaim(send)
          }, delay)
        })
    },

    /** Resolves once no claim of this device is being sent (a retry may still be due). */
    async claimIdle(): Promise<void> {
      while (claimInFlight) await claimInFlight
    },

    /**
     * A claim read from the account's mailbox or from another tab. One about another account
     * than the selected one is not this account's and is dropped.
     */
    handleIncomingClaim(
      claim: {
        instanceId: string
        deviceName?: string
        claimedAt: number
      },
      accountKey: string,
    ) {
      if (!this.accountKey || accountKey.toLowerCase() !== this.accountKey)
        return
      const known =
        this.masterInstanceId === null
          ? null
          : {
              instanceId: this.masterInstanceId,
              claimedAt: this.masterClaimedAt,
            }
      if (!laterClaim(claim, known)) return
      this.masterInstanceId = claim.instanceId
      this.masterDeviceName = claim.deviceName || null
      this.masterClaimedAt = claim.claimedAt
      if (claim.instanceId !== this.myInstanceId) {
        this.claimNoted = false
        if (retryTimer !== undefined) clearTimeout(retryTimer)
        retryTimer = undefined
      }
      this.persistClaim()
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
      resetClaimSending()
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

/** What counts as the user acting on this device. A screen waking up (the page becoming visible
 * again) does not: the user may be looking at another device. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown'] as const

/**
 * Makes this device the active one whenever its user acts on it, for one account's session:
 * when the app is open in the foreground at start, and on focus, a click, a tap or a key press
 * (sending and paying are reached through those). The claim at start waits for `firstRead`, the
 * session's first read of the mailbox, so it is later than the latest claim stored there. A
 * device loaded in a background tab claims nothing until its user acts on it.
 */
export function startActiveDeviceClaims({
  wallet,
  firstRead,
}: {
  wallet: WalletHandle
  firstRead?: Promise<unknown>
}): {
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
  void Promise.resolve(firstRead)
    .catch(() => undefined)
    .then(() => {
      if (foreground()) act()
    })
  win?.addEventListener?.('focus', act)
  for (const name of ACTIVITY_EVENTS)
    doc?.addEventListener?.(name, act, { capture: true, passive: true })
  return {
    stop: () => {
      stopped = true
      leader.endClaimSession()
      win?.removeEventListener?.('focus', act)
      for (const name of ACTIVITY_EVENTS)
        doc?.removeEventListener?.(name, act, { capture: true })
    },
  }
}
