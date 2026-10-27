import { isListedConversation } from './listed-conversations'

// A default thread's ID is a UUIDv5 (the opening ID); an explicitly created conversation's is a
// UUIDv4.
const OPENING_ID = '6ba7b810-9dad-51d1-80b4-00c04fd430c8'
const EXPLICIT_ID = '3206113e-1a26-48bc-a177-bfa929512d4d'
const direct = { id: OPENING_ID, kind: 'direct', messages: [] as unknown[] }

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

  it('lists an empty default thread that holds an unsent draft', () => {
    expect(isListedConversation(direct, c => c.id === OPENING_ID)).toBe(true)
  })

  it('lists an explicitly created conversation renamed to a blank subject, with no messages', () => {
    expect(isListedConversation({ ...direct, id: EXPLICIT_ID, name: '' })).toBe(
      true,
    )
  })

  it.each([
    { ...direct, name: 'Project plan' },
    { ...direct, topic: 'games' },
    { ...direct, kind: 'group' },
    { ...direct, kind: 'email' },
    { ...direct, id: EXPLICIT_ID },
  ])('lists a conversation the user created on purpose: %j', conversation => {
    expect(isListedConversation(conversation)).toBe(true)
  })
})
