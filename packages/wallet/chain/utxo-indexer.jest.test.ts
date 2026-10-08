import {
  UtxoIndexer,
  ElectrumUtxoIndexer,
  ChronikUtxoIndexer,
  createUtxoIndexer,
  resolveElectrumScriptHash,
} from './utxo-indexer'
import {
  PROTOCOL_CHAINS,
  ChainRegistryEntry,
} from './chains-registry'
import { ElectrumClient, ElectrumUtxo } from './electrum-client'
import { ChronikClient } from 'chronik-client'
import { encodeBase58Check } from '@frank/nakamoto'

describe('utxo-indexer', () => {
  describe('resolveElectrumScriptHash', () => {
    it('accepts an already computed 64-character scripthash', () => {
      const sh =
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161'
      expect(resolveElectrumScriptHash(sh)).toBe(sh)
      expect(resolveElectrumScriptHash(sh.toUpperCase())).toBe(sh)
    })

    it('resolves Bitcoin Satoshi legacy address (1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa)', () => {
      const sh = resolveElectrumScriptHash(
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      )
      expect(sh).toBe(
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161',
      )
    })

    it('resolves Bitcoin Cash CashAddress', () => {
      const sh = resolveElectrumScriptHash(
        'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      )
      expect(sh).toBe(
        '71b6a00546326a622c2a484e88a81909706a0cce15009aa87fd9a6569ca84c93',
      )
    })

    it('resolves Dogecoin Base58Check address', () => {
      // 0x1e = Dogecoin P2PKH version
      const payload = new Uint8Array(21)
      payload[0] = 0x1e
      payload.fill(0xab, 1)
      const dogeAddr = encodeBase58Check(payload)

      const sh = resolveElectrumScriptHash(dogeAddr)
      expect(sh).toHaveLength(64)
      expect(/^[0-9a-f]{64}$/.test(sh)).toBe(true)
    })

    it('resolves raw scriptPubKey hex string', () => {
      const scriptHex = '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'
      const sh = resolveElectrumScriptHash(scriptHex)
      expect(sh).toBe(
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161',
      )
    })

    it('throws on invalid address or format', () => {
      expect(() => resolveElectrumScriptHash('not_an_address')).toThrow(
        'Unable to resolve Electrum scripthash',
      )
    })
  })

  describe('createUtxoIndexer factory', () => {
    it('creates ChronikUtxoIndexer for xec-mainnet and xec-testnet', () => {
      const indexerMain = createUtxoIndexer(PROTOCOL_CHAINS['xec-mainnet'])
      expect(indexerMain).toBeInstanceOf(ChronikUtxoIndexer)
      expect(indexerMain.chainId).toBe('xec-mainnet')

      const indexerTest = createUtxoIndexer(PROTOCOL_CHAINS['xec-testnet'])
      expect(indexerTest).toBeInstanceOf(ChronikUtxoIndexer)
      expect(indexerTest.chainId).toBe('xec-testnet')
    })

    it('creates ElectrumUtxoIndexer for btc-mainnet, btc-testnet, bch-mainnet, and doge-mainnet', () => {
      const btc = createUtxoIndexer(PROTOCOL_CHAINS['btc-mainnet'])
      expect(btc).toBeInstanceOf(ElectrumUtxoIndexer)
      expect(btc.chainId).toBe('btc-mainnet')

      const btcTest = createUtxoIndexer(PROTOCOL_CHAINS['btc-testnet'])
      expect(btcTest).toBeInstanceOf(ElectrumUtxoIndexer)
      expect(btcTest.chainId).toBe('btc-testnet')

      const bch = createUtxoIndexer(PROTOCOL_CHAINS['bch-mainnet'])
      expect(bch).toBeInstanceOf(ElectrumUtxoIndexer)
      expect(bch.chainId).toBe('bch-mainnet')

      const doge = createUtxoIndexer(PROTOCOL_CHAINS['doge-mainnet'])
      expect(doge).toBeInstanceOf(ElectrumUtxoIndexer)
      expect(doge.chainId).toBe('doge-mainnet')
    })

    it('uses injected electrumClient or chronikClient when provided', () => {
      const mockElectrum = {
        listUnspent: jest.fn(),
      } as unknown as ElectrumClient
      const btc = createUtxoIndexer(PROTOCOL_CHAINS['btc-mainnet'], {
        electrumClient: mockElectrum,
      })
      expect(btc).toBeInstanceOf(ElectrumUtxoIndexer)
      expect((btc as ElectrumUtxoIndexer).client).toBe(mockElectrum)

      const mockChronik = {
        script: jest.fn(),
      } as unknown as ChronikClient
      const xec = createUtxoIndexer(PROTOCOL_CHAINS['xec-mainnet'], {
        chronikClient: mockChronik,
      })
      expect(xec).toBeInstanceOf(ChronikUtxoIndexer)
      expect((xec as ChronikUtxoIndexer).chronik).toBe(mockChronik)
    })
  })

  describe('ElectrumUtxoIndexer', () => {
    let mockClient: jest.Mocked<ElectrumClient>
    let indexer: ElectrumUtxoIndexer

    beforeEach(() => {
      mockClient = {
        listUnspent: jest.fn(),
        getBalance: jest.fn(),
        broadcastTransaction: jest.fn(),
        subscribeScriptHash: jest.fn(),
        unsubscribeScriptHash: jest.fn(),
        close: jest.fn(),
      } as unknown as jest.Mocked<ElectrumClient>

      indexer = new ElectrumUtxoIndexer('btc-mainnet', mockClient)
    })

    it('fetches and maps UTXOs to UtxoItem with satoshis as bigint', async () => {
      const elUtxos: ElectrumUtxo[] = [
        {
          tx_hash: 'aa'.repeat(32),
          tx_pos: 0,
          value: 100_000_000, // 1 BTC in sats
          height: 800000,
        },
        {
          tx_hash: 'bb'.repeat(32),
          tx_pos: 1,
          value: 50_000_000,
          height: 0, // unconfirmed mempool
        },
      ]
      mockClient.listUnspent.mockResolvedValueOnce(elUtxos)

      const utxos = await indexer.fetchUtxos(
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      )

      expect(mockClient.listUnspent).toHaveBeenCalledWith(
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161',
      )
      expect(utxos).toEqual([
        {
          txId: 'aa'.repeat(32),
          outputIndex: 0,
          satoshis: 100_000_000n,
          height: 800000,
        },
        {
          txId: 'bb'.repeat(32),
          outputIndex: 1,
          satoshis: 50_000_000n,
          height: undefined,
        },
      ])
    })

    it('fetches balance and returns confirmed and unconfirmed bigints', async () => {
      mockClient.getBalance.mockResolvedValueOnce({
        confirmed: 200_000_000,
        unconfirmed: 50_000,
      })

      const balance = await indexer.fetchBalance(
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      )

      expect(balance).toEqual({
        confirmed: 200_000_000n,
        unconfirmed: 50_000n,
      })
    })

    it('broadcasts a raw transaction hex', async () => {
      mockClient.broadcastTransaction.mockResolvedValueOnce('txid_123')

      const txid = await indexer.broadcastTx('0200000001...')
      expect(mockClient.broadcastTransaction).toHaveBeenCalledWith(
        '0200000001...',
      )
      expect(txid).toBe('txid_123')
    })

    it('subscribes and unsubscribes from updates', async () => {
      let registeredCb: ((status: string | null) => void) | undefined
      mockClient.subscribeScriptHash.mockImplementationOnce(
        async (_sh, cb) => {
          registeredCb = cb
          return 'initial_status'
        },
      )
      mockClient.unsubscribeScriptHash.mockResolvedValueOnce(true)

      const onUpdate = jest.fn()
      const unsubscribe = await indexer.subscribe(
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        onUpdate,
      )

      expect(mockClient.subscribeScriptHash).toHaveBeenCalled()
      expect(registeredCb).toBeDefined()

      registeredCb!('new_status')
      expect(onUpdate).toHaveBeenCalledTimes(1)

      await unsubscribe()
      expect(mockClient.unsubscribeScriptHash).toHaveBeenCalledWith(
        '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161',
      )
    })

    it('closes the underlying ElectrumClient', async () => {
      await indexer.close()
      expect(mockClient.close).toHaveBeenCalledTimes(1)
    })
  })

  describe('ChronikUtxoIndexer', () => {
    let mockChronik: any
    let indexer: ChronikUtxoIndexer

    beforeEach(() => {
      mockChronik = {
        script: jest.fn(),
        broadcastTx: jest.fn(),
        ws: jest.fn(),
      }
      indexer = new ChronikUtxoIndexer('xec-mainnet', mockChronik)
    })

    it('fetches and maps eCash UTXOs to UtxoItem', async () => {
      const mockScriptEndpoint = {
        utxos: jest.fn().mockResolvedValueOnce([
          {
            outputScript: '76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac',
            utxos: [
              {
                outpoint: { txid: 'cc'.repeat(32), outIdx: 0 },
                value: '1000000',
                blockHeight: 700000,
              },
              {
                outpoint: { txid: 'dd'.repeat(32), outIdx: 1 },
                value: '500000',
                blockHeight: -1, // mempool
              },
            ],
          },
        ]),
      }
      mockChronik.script.mockReturnValueOnce(mockScriptEndpoint)

      const utxos = await indexer.fetchUtxos(
        'ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl',
      )

      expect(mockChronik.script).toHaveBeenCalledWith('p2pkh', expect.any(String))
      expect(utxos).toEqual([
        {
          txId: 'cc'.repeat(32),
          outputIndex: 0,
          satoshis: 1_000_000n,
          script: '76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac',
          height: 700000,
        },
        {
          txId: 'dd'.repeat(32),
          outputIndex: 1,
          satoshis: 500_000n,
          script: '76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac',
          height: undefined,
        },
      ])
    })

    it('fetches balance partitioned into confirmed and unconfirmed', async () => {
      const mockScriptEndpoint = {
        utxos: jest.fn().mockResolvedValueOnce([
          {
            outputScript: '76a914...',
            utxos: [
              { outpoint: { txid: 'cc', outIdx: 0 }, value: '800000', blockHeight: 700000 },
              { outpoint: { txid: 'dd', outIdx: 0 }, value: '200000', blockHeight: -1 },
            ],
          },
        ]),
      }
      mockChronik.script.mockReturnValueOnce(mockScriptEndpoint)

      const balance = await indexer.fetchBalance(
        'ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl',
      )

      expect(balance).toEqual({
        confirmed: 800000n,
        unconfirmed: 200000n,
      })
    })

    it('broadcasts transactions via Chronik', async () => {
      mockChronik.broadcastTx.mockResolvedValueOnce({ txid: 'chronik_txid_456' })

      const txid = await indexer.broadcastTx('0200000001...')
      expect(mockChronik.broadcastTx).toHaveBeenCalledWith('0200000001...')
      expect(txid).toBe('chronik_txid_456')
    })

    it('subscribes to Chronik WebSocket updates and unsubscribes', async () => {
      let onMsgHandler: any
      const mockWsEndpoint = {
        subscribe: jest.fn(),
        unsubscribe: jest.fn(),
        close: jest.fn(),
      }
      mockChronik.ws.mockImplementationOnce((config: any) => {
        onMsgHandler = config.onMessage
        return mockWsEndpoint
      })

      const onUpdate = jest.fn()
      const unsubscribe = await indexer.subscribe(
        'ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl',
        onUpdate,
      )

      expect(mockWsEndpoint.subscribe).toHaveBeenCalledWith(
        'p2pkh',
        expect.any(String),
      )

      // Simulate websocket message from Chronik
      onMsgHandler({ type: 'AddedToMempool', txid: 'tx_abc' })
      expect(onUpdate).toHaveBeenCalledTimes(1)

      // Unsubscribe
      await unsubscribe()
      expect(mockWsEndpoint.unsubscribe).toHaveBeenCalledWith(
        'p2pkh',
        expect.any(String),
      )

      await indexer.close()
      expect(mockWsEndpoint.close).toHaveBeenCalledTimes(1)
    })
  })
})
