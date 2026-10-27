import { isListedConversation } from './listed-conversations'

const direct = { kind: 'direct', messages: [] as unknown[] }

describe('isListedConversation', () => {
  it('does not list an empty default thread the user only opened', () => {
    expect(isListedConversation(direct)).toBe(false)
  })

  it('lists it once it has a message', () => {
    expect(isListedConversation({ ...direct, messages: [{}] })).toBe(true)
  })

  it('keeps listing a thread whose messages were cleared', () => {
    expect(isListedConversation({ ...direct, lastReceived: 1_700 })).toBe(true)
  })

  it.each([
    { ...direct, name: 'Project plan' },
    { ...direct, topic: 'games' },
    { ...direct, kind: 'group' },
    { ...direct, kind: 'email' },
  ])('lists a conversation the user created on purpose: %j', conversation => {
    expect(isListedConversation(conversation)).toBe(true)
  })
})
