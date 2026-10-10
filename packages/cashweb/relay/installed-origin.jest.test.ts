import { installedCanonicalOrigin } from './canonical-dm-transport'
import { isLoopbackHostname } from './directory-client'

describe('the relay origin a client may talk to: https, or plain http on this machine', () => {
  it.each([
    'http://127.0.0.1:8098',
    'http://localhost:8098',
    // A dev server opened under a `*.localhost` name (one browser profile per name) proxies
    // the relay on its own origin; browsers resolve such names to the loopback address.
    'http://frank-c.localhost:38471',
    'https://relay.example.com',
  ])('accepts %s', origin => {
    expect(installedCanonicalOrigin(origin)).toBe(origin)
  })

  it.each([
    'http://relay.example.com',
    'http://localhost.example.com',
    'http://notlocalhost:8098',
    'http://192.168.1.83:38471',
    'https://relay.example.com/path',
    'https://user@relay.example.com',
  ])('refuses %s', origin => {
    expect(() => installedCanonicalOrigin(origin)).toThrow(
      'Exact installed origin required',
    )
  })

  it('knows this machine by its three kinds of name only', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('b.localhost')).toBe(true)
    expect(isLoopbackHostname('localhost.evil.example')).toBe(false)
    expect(isLoopbackHostname('evil-localhost')).toBe(false)
  })
})
