import { ACCOUNT_TYPE_BOT, ACCOUNT_TYPE_SERVICE } from '@frank/codec'
import { isAutomatedAccount, supportedCallMedia } from './webrtc-call-support'

describe('supportedCallMedia', () => {
  it('offers voice and video with one person', () => {
    expect(
      supportedCallMedia({ group: false, otherParticipantCount: 1 }),
    ).toEqual(['audio', 'video'])
  })

  it('offers no call in a group', () => {
    expect(
      supportedCallMedia({ group: true, otherParticipantCount: 1 }),
    ).toEqual([])
  })

  it('offers no call to a peer whose profile declares a bot or a service', () => {
    expect(
      supportedCallMedia({
        group: false,
        otherParticipantCount: 1,
        peerIsAutomated: true,
      }),
    ).toEqual([])
  })
})

describe('isAutomatedAccount: what the profile declares, never its name', () => {
  it.each([
    [{ isBot: true }, true],
    [{ accountType: ACCOUNT_TYPE_BOT }, true],
    [{ accountType: ACCOUNT_TYPE_SERVICE, isBot: false }, true],
    [{ isBot: false, accountType: 0 }, false],
    [{ isBot: false }, false],
    [undefined, false],
  ])('%j -> %s', (profile, automated) => {
    expect(isAutomatedAccount(profile)).toBe(automated)
  })

  it('does not read the name', () => {
    expect(
      isAutomatedAccount({ name: 'Satoshi Dice Bot' } as { isBot?: boolean }),
    ).toBe(false)
  })
})
