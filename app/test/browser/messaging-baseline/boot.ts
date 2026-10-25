import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import { defineBoot } from '@quasar/app-vite'
import { useChatStore } from '../../../src/stores/chats'
import { useContactStore } from '../../../src/stores/contacts'
import { useProfileStore } from '../../../src/stores/my-profile'
import {
  initialize,
  getWallet,
  observations,
  PEER,
  CONVERSATION,
  release,
} from './runtime'
import { initializeMonadIdentity } from './identity'

declare global {
  interface Window {
    __messagingBaseline: {
      state: typeof observations
      conversation: string
      release: typeof release
      receiveHistory(text: string, index: number): Promise<void>
      messageState(text: string):
        | {
            status: string | undefined
            digest: string
            conversationId: string | undefined
          }
        | undefined
    }
  }
}
export default defineBoot(async () => {
  await initialize()
  await initializeMonadIdentity()
  const wallet = await getWallet()
  const chats = useChatStore()
  const contacts = useContactStore()
  useProfileStore().setRelayData({
    profile: { name: 'Synthetic sender' },
    inbox: {},
  })
  contacts.addContact({
    address: PEER,
    contact: {
      profile: { name: 'Synthetic peer', bio: '', avatar: '', pubKey: null },
    },
  })
  chats.createConversation({
    conversationId: CONVERSATION,
    participants: [wallet.identity.displayAddress, PEER],
    address: PEER,
    name: 'Synthetic conversation',
  })
  for (let index = 0; index < 120; index++) {
    chats.sendMessageLocal({
      address: PEER,
      conversationId: CONVERSATION,
      senderAddress: wallet.identity.displayAddress,
      index: (1000 + index).toString(16).padStart(64, '0'),
      items: [
        {
          type: 'text',
          text: `History message ${index}: synthetic offline conversation`,
        },
      ],
      outpoints: [],
      stampValueWei: 1000n,
      status: 'confirmed',
      previousHash: null,
      timestamp: 1792800000000 + index * 1000,
      delivery: {},
    })
  }
  await chats.flushPersistence()
  window.__messagingBaseline = {
    state: observations,
    conversation: CONVERSATION,
    release,
    async receiveHistory(text, index) {
      const time = 1792801000000 + index
      const wrapper: ReceivedMessageWrapper = {
        conversationId: CONVERSATION,
        outbound: false,
        senderAddress: PEER,
        copartyAddress: PEER,
        copartyPubKey: { toBuffer: () => new Uint8Array(33) },
        index: index.toString(16).padStart(64, '0'),
        stampValue: 0,
        message: {
          conversationId: CONVERSATION,
          outbound: false,
          status: 'confirmed',
          senderAddress: PEER,
          destinationAddress: wallet.identity.displayAddress,
          items: [{ type: 'text', text }],
          serverTime: time,
          receivedTime: time,
          outpoints: [],
        },
      }
      await chats.receiveMessages([wrapper], wallet.identity.displayAddress)
      await chats.flushPersistence()
    },
    messageState(text) {
      const row = Object.values(chats.messages).find(message =>
        message?.items?.some(
          item => item.type === 'text' && item.text === text,
        ),
      )
      return row
        ? {
            status: row.status,
            digest: row.payloadDigest,
            conversationId: row.conversationId,
          }
        : undefined
    },
  }
  observations.ready = true
})
