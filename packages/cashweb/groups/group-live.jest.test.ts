import { GroupRelayClient } from './group-relay-client'

class Socket {
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  send = jest.fn()
  close = jest.fn()
  wake() {
    this.onmessage?.({ data: '{"type":"group-wakeup"}' })
  }
}
const settle = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

describe('group live subscriptions', () => {
  afterEach(() => jest.useRealTimers())
  it('coalesces repeated hints, reconnects with durable recovery, and ignores stale sockets', async () => {
    jest.useFakeTimers()
    const sockets: Socket[] = []
    const urls: string[] = []
    const client = new GroupRelayClient('https://foreign.example', {
      homeRelayUrl: 'https://home.example',
      subscriberTag: async () => 'ab'.repeat(32),
      webSocketFactory: (url) => {
        urls.push(url)
        const socket = new Socket()
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const wake = jest
      .fn()
      .mockImplementationOnce(() => blocked)
      .mockResolvedValue(undefined)
    const live = client.subscribeGroupMessages(
      '11'.repeat(32),
      3,
      '22'.repeat(32),
      wake,
    )
    await settle()
    expect(urls).toEqual([`wss://home.example/groups/${'11'.repeat(32)}/live`])
    sockets[0].onopen!()
    expect(JSON.parse(sockets[0].send.mock.calls[0][0])).toEqual({
      epoch: 3,
      read_token: '22'.repeat(32),
      upstream_relay: 'https://foreign.example',
      subscriber_tag: 'ab'.repeat(32),
    })
    sockets[0].onmessage!({ data: '{"server_seq":100000}' })
    sockets[0].wake()
    sockets[0].wake()
    sockets[0].wake()
    expect(wake).toHaveBeenCalledTimes(1)
    release()
    await settle()
    expect(wake).toHaveBeenCalledTimes(2)
    sockets[0].onclose!()
    jest.advanceTimersByTime(1000)
    await settle()
    expect(sockets).toHaveLength(2)
    sockets[0].wake()
    expect(wake).toHaveBeenCalledTimes(2)
    sockets[1].onopen!()
    sockets[1].wake()
    await settle()
    expect(wake).toHaveBeenCalledTimes(3)
    live.close()
    expect(sockets[1].close).toHaveBeenCalledTimes(1)
    sockets[1].wake()
    sockets[1].onclose!()
    jest.advanceTimersByTime(60_000)
    await settle()
    expect(wake).toHaveBeenCalledTimes(3)
    expect(sockets).toHaveLength(2)
  })

  it('does not open a socket after asynchronous subscriber derivation is cancelled', async () => {
    let release!: (tag: string) => void
    const tag = new Promise<string>((resolve) => {
      release = resolve
    })
    const factory = jest.fn()
    const client = new GroupRelayClient('https://home.example', {
      subscriberTag: () => tag,
      webSocketFactory: factory,
    })
    const live = client.subscribeGroupMessages(
      '11'.repeat(32),
      0,
      '22'.repeat(32),
      async () => undefined,
    )
    live.close()
    release('33'.repeat(32))
    await settle()
    expect(factory).not.toHaveBeenCalled()
  })
})
