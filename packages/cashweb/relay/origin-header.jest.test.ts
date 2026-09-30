import axios from 'axios'

import { FrankIdentity } from '../legacy-wallet/lotus-identity'
import { registerIdentity } from '../legacy-wallet/lotus-identity'
import { relayOriginHeader } from './origin-header'

jest.mock('axios')
const mockedAxios = axios as unknown as jest.Mock

// Names a browser refuses to let a script set (Fetch spec "forbidden header name"), the subset
// that matters to these registrations.
const FORBIDDEN = ['origin', 'host', 'cookie', 'referer', 'user-agent']

const globals = globalThis as { XMLHttpRequest?: unknown }

afterEach(() => {
  delete globals.XMLHttpRequest
  mockedAxios.mockReset()
})

describe('relayOriginHeader (ticket #278)', () => {
  it('sets the fallback Origin where no browser will send one (Node)', () => {
    expect(relayOriginHeader('http://bot.local')).toEqual({
      Origin: 'http://bot.local',
    })
  })

  it('sets nothing in a browser context (XMLHttpRequest exists): the browser sends its own Origin', () => {
    globals.XMLHttpRequest = class {}
    expect(relayOriginHeader('http://bot.local')).toEqual({})
  })
})

describe('legacy registerIdentity in a browser context (ticket #278)', () => {
  it('sends no forbidden header name', async () => {
    globals.XMLHttpRequest = class {}
    mockedAxios.mockResolvedValueOnce({ status: 200, data: new Uint8Array(0) })
    const identity = FrankIdentity.fromPrivateKeyHex('11'.repeat(32), 'main')

    await registerIdentity({ relayBaseUrl: 'http://relay.test', identity })

    const names = Object.keys(mockedAxios.mock.calls[0][0].headers).map(n =>
      n.toLowerCase(),
    )
    expect(names.filter(n => FORBIDDEN.includes(n))).toEqual([])
  })

  it('still sends the Origin the relay requires from Node', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 200, data: new Uint8Array(0) })
    const identity = FrankIdentity.fromPrivateKeyHex('11'.repeat(32), 'main')

    await registerIdentity({ relayBaseUrl: 'http://relay.test', identity })

    expect(mockedAxios.mock.calls[0][0].headers.Origin).toBe(
      'http://qwen-bot.frank.local',
    )
  })
})
