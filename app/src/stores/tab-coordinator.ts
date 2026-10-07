/**
 * Cross-Tab Coordination and Custody Takeover Store.
 *
 * Coordinates multiple browser tabs sharing the same origin to ensure that
 * only a single tab holds active IndexedDB custody connections and wallet handles
 * at any given time.
 *
 * In WebKit/Safari, concurrent IDBDatabase handles trigger process-level SQLite
 * locks and IDBOpenDBRequest.onblocked. When a secondary tab opens, this coordinator
 * detects the existing active tab via BroadcastChannel('frank:tab-sync') and displays
 * a dedicated "Frank is open in another tab" screen with a one-click takeover button,
 * preventing storage corruption or misleading setup/seed-import screens.
 */
import { defineStore } from 'pinia'
import { watch } from 'vue'
import { accountSession, accountStatus } from '../accounts/session'
import { useLeaderStore } from './leader'

export interface TabCoordinatorState {
  tabId: string
  otherTabActive: boolean
  activeTabId: string | null
  isYielded: boolean
  isTakingOver: boolean
  wasAutoReleased: boolean
}

export function generateTabId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  const rand = Math.random().toString(36).substring(2, 10)
  const time = Date.now().toString(36)
  return `tab-${rand}-${time}`
}

function getStoredTabId(): string {
  try {
    if (typeof sessionStorage !== 'undefined') {
      let id = sessionStorage.getItem('frank:tab-id')
      if (!id) {
        id = generateTabId()
        sessionStorage.setItem('frank:tab-id', id)
      }
      return id
    }
  } catch {
    // sessionStorage restricted or unavailable
  }
  return generateTabId()
}

export interface TabSyncMessage {
  type:
    | 'TAB_PING'
    | 'TAB_PONG'
    | 'TAB_CLAIM_CUSTODY'
    | 'TAKEOVER_REQUEST'
    | 'TAKEOVER_GRANTED'
    | 'TAB_CLOSING'
    | 'FOCUS_REQUEST'
  tabId?: string
  senderTabId?: string
  targetTabId?: string | null
  requesterTabId?: string
  fromTabId?: string
  toTabId?: string
  hasCustody?: boolean
  hadCustody?: boolean
  status?: string
}

let syncChannel: BroadcastChannel | null = null
let unloadListenerAttached = false
let takeoverResolver: (() => void) | null = null

