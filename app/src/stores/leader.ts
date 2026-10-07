/**
 * Instance and Device Leadership Store.
 *
 * Coordinates multi-tab and multi-device wallet instances to ensure that only the
 * single active "Master" client responds to automated protocol interactions
 * (e.g. multi-round threshold signatures, game moves, atomic swap contract executions).
 *
 * Same-device instances (multiple browser tabs) coordinate with zero network cost via
 * BroadcastChannel('frank:leader-sync'). Cross-device instances coordinate via
 * self-addressed encrypted messages (DeviceClaimItem).
 */
import { defineStore } from 'pinia'
import type { WalletHandle } from '@frank/wallet/chain'

export interface LeaderState {
  myInstanceId: string
  myDeviceName: string
  masterInstanceId: string | null
  masterDeviceName: string | null
  masterClaimedAt: number
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

let syncChannel: BroadcastChannel | null = null

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
    }
  },

  getters: {
    /**
     * True if this specific instance is the active master, or if no master has been declared yet.
     */
    isActiveMaster(state): boolean {
      if (state.masterInstanceId === null) return true
      return state.masterInstanceId === state.myInstanceId
    },

    /**
     * True if another frontend currently holds the active master role.
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
      const now = Date.now()
      this.masterInstanceId = this.myInstanceId
      this.masterDeviceName = this.myDeviceName
      this.masterClaimedAt = now

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

    handleIncomingClaim(claim: {
      instanceId: string
      deviceName?: string
      claimedAt: number
    }) {
      if (claim.claimedAt > this.masterClaimedAt) {
        this.masterInstanceId = claim.instanceId
        this.masterDeviceName = claim.deviceName || null
        this.masterClaimedAt = claim.claimedAt
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
      if (syncChannel) {
        syncChannel.close()
        syncChannel = null
      }
    },
  },
})
