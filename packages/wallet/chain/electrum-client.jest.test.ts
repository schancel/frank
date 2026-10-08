import {
  ElectrumClient,
  toElectrumScriptHash,
  ElectrumUtxo,
  ElectrumHistoryItem,
} from './electrum-client'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static shouldFailUrls = new Set<string>()

  readonly url: string
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: any) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  sentMessages: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)

    // Schedule connection or failure asynchronously
    setTimeout(() => {
      if (MockWebSocket.shouldFailUrls.has(url)) {
        this.readyState = 3 // CLOSED
        if (this.onerror) {
          this.onerror(new Error(`Failed to connect to ${url}`))
        }
      } else {
        this.readyState = 1 // OPEN
        if (this.onopen) {
          this.onopen()
        }
      }
    }, 5)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = 3 // CLOSED
    if (this.onclose) {
      this.onclose()
    }
  }

  simulateServerMessage(msg: unknown) {
    if (this.onmessage) {
      this.onmessage({
        data: typeof msg === 'string' ? msg : JSON.stringify(msg),
      })
    }
  }

  simulateDrop() {
    this.readyState = 3
    if (this.onclose) {
      this.onclose()
    }
  }
}

describe('ElectrumClient', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    MockWebSocket.shouldFailUrls.clear()
  })

  describe('scripthash computation (toElectrumScriptHash)', () => {
    it('computes correct scripthash for empty scriptPubKey', () => {
      const hash = toElectrumScriptHash(new Uint8Array(0))
      expect(hash).toBe(
        '55b852781b9995a44c939b64e441ae2724b96f99c8f4fb9a141cfc9842c4b0e3',
      )
    })

    it('computes correct scripthash for Satoshi 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa scriptPubKey', () => {
      const scriptHex = '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'
      const hashFromHex = toElectrumScriptHash(scriptHex)
      const hashFrom0xHex = toElectrumScriptHash('0x' + scriptHex)
      const hashFromBuffer = toElectrumScriptHash(
        Buffer.from(scriptHex, 'hex'),
      )
      const hashFromUint8 = toElectrumScriptHash(
        Uint8Array.from(Buffer.from(scriptHex, 'hex')),
      )

      const expected =
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161'
      expect(hashFromHex).toBe(expected)
      expect(hashFrom0xHex).toBe(expected)
      expect(hashFromBuffer).toBe(expected)
      expect(hashFromUint8).toBe(expected)
    })
  })

  describe('request correlation, RPC methods, and timeouts', () => {
    let client: ElectrumClient

    afterEach(async () => {
      await client?.close()
    })

    it('correlates requests by id out of order', async () => {
      client = new ElectrumClient({
        endpoints: ['wss://electrum.test:50002'],
        WebSocketClass: MockWebSocket,
        pingIntervalMs: 0,
      })

      const connectPromise = client.connect()
      await connectPromise

      const ws = MockWebSocket.instances[0]
      expect(ws).toBeDefined()

      // Start 2 concurrent requests
      const req1Promise = client.serverVersion()
      const req2Promise = client.ping()

      expect(ws.sentMessages.length).toBe(2)
      const msg1 = JSON.parse(ws.sentMessages[0])
      const msg2 = JSON.parse(ws.sentMessages[1])

      expect(msg1.method).toBe('server.version')
      expect(msg2.method).toBe('server.ping')

      // Respond to req2 first (out of order)
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: msg2.id,
        result: null,
      })
      const res2 = await req2Promise
      expect(res2).toBeNull()

      // Then respond to req1
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: msg1.id,
        result: ['FrankElectrum/1.0', '1.4'],
      })
      const res1 = await req1Promise
      expect(res1).toEqual(['FrankElectrum/1.0', '1.4'])
    })

    it('rejects on server RPC error', async () => {
      client = new ElectrumClient({
        endpoints: ['wss://electrum.test:50002'],
        WebSocketClass: MockWebSocket,
        pingIntervalMs: 0,
      })
      await client.connect()
      const ws = MockWebSocket.instances[0]

      const reqPromise = client.broadcastTransaction('deadbeef')
      const msg = JSON.parse(ws.sentMessages[0])

      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -26, message: 'mandatory-script-verify-flag-failed' },
      })

      await expect(reqPromise).rejects.toThrow(
        'mandatory-script-verify-flag-failed',
      )
    })

    it('times out when server does not respond within requestTimeoutMs', async () => {
      client = new ElectrumClient({
        endpoints: ['wss://electrum.test:50002'],
        WebSocketClass: MockWebSocket,
        requestTimeoutMs: 30,
        pingIntervalMs: 0,
      })
      await client.connect()

      const reqPromise = client.listUnspent(
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161',
      )

      await expect(reqPromise).rejects.toThrow('timed out after 30ms')
    })

    it('executes listUnspent, getBalance, and getHistory correctly', async () => {
      client = new ElectrumClient({
        endpoints: ['wss://electrum.test:50002'],
        WebSocketClass: MockWebSocket,
        pingIntervalMs: 0,
      })
      await client.connect()
      const ws = MockWebSocket.instances[0]

      const scriptHash =
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161'

      // listUnspent
      const utxosPromise = client.listUnspent(scriptHash)
      const utxoMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
      expect(utxoMsg.method).toBe('blockchain.scripthash.listunspent')
      expect(utxoMsg.params[0]).toBe(scriptHash)
      const mockUtxos: ElectrumUtxo[] = [
        {
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 5000000000,
          height: 100,
        },
      ]
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: utxoMsg.id,
        result: mockUtxos,
      })
      expect(await utxosPromise).toEqual(mockUtxos)

      // getBalance
      const balancePromise = client.getBalance(scriptHash)
      const balMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
      expect(balMsg.method).toBe('blockchain.scripthash.get_balance')
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: balMsg.id,
        result: { confirmed: 5000000000, unconfirmed: 1000 },
      })
      expect(await balancePromise).toEqual({
        confirmed: 5000000000,
        unconfirmed: 1000,
      })

      // getHistory
      const historyPromise = client.getHistory(scriptHash)
      const histMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
      expect(histMsg.method).toBe('blockchain.scripthash.get_history')
      const mockHistory: ElectrumHistoryItem[] = [
        { tx_hash: '22'.repeat(32), height: 99, fee: 200 },
      ]
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: histMsg.id,
        result: mockHistory,
      })
      expect(await historyPromise).toEqual(mockHistory)

      // broadcastTransaction
      const broadcastPromise = client.broadcastTransaction('0200000001...')
      const bcastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
      expect(bcastMsg.method).toBe('blockchain.transaction.broadcast')
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: bcastMsg.id,
        result: '33'.repeat(32),
      })
      expect(await broadcastPromise).toBe('33'.repeat(32))
    })
  })

  describe('multi-server failover', () => {
    let client: ElectrumClient

    afterEach(async () => {
      await client?.close()
    })

    it('fails over to second endpoint when first endpoint connection fails', async () => {
      const endpoints = [
        'wss://bad-server.example.com:50002',
        'wss://good-server.example.com:50002',
      ]
      MockWebSocket.shouldFailUrls.add(endpoints[0])

      client = new ElectrumClient({
        endpoints,
        WebSocketClass: MockWebSocket,
        pingIntervalMs: 0,
      })

      await client.connect()

      expect(client.isConnected).toBe(true)
      expect(client.currentEndpoint).toBe('wss://good-server.example.com:50002')
      expect(client.currentEndpointIndex).toBe(1)
      expect(MockWebSocket.instances.length).toBe(2)
      expect(MockWebSocket.instances[0].url).toBe(endpoints[0])
      expect(MockWebSocket.instances[1].url).toBe(endpoints[1])
    })
  })

  describe('subscriptions, server push, and reconnect resubscription', () => {
    let client: ElectrumClient

    afterEach(async () => {
      await client?.close()
    })

    it('receives status push notifications and resubscribes on dropped connection', async () => {
      client = new ElectrumClient({
        endpoints: [
          'wss://server1.example.com:50002',
          'wss://server2.example.com:50002',
        ],
        WebSocketClass: MockWebSocket,
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 20,
        pingIntervalMs: 0,
      })

      await client.connect()
      const ws1 = MockWebSocket.instances[0]
      const scriptHash =
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161'

      const updates: Array<string | null> = []
      const subPromise = client.subscribeScriptHash(scriptHash, status => {
        updates.push(status)
      })

      const subMsg = JSON.parse(ws1.sentMessages[0])
      expect(subMsg.method).toBe('blockchain.scripthash.subscribe')
      ws1.simulateServerMessage({
        jsonrpc: '2.0',
        id: subMsg.id,
        result: 'initial_status_hash_1',
      })
      const initialStatus = await subPromise
      expect(initialStatus).toBe('initial_status_hash_1')

      // Server push notification (no id)
      ws1.simulateServerMessage({
        jsonrpc: '2.0',
        method: 'blockchain.scripthash.subscribe',
        params: [scriptHash, 'updated_status_hash_2'],
      })
      expect(updates).toEqual(['updated_status_hash_2'])

      // Simulate connection drop
      ws1.simulateDrop()
      expect(client.isConnected).toBe(false)

      // Wait for auto-reconnect to instantiate socket 2
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(MockWebSocket.instances.length).toBe(2)
      const ws2 = MockWebSocket.instances[1]

      // Wait for ws2 to open and send resubscribe request
      await new Promise(resolve => setTimeout(resolve, 20))
      const resubMsg = ws2.sentMessages.find(m => {
        const parsed = JSON.parse(m)
        return parsed.method === 'blockchain.scripthash.subscribe'
      })
      expect(resubMsg).toBeDefined()

      // Unsubscribe
      const unsub = await client.unsubscribeScriptHash(scriptHash)
      expect(unsub).toBe(true)
    })
  })

  describe('heartbeat ping', () => {
    let client: ElectrumClient

    afterEach(async () => {
      await client?.close()
    })

    it('sends periodic server.ping and handles failure by dropping connection', async () => {
      client = new ElectrumClient({
        endpoints: ['wss://server.example.com:50002'],
        WebSocketClass: MockWebSocket,
        pingIntervalMs: 20,
        requestTimeoutMs: 15,
        reconnectBaseDelayMs: 1000,
      })

      await client.connect()
      const ws = MockWebSocket.instances[0]

      // Wait for first ping to be sent
      await new Promise(resolve => setTimeout(resolve, 30))
      const pingSent = ws.sentMessages.some(m => JSON.parse(m).method === 'server.ping')
      expect(pingSent).toBe(true)
    })
  })

  describe('relay capability endpoint integration', () => {
    let client: ElectrumClient

    afterEach(async () => {
      await client?.close()
    })

    it('connects to relay capability WS endpoint and multiplexes requests and push notifications', async () => {
      const relayWsUrl =
        'wss://relay.frank.internal/chain-rpc/btc-mainnet/cap/test-token-abcdef/ws'
      client = new ElectrumClient({
        endpoints: [relayWsUrl],
        WebSocketClass: MockWebSocket,
        pingIntervalMs: 0,
      })

      await client.connect()
      expect(client.isConnected).toBe(true)
      expect(client.currentEndpoint).toBe(relayWsUrl)

      const ws = MockWebSocket.instances[0]
      expect(ws.url).toBe(relayWsUrl)

      // Test RPC multiplexing over relay WS
      const scriptHash =
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161'
      let pushCount = 0
      let latestStatus: string | null = null

      const subPromise = client.subscribeScriptHash(scriptHash, status => {
        pushCount++
        latestStatus = status
      })

      const subMsg = ws.sentMessages.find(
        m => JSON.parse(m).method === 'blockchain.scripthash.subscribe',
      )
      expect(subMsg).toBeDefined()
      const parsedSub = JSON.parse(subMsg!)

      // Simulate initial subscription response from relay
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: parsedSub.id,
        result: 'initial-status-hash',
      })
      const initResult = await subPromise
      expect(initResult).toBe('initial-status-hash')

      // Simulate push notification from relay for scriptHash
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        method: 'blockchain.scripthash.subscribe',
        params: [scriptHash, 'updated-status-hash'],
      })
      expect(pushCount).toBe(1)
      expect(latestStatus).toBe('updated-status-hash')

      // Query balance concurrently
      const balancePromise = client.getBalance(scriptHash)
      const balanceMsg = ws.sentMessages.find(
        m => JSON.parse(m).method === 'blockchain.scripthash.get_balance',
      )
      expect(balanceMsg).toBeDefined()
      const parsedBalance = JSON.parse(balanceMsg!)
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: parsedBalance.id,
        result: { confirmed: 5000000000, unconfirmed: 0 },
      })
      const balance = await balancePromise
      expect(balance.confirmed).toBe(5000000000)

      // Broadcast transaction
      const broadcastPromise = client.broadcastTransaction('0200000001...')
      const broadcastMsg = ws.sentMessages.find(
        m => JSON.parse(m).method === 'blockchain.transaction.broadcast',
      )
      expect(broadcastMsg).toBeDefined()
      const parsedBroadcast = JSON.parse(broadcastMsg!)
      ws.simulateServerMessage({
        jsonrpc: '2.0',
        id: parsedBroadcast.id,
        result: 'txid-1234567890abcdef',
      })
      const txid = await broadcastPromise
      expect(txid).toBe('txid-1234567890abcdef')
    })
  })
})