export const useTabCoordinatorStore = defineStore('tabCoordinator', {
  state: (): TabCoordinatorState => ({
    tabId: getStoredTabId(),
    otherTabActive: false,
    activeTabId: null,
    isYielded: false,
    isTakingOver: false,
    wasAutoReleased: false,
  }),

  actions: {
    initChannel() {
      if (syncChannel) return
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          syncChannel = new BroadcastChannel('frank:tab-sync')
          syncChannel.onmessage = (event: MessageEvent<TabSyncMessage>) => {
            this.handleMessage(event.data)
          }
        } catch {
          // BroadcastChannel unsupported
        }
      }
    },

    attachUnloadListeners() {
      if (unloadListenerAttached) return
      unloadListenerAttached = true
      if (typeof window !== 'undefined') {
        const handleUnload = () => {
          if (syncChannel) {
            try {
              syncChannel.postMessage({
                type: 'TAB_CLOSING',
                tabId: this.tabId,
                hadCustody: !this.isYielded && accountStatus.status === 'ready',
              } satisfies TabSyncMessage)
            } catch {
              // ignore
            }
          }
        }
        window.addEventListener('beforeunload', handleUnload)
        window.addEventListener('pagehide', handleUnload)
      }
    },

    async init(options?: { pingTimeoutMs?: number }): Promise<void> {
      this.initChannel()
      this.attachUnloadListeners()

      // Watch for this tab transitioning to ready so we broadcast claim
      watch(
        () => accountStatus.status,
        status => {
          if (status === 'ready' && !this.isYielded) {
            this.broadcast({
              type: 'TAB_CLAIM_CUSTODY',
              tabId: this.tabId,
            })
          }
        },
      )

      if (syncChannel) {
        this.broadcast({
          type: 'TAB_PING',
          tabId: this.tabId,
        })
        const timeoutMs = options?.pingTimeoutMs ?? 60
        await new Promise(resolve => setTimeout(resolve, timeoutMs))
      }
    },

    broadcast(msg: TabSyncMessage) {
      if (!syncChannel) return
      try {
        syncChannel.postMessage(msg)
      } catch {
        // ignore
      }
    },

    async handleMessage(msg: TabSyncMessage) {
      if (!msg || typeof msg !== 'object') return

      switch (msg.type) {
        case 'TAB_PING': {
          const senderId = msg.tabId || msg.senderTabId
          if (senderId && senderId !== this.tabId) {
            // Reply with PONG if we currently hold active custody
            if (accountStatus.status === 'ready' && !this.isYielded) {
              this.broadcast({
                type: 'TAB_PONG',
                tabId: this.tabId,
                targetTabId: senderId,
                hasCustody: true,
                status: accountStatus.status,
              })
            }
          }
          break
        }

        case 'TAB_PONG': {
          if (msg.tabId && msg.tabId !== this.tabId) {
            if (msg.hasCustody) {
              this.otherTabActive = true
              this.activeTabId = msg.tabId
            }
          }
          break
        }

        case 'TAB_CLAIM_CUSTODY': {
          if (msg.tabId && msg.tabId !== this.tabId) {
            this.otherTabActive = true
            this.activeTabId = msg.tabId
            // If this tab was also holding custody, yield to the new claimer
            if (accountStatus.status === 'ready' && !this.isYielded) {
              this.isYielded = true
              await accountSession.yieldCustody()
            }
          }
          break
        }

        case 'TAKEOVER_REQUEST': {
          const requester = msg.requesterTabId || msg.tabId
          if (requester && requester !== this.tabId) {
            if (!msg.targetTabId || msg.targetTabId === this.tabId) {
              if (accountStatus.status === 'ready' || !this.isYielded) {
                this.isYielded = true
                this.otherTabActive = true
                this.activeTabId = requester
                await accountSession.yieldCustody()
                this.broadcast({
                  type: 'TAKEOVER_GRANTED',
                  fromTabId: this.tabId,
                  toTabId: requester,
                })
              }
            }
          }
          break
        }

        case 'TAKEOVER_GRANTED': {
          if (msg.toTabId === this.tabId) {
            if (takeoverResolver) {
              takeoverResolver()
            }
          }
          break
        }

        case 'TAB_CLOSING': {
          if (msg.tabId && msg.tabId !== this.tabId) {
            if (this.activeTabId === msg.tabId || this.otherTabActive) {
              this.otherTabActive = false
              this.activeTabId = null
              // If this tab was yielded or on standby, automatically take over custody
              if (this.isYielded || accountStatus.status === 'standby') {
                this.isYielded = false
                this.wasAutoReleased = true
                void accountSession.retry().then(() => {
                  try {
                    useLeaderStore().claimMasterRole()
                  } catch {
                    // leader store optional
                  }
                })
              }
            }
          }
          break
        }

        case 'FOCUS_REQUEST': {
          if (msg.targetTabId === this.tabId) {
            if (typeof window !== 'undefined') {
              try {
                window.focus?.()
              } catch {
                // ignore
              }
            }
          }
          break
        }
      }
    },

    async requestTakeover(): Promise<void> {
      this.isTakingOver = true
      try {
        if (syncChannel) {
          this.broadcast({
            type: 'TAKEOVER_REQUEST',
            requesterTabId: this.tabId,
            targetTabId: this.activeTabId,
          })

          // Wait for TAKEOVER_GRANTED with a safe timeout
          await new Promise<void>(resolve => {
            const timeout = setTimeout(() => {
              takeoverResolver = null
              resolve()
            }, 600)
            takeoverResolver = () => {
              clearTimeout(timeout)
              takeoverResolver = null
              resolve()
            }
          })
        }

        this.isYielded = false
        this.otherTabActive = false
        this.activeTabId = this.tabId

        await accountSession.retry()

        try {
          useLeaderStore().claimMasterRole()
        } catch {
          // leader store optional
        }

        this.broadcast({
          type: 'TAB_CLAIM_CUSTODY',
          tabId: this.tabId,
        })
      } finally {
        this.isTakingOver = false
      }
    },

    requestTabFocus() {
      this.broadcast({
        type: 'FOCUS_REQUEST',
        targetTabId: this.activeTabId,
      })
    },

    resetForTesting() {
      this.otherTabActive = false
      this.activeTabId = null
      this.isYielded = false
      this.isTakingOver = false
      this.wasAutoReleased = false
      takeoverResolver = null
      if (syncChannel) {
        syncChannel.close()
        syncChannel = null
      }
      unloadListenerAttached = false
    },
  },
})
