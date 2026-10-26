import { defineStore } from 'pinia'
import { readStoreJson } from 'src/boot/pinia'

/**
 * This device's copy of the active account's profile. The profile itself is the account's and
 * the relay holds it; `../utils/own-profile.ts` says how the two are kept in line.
 */
export interface State {
  /** The identity address of the account this copy belongs to, lowercase. A copy is never
   * shown as, or published for, another account. */
  owner?: string
  /** The accountId whose initial post-activation profile restoration has completed. */
  restoredAccountId?: string
  /** The user edited the profile here and the relay does not have the edit yet. Only such an
   * edit is published over what the relay holds. */
  unpublished?: boolean
  /** When the user made the unpublished edit (ms). A profile the relay holds that was published
   * later (on another device) is the newer one, and replaces the edit. */
  editedAt?: number
  /** The published profile this copy was last read from or published as: what an edit was made
   * over. Fields the user did not change in an edit are taken from what the relay holds when it is
   * published, so an edit on one device does not undo another device's later edit. */
  base?: State['profile']
  profile: {
    username?: string
    name?: string
    bio?: string
    avatar?: string
    location?: string
    links?: Array<{
      type: string
      url: string
      label?: string
    }>
    accountType?: number
    botRole?: number
  }
  inbox: {
    acceptancePrice?: number
  }
  emailBridgeGatewayAddress?: string
}

export const useProfileStore = defineStore('myProfile', {
  state: (): State => ({
    owner: undefined,
    restoredAccountId: undefined,
    unpublished: false,
    editedAt: undefined,
    base: undefined,
    profile: {},
    inbox: {},
    emailBridgeGatewayAddress: undefined,
  }),
  actions: {
    /** Stores what the user typed in the profile form. It is theirs to publish: it stays marked
     * `unpublished` until the relay has it. */
    setRelayData(relayData: Pick<State, 'profile' | 'inbox'> & Partial<State>) {
      if (!this.unpublished) this.base = { ...this.profile }
      this.profile = relayData.profile
      this.inbox = relayData.inbox
      this.unpublished = true
      this.editedAt = Date.now()
      if (relayData.emailBridgeGatewayAddress !== undefined) {
        this.emailBridgeGatewayAddress = relayData.emailBridgeGatewayAddress
      }
    },
    setEmailBridgeGatewayAddress(address?: string) {
      this.emailBridgeGatewayAddress = address
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      return storage.put('myProfile', JSON.stringify(state))
    },
    async restore(storage): Promise<Partial<State>> {
      return (await readStoreJson<State>(storage, 'myProfile')) ?? {}
    },
  },
})
