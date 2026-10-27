/** @jest-environment jsdom */

/**
 * A group invitation or membership change carried in a direct message is a record, not
 * something said: it is shown as one system line, with no bubble and no amount.
 */
import { shallowMount } from '@vue/test-utils'

import ChatMessage from './ChatMessage.vue'
import enUS from '../../../i18n/en-us'
import { groupConversationUuid } from '@frank/cashweb/groups/group-crypto'

const GROUP_ID = 'ab'.repeat(32)
jest.mock('../../../stores/chats', () => ({
  useChatStore: () => ({
    conversations: {
      [jest
        .requireActual('@frank/cashweb/groups/group-crypto')
        .groupConversationUuid('ab'.repeat(32))]: { name: 'Core' },
    },
    deleteMessage: jest.fn(),
    getStampAmount: () => 0,
    sendMessage: jest.fn(),
    retryOutgoing: jest.fn(),
  }),
}))
jest.mock('../../dialogs/DeleteMessageDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../../dialogs/TransactionDialog.vue', () => ({ template: '<i />' }))
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({ wallet: true }),
}))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))
const openChat = jest.fn()
jest.mock('../../../utils/routes', () => ({
  openChat: (...args: unknown[]) => openChat(...args),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { toDisplayAmount: () => '0', unit: 'MON' },
}))
jest.mock('../../../utils/message-items', () => ({
  messageItems: {
    previewText: (item: { type: string; action?: string; epoch?: number }) =>
      item.type === 'group-control'
        ? `Group control (${item.action}, epoch ${item.epoch})`
        : '',
  },
}))

const t = (key: string, params: Record<string, string> = {}) =>
  (
    key
      .split('.')
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown>)?.[k],
        enUS,
      ) as string
  ).replace(/\{(\w+)\}/g, (_m, name) => params[name])

const frame = {
  epoch: 2,
  group_pubkey: '02' + 'cd'.repeat(32),
  prev_epoch_hash: 'ef'.repeat(32),
  write_pubkey: '02' + '11'.repeat(32),
  read_token_hash: '22'.repeat(32),
  encrypted_roster: '33',
  authority_sig: '44'.repeat(64),
  epoch_hash: '55'.repeat(32),
}
const control = {
  type: 'group-control',
  groupId: GROUP_ID,
  action: 'add-member',
  epoch: 2,
  prevEpochHash: 'ef'.repeat(32),
  epochSecretHex: '66'.repeat(32),
  targetAddress: '0x3333333333333333333333333333333333333333',
  authoritySigHex: '44'.repeat(64),
  epochFrame: frame,
}

function mountWith(items: unknown[], outbound = true) {
  return shallowMount(ChatMessage, {
    props: {
      address: '0xPEER',
      name: 'peer',
      chatWidth: 500,
      payloadDigest: 'digest-1',
      message: {
        outbound,
        status: 'confirmed',
        receivedTime: 1,
        serverTime: 1,
        items,
        outpoints: [],
        senderAddress: '0xME',
        stampValueWei: 0n,
      } as never,
    },
    global: {
      stubs: {
        QChatMessage: {
          template: '<div data-testid="bubble"><slot /></div>',
        },
        ChatMessageSuffix: { template: '<i data-testid="suffix" />' },
      },
      mocks: { $t: t, $q: {} },
    },
  })
}

describe('a group record in a direct message', () => {
  it('a membership change is one system line, not a bubble with an amount', () => {
    expect(groupConversationUuid(GROUP_ID)).toBeTruthy()
    const wrapper = mountWith([control])
    expect(wrapper.find('[data-testid="bubble"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="suffix"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="chat-system-line"]').text()).toBe(
      'Group "Core": members changed',
    )
    expect(wrapper.text()).not.toContain('Group control')
  })

  it('an invitation sent and one received each say so', () => {
    const welcome = {
      type: 'group-welcome',
      groupId: GROUP_ID,
      groupName: 'Core',
      groupPubKey: frame.group_pubkey,
      homeRelay: 'https://relay.example',
      epoch: 2,
      epochSecretHex: '66'.repeat(32),
      memberIndex: 1,
      epochFrame: frame,
    }
    expect(
      mountWith([welcome]).get('[data-testid="chat-system-line"]').text(),
    ).toBe('Invitation to the group "Core" sent')
    expect(
      mountWith([welcome], false)
        .get('[data-testid="chat-system-line"]')
        .text(),
    ).toBe('Invitation to the group "Core"')
  })

  it("a received invitation, with the inviter's hidden wakeup card, is one line that opens the group", async () => {
    const welcome = {
      type: 'group-welcome',
      groupId: GROUP_ID,
      groupName: 'Core',
      groupPubKey: frame.group_pubkey,
      homeRelay: 'https://relay.example',
      epoch: 2,
      epochSecretHex: '66'.repeat(32),
      memberIndex: 1,
      epochFrame: frame,
    }
    const wakeupCard = {
      type: 'contact-card',
      uid: 'frank-wakeup-capability',
      fullName: 'Wakeup Capability',
      frankAddress: '0x3B84Bfbb9f032Ff09549044f21981dDf9fe8b38E',
      wakeupTokenHex: '28'.repeat(32),
    }
    const wrapper = mountWith([welcome, wakeupCard], false)
    expect(wrapper.find('[data-testid="bubble"]').exists()).toBe(false)
    const link = wrapper.get('[data-testid="chat-system-line-link"]')
    expect(link.text()).toBe('Invitation to the group "Core"')
    await link.trigger('click')
    expect(openChat).toHaveBeenCalledWith(
      undefined,
      groupConversationUuid(GROUP_ID),
    )
  })

  it('a removal notice tells the removed member', () => {
    const notice = { ...control, action: 'remove-member' }
    delete (notice as { epochSecretHex?: string }).epochSecretHex
    expect(
      mountWith([notice], false).get('[data-testid="chat-system-line"]').text(),
    ).toBe('You were removed from the group "Core"')
  })

  it('a message that also says something stays a bubble', () => {
    const wrapper = mountWith([control, { type: 'text', text: 'hi' }])
    expect(wrapper.find('[data-testid="chat-system-line"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="bubble"]').exists()).toBe(true)
  })
})
