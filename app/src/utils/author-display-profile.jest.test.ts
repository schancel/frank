import { authorDisplayProfile } from './author-display-profile'

it('preserves correctly typed display fields including empty, zero and false without mutation', () => {
  const profile = Object.freeze({
    name: '',
    username: 'handle',
    accountType: 0,
    botRole: 0,
    isBot: false,
    privateField: 'excluded',
  })
  expect(authorDisplayProfile(profile)).toEqual({
    name: '',
    username: 'handle',
    accountType: 0,
    botRole: 0,
    isBot: false,
  })
  expect(profile.privateField).toBe('excluded')
})

it('admits each display field independently without coercing incompatible values', () => {
  const profile = Object.freeze({
    name: {},
    username: 'usable',
    accountType: '1',
    botRole: 2,
    isBot: 'false',
  })
  expect(authorDisplayProfile(profile)).toEqual({
    username: 'usable',
    botRole: 2,
  })
})

it.each([undefined, null, '', 'name', 0, false, [], {}])(
  'has no display fields for %p',
  profile => {
    expect(authorDisplayProfile(profile)).toEqual({})
  },
)
