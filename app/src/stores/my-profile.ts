import { defineStore } from 'pinia'

/**
 * This device's copy of the active account's profile. The profile itself is the account's and
 * the relay holds it; `../utils/own-profile.ts` says how the two are kept in line.
 */
export interface State {
  /** The identity address of the account this copy belongs to, lowercase. A copy is never
   * shown as, or published for, another account. */
  owner?: string
  /** The user edited the profile here and the relay does not have the edit yet. Only such an
   * edit is published over what the relay holds. */
  unpublished?: boolean
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
    unpublished: false,
    profile: {},
    inbox: {},
    emailBridgeGatewayAddress: undefined,
  }),
  actions: {
    /** Stores what the user typed in the profile form. It is theirs to publish: it stays marked
     * `unpublished` until the relay has it. */
    setRelayData(relayData: Pick<State, 'profile' | 'inbox'> & Partial<State>) {
      this.profile = relayData.profile
      this.inbox = relayData.inbox
      this.unpublished = true
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async restore(storage): Promise<Partial<State>> {
      let myProfile = '{}'
      try {
        myProfile = await storage.get('myProfile')
      } catch (err) {
        //
      }
      const deserializedProfile = JSON.parse(myProfile) as State
      return deserializedProfile
    },
  },
})
