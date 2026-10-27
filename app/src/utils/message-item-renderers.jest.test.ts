import { groupConversationUuid } from '@frank/cashweb/groups/group-crypto'
import {
  conversationSystemLine,
  systemLineText,
} from './message-item-renderers'

const groupId = 'ab'.repeat(32)
const welcome = {
  type: 'group-welcome',
  groupId,
  groupName: 'UX Group',
} as never

describe('group invitation line', () => {
  it('names the group conversation this account has, so tapping it opens the group', () => {
    const id = groupConversationUuid(groupId)
    const line = conversationSystemLine([welcome], false, {
      [id]: { name: 'UX Group' },
    })
    expect(line?.conversationId).toBe(id)
    expect(systemLineText(line!, key => key)).toBe(
      'groupChat.systemInviteReceived',
    )
  })

  it('names none when this account has no such group, or deleted it', () => {
    expect(
      conversationSystemLine([welcome], false, {})?.conversationId,
    ).toBeUndefined()
    expect(
      conversationSystemLine([welcome], false, {
        [groupConversationUuid(groupId)]: { name: 'UX Group', deletedAt: 1 },
      })?.conversationId,
    ).toBeUndefined()
  })
})
