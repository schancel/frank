import { Wallet } from 'ethers'
import { Keypair } from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'
import {
  ChainUtxoPool,
  ChainUtxoView,
  ChainUtxoCoin,
  makeUtxoId,
  inferChainFamily,
  normalizeUtxoAddress,
  formatUtxoAddress,
} from './chain-utxo-pool'
import { orderOfMagnitude2 } from './monad-change-distribution'
import { SolanaWallet } from './solana-wallet'
import { EcashWallet } from './ecash-wallet'
import { UtxoIndexer, UtxoItem, syncIndexerUtxosToPool } from './chain/utxo-indexer'

describe('ChainUtxoPool Unified Chain-Agnostic Pool System', () => {
  const base58Decoder = getBase58Decoder()

  describe('Address & ID Helpers', () => {
    it('infers chain families correctly', () => {
      expect(inferChainFamily('monad')).toBe('evm')
      expect(inferChainFamily('monad-testnet')).toBe('evm')
      expect(inferChainFamily('evm')).toBe('evm')
      expect(inferChainFamily('ethereum')).toBe('evm')
      expect(inferChainFamily('solana')).toBe('solana')
      expect(inferChainFamily('solana-devnet')).toBe('solana')
      expect(inferChainFamily('ecash')).toBe('utxo')
      expect(inferChainFamily('xec-mainnet')).toBe('utxo')
      expect(inferChainFamily('xec-testnet')).toBe('utxo')
      expect(inferChainFamily('bitcoin')).toBe('utxo')
      expect(inferChainFamily('btc')).toBe('utxo')
    })

    it('formats and normalizes addresses per family', () => {
      const evmRaw = '0x52908400098527886E0F7030069857D2E4169EE7'
      expect(normalizeUtxoAddress(evmRaw, 'monad')).toBe(evmRaw.toLowerCase())
      expect(formatUtxoAddress(evmRaw.toLowerCase(), 'monad')).toBe(evmRaw)

      const solanaAddr = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'
      expect(normalizeUtxoAddress(solanaAddr, 'solana')).toBe(solanaAddr)
      expect(formatUtxoAddress(solanaAddr, 'solana')).toBe(solanaAddr)

      const utxoAddr = 'ecash:qz2708636sn2st080sfs53q9fa2z6q5925d40gv4e5'
      expect(normalizeUtxoAddress(utxoAddr, 'ecash')).toBe(utxoAddr)
    })

    it('formats canonical UTXO id for account and native UTXO', () => {
      const evmId = makeUtxoId('monad', '0x1111111111111111111111111111111111111111', 0, 'evm')
      expect(evmId).toBe('monad:evm:0x1111111111111111111111111111111111111111:0')

      const solanaId = makeUtxoId('solana', 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', 0, 'solana')
      expect(solanaId).toBe('solana:solana:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB:0')

      const utxoId = makeUtxoId('ecash', 'ecash:qztest', { txid: 'abc1234', vout: 1 }, 'utxo')
      expect(utxoId).toBe('ecash:utxo:ecash:qztest:abc1234:1')
    })
  })

  describe('EVM Family Adapter & Coin Selection with Radix Splits', () => {
    let pool: ChainUtxoPool
    const wallet1 = Wallet.createRandom()
    const wallet2 = Wallet.createRandom()
    const wallet3 = Wallet.createRandom()
    const walletStealth = Wallet.createRandom()

    beforeEach(() => {
      pool = new ChainUtxoPool()
    })

    it('registers sub-accounts, change accounts, and stealth accounts with attached private keys', () => {
      const sub = pool.evm.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 10_000_000n,
        derivationPath: "m/44'/60'/0'/0/0",
        index: 0,
      })
      expect(sub.family).toBe('evm')
      expect(sub.origin).toBe('subaccount')
      expect(sub.status).toBe('clean')
      expect(sub.privateKey).toBe(wallet1.privateKey)

      const change = pool.evm.registerChangeAccount({
        chain: 'monad',
        address: wallet2.address,
        privateKey: wallet2.privateKey,
        balanceWei: 5_000_000n,
      })
      expect(change.family).toBe('evm')
      expect(change.origin).toBe('change')

      const stealth = pool.evm.registerStealthAccount({
        chain: 'monad',
        address: walletStealth.address,
        privateKey: walletStealth.privateKey,
        balanceWei: 20_000_000n,
        ephemeralPubKey: '0x02beef',
      })
      expect(stealth.family).toBe('evm')
      expect(stealth.origin).toBe('stealth')

      expect(pool.getCleanCoins('monad')).toHaveLength(3)
      expect(pool.getTotalBalance('monad')).toBe(35_000_000n)
    })

    it('creates MonadAccountTxSigner directly from attached private key in O(1)', () => {
      const sub = pool.evm.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 10_000_000n,
      })

      const signer = pool.evm.createSigner(sub)
      expect(signer).toBeDefined()
      expect(signer.address.toLowerCase()).toBe(wallet1.address.toLowerCase())
    })

    it('selects best-fit single coin and computes geometric radix change splits with decoy avoidance', () => {
      pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 10_000n,
      })
      pool.registerChangeAccount({
        chain: 'monad',
        address: wallet2.address,
        privateKey: wallet2.privateKey,
        balanceWei: 50_000n,
      })
      pool.registerSubAccount({
        chain: 'monad',
        address: wallet3.address,
        privateKey: wallet3.privateKey,
        balanceWei: 250_000n,
      })

      // Single best fit: smallest coin >= (40,000 + 5,000) = 45,000 -> wallet2 (50,000)
      const res = pool.selectCoins({
        chain: 'monad',
        targetAmountWei: 40_000n,
        feeReserveWei: 5_000n,
      })
      expect(res.selected).toHaveLength(1)
      expect(res.selected[0].balanceWei).toBe(50_000n)
      expect(res.changeWei).toBe(5_000n)

      // Test radix split and decoy avoidance:
      const targetAmountWei = 16_384n
      const targetOOM = orderOfMagnitude2(targetAmountWei)
      const splitRes = pool.selectCoins({
        chain: 'monad',
        targetAmountWei,
        feeReserveWei: 1_000n,
        decoyAvoidance: true,
      })
      expect(splitRes.changeWei).toBeGreaterThan(0n)
      for (const split of splitRes.suggestedChangeSplits) {
        expect(orderOfMagnitude2(split)).not.toBe(targetOOM)
      }
    })

    it('supports atomic selection with rollback on broadcast error', async () => {
      const sub = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 100_000n,
      })

      expect(pool.getCleanCoins('monad')).toHaveLength(1)

      // Simulate a failure inside atomic selection
      await expect(
        pool.withAtomicSelection(
          {
            chain: 'monad',
            targetAmountWei: 50_000n,
          },
          async selection => {
            expect(selection.selected).toHaveLength(1)
            // Coin is pending inside block
            expect(pool.getCleanCoins('monad')).toHaveLength(0)
            expect(pool.getPendingCoins('monad')).toHaveLength(1)
            throw new Error('Broadcast failed')
          },
        ),
      ).rejects.toThrow('Broadcast failed')

      // Rollback restores coin to clean
      expect(pool.getCleanCoins('monad')).toHaveLength(1)
      expect(pool.getPendingCoins('monad')).toHaveLength(0)
    })

    it('creates multi-UTXO batch sweep plans enforcing healthy non-dust output thresholds', () => {
      const dirty1 = pool.evm.importPrivateKey({
        chain: 'monad',
        address: Wallet.createRandom().address,
        privateKey: Wallet.createRandom().privateKey,
        balanceWei: 100_000n,
        nonce: 1, // dirty
      })
      const dirty2 = pool.evm.importPrivateKey({
        chain: 'monad',
        address: Wallet.createRandom().address,
        privateKey: Wallet.createRandom().privateKey,
        balanceWei: 150_000n,
        nonce: 2, // dirty
      })
      const dirty3 = pool.evm.importPrivateKey({
        chain: 'monad',
        address: Wallet.createRandom().address,
        privateKey: Wallet.createRandom().privateKey,
        balanceWei: 250_000n,
        nonce: 1, // dirty
      })

      const dest1 = Wallet.createRandom().address
      const dest2 = Wallet.createRandom().address

      // Batch sweep of 3 dirty coins: gross = 500,000, fee = 3 * 21,000 = 63,000, net = 437,000
      const plan = pool.evm.createBatchSweepPlan({
        chain: 'monad',
        dirtyUtxoIds: [dirty1.id, dirty2.id, dirty3.id],
        destinationAddresses: [dest1, dest2],
        minFeePerTxWei: 21_000n,
      })

      expect(plan.dirtyUtxos).toHaveLength(3)
      expect(plan.totalGrossWei).toBe(500_000n)
      expect(plan.totalFeesWei).toBe(63_000n)
      expect(plan.totalNetWei).toBe(437_000n)
      expect(plan.consolidationOutputs.length).toBeGreaterThanOrEqual(1)

      // Every output is healthy (well above 2 * minFeePerTxWei = 42,000)
      for (const output of plan.consolidationOutputs) {
        expect(output.amountWei).toBeGreaterThanOrEqual(42_000n)
      }

      // Exact sum of outputs equals net
      const totalOutputs = plan.consolidationOutputs.reduce(
        (sum, o) => sum + o.amountWei,
        0n,
      )
      expect(totalOutputs).toBe(plan.totalNetWei)
    })
  })

  describe('Solana Family Adapter & Coin Selection', () => {
    let pool: ChainUtxoPool
    let solanaKp1: Keypair
    let solanaKp2: Keypair
    let solanaKp3: Keypair

    beforeAll(async () => {
      solanaKp1 = await Keypair.fromSeed(new Uint8Array(32).fill(1))
      solanaKp2 = await Keypair.fromSeed(new Uint8Array(32).fill(2))
      solanaKp3 = await Keypair.fromSeed(new Uint8Array(32).fill(3))
    })

    beforeEach(() => {
      pool = new ChainUtxoPool()
    })

    it('registers Solana accounts with attached 64-byte secret key or 32-byte seed', () => {
      const secretHex = Buffer.from(solanaKp1.secretKey).toString('hex')
      const coin = pool.solana.registerAccount({
        chain: 'solana-mainnet',
        address: solanaKp1.publicKey.toBase58(),
        privateKey: secretHex,
        balanceWei: 2_000_000_000n, // 2 SOL in lamports
        label: 'Primary Signer',
      })

      expect(coin.family).toBe('solana')
      expect(coin.status).toBe('clean')
      expect(coin.balanceWei).toBe(2_000_000_000n)
      expect(coin.address).toBe(solanaKp1.publicKey.toBase58())

      const fetched = pool.getCoin(coin.id)
      expect(fetched).toBeDefined()
      expect(fetched?.privateKey).toBe(secretHex)
    })

    it('resolves Ed25519 signer from attached secret key in O(1)', async () => {
      const secretHex = Buffer.from(solanaKp1.secretKey).toString('hex')
      const coin = pool.solana.registerAccount({
        chain: 'solana-mainnet',
        address: solanaKp1.publicKey.toBase58(),
        privateKey: secretHex,
        balanceWei: 1_000_000_000n,
      })

      const signer = await pool.solana.createSigner(coin)
      expect(signer.publicKey.toBase58()).toBe(solanaKp1.publicKey.toBase58())
    })

    it('resolves Ed25519 signer from 32-byte seed hex', async () => {
      const seedHex = Buffer.from(new Uint8Array(32).fill(2)).toString('hex')
      const coin = pool.solana.registerDerivedAccount({
        chain: 'solana-mainnet',
        address: solanaKp2.publicKey.toBase58(),
        privateKey: seedHex,
        balanceWei: 500_000_000n,
        derivationPath: "m/44'/501'/0'/0'/1'",
        index: 1,
      })

      const signer = await pool.solana.createSigner(coin)
      expect(signer.publicKey.toBase58()).toBe(solanaKp2.publicKey.toBase58())
    })

    it('resolves Ed25519 signer from base58 secret key', async () => {
      const b58 = base58Decoder.decode(solanaKp3.secretKey)
      const coin = pool.solana.registerStealthAccount({
        chain: 'solana-mainnet',
        address: solanaKp3.publicKey.toBase58(),
        privateKey: b58,
        balanceWei: 300_000_000n,
        ephemeralPubKey: 'ephem123',
      })

      const signer = await pool.solana.createSigner(coin)
      expect(signer.publicKey.toBase58()).toBe(solanaKp3.publicKey.toBase58())
    })

    it('performs Solana coin selection covering lamports target and fee reserve', () => {
      pool.solana.registerAccount({
        chain: 'solana',
        address: solanaKp1.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp1.secretKey).toString('hex'),
        balanceWei: 100_000_000n, // 0.1 SOL
      })
      pool.solana.registerDerivedAccount({
        chain: 'solana',
        address: solanaKp2.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp2.secretKey).toString('hex'),
        balanceWei: 500_000_000n, // 0.5 SOL
        index: 1,
      })
      pool.solana.registerDerivedAccount({
        chain: 'solana',
        address: solanaKp3.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp3.secretKey).toString('hex'),
        balanceWei: 1_000_000_000n, // 1.0 SOL
        index: 2,
      })

      // Need 400,000,000 lamports + 5,000 fee = 400,005,000 lamports.
      // Smallest single coin covering is solanaKp2 (500,000,000).
      const res = pool.selectCoins({
        chain: 'solana',
        targetAmountWei: 400_000_000n,
        feeReserveWei: 5_000n,
      })
      expect(res.selected).toHaveLength(1)
      expect(res.selected[0].address).toBe(solanaKp2.publicKey.toBase58())
      expect(res.totalSelectedWei).toBe(500_000_000n)
      expect(res.changeWei).toBe(99_995_000n)
    })

    it('integrates with SolanaWallet handle to access pool and register coins', () => {
      const mockConn: any = {
        getGenesisHash: jest.fn().mockResolvedValue('solana-genesis-hash'),
        getSignatureStatus: jest.fn().mockResolvedValue({ value: { confirmationStatus: 'confirmed', err: null } }),
        getBalance: jest.fn().mockResolvedValue(1_000_000_000n),
        getLatestBlockhash: jest.fn().mockResolvedValue({ blockhash: 'bh1', lastValidBlockHeight: 100 }),
      }

      const wallet = new SolanaWallet({
        connection: mockConn,
        signer: solanaKp1,
        chainIdentifier: 'solana-mainnet',
        networkId: 'solana-mainnet',
        genesisHash: 'solana-genesis-hash',
        chainUtxoPool: pool,
      })

      expect(wallet.chainUtxoPool).toBe(pool)
      expect(wallet.getChainUtxoPool()).toBe(pool)

      // Register primary signer through wallet handle
      const registered = wallet.registerInUtxoPool(undefined, 1_000_000_000n)
      expect(registered.address).toBe(solanaKp1.publicKey.toBase58())
      expect(registered.balanceWei).toBe(1_000_000_000n)
      expect(pool.getCleanCoins('solana-mainnet')).toHaveLength(1)

      // Register stealth payment through wallet handle
      const stealthCoin = wallet.registerStealthInUtxoPool({
        address: solanaKp2.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp2.secretKey).toString('hex'),
        balanceWei: 50_000_000n,
        ephemeralPubKey: 'ephemPubKey1',
      })
      expect(stealthCoin.origin).toBe('stealth')
      expect(pool.getCleanCoins('solana-mainnet')).toHaveLength(2)
    })

    it('builds an atomic multi-input Solana transfer transaction from multiple sub-accounts', async () => {
      const recipient = await Keypair.generate()
      const change = await Keypair.generate()

      const coin1 = pool.solana.registerAccount({
        chain: 'solana',
        address: solanaKp1.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp1.secretKey).toString('hex'),
        balanceWei: 300_000_000n, // 0.3 SOL
      })
      const coin2 = pool.solana.registerDerivedAccount({
        chain: 'solana',
        address: solanaKp2.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp2.secretKey).toString('hex'),
        balanceWei: 400_000_000n, // 0.4 SOL
      })

      // Target 600,000,000 lamports (0.6 SOL) + 5,000 fee
      const result = await pool.solana.buildMultiInputTransfer({
        inputs: [coin1, coin2],
        recipientAddress: recipient.publicKey.toBase58(),
        targetAmountLamports: 600_000_000n,
        changeAddress: change.publicKey.toBase58(),
        recentBlockhash: 'GfJc19J8P8v92jLK23V2GBjuAEGB1111111111111111',
      })

      expect(result.signers).toHaveLength(2)
      expect(result.transaction.instructions.length).toBeGreaterThanOrEqual(2)
      expect(result.changeLamports).toBe(700_000_000n - 600_005_000n)
      expect(result.transaction.signatures).toHaveLength(2)
    })
  })

  describe('UTXO Family Adapter (eCash / XEC, Bitcoin) & Outpoint Tracking', () => {
    let pool: ChainUtxoPool

    beforeEach(() => {
      pool = new ChainUtxoPool()
    })

    it('registers native UTXO outpoints with txid and vout', () => {
      const coin = pool.utxo.registerOutpoint({
        chain: 'xec-mainnet',
        address: 'ecash:qz2708636sn2st080sfs53q9fa2z6q5925d40gv4e5',
        privateKey: '0x' + 'aa'.repeat(32),
        txid: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        vout: 0,
        balanceWei: 50_000n, // 50,000 satoshis
      })

      expect(coin.family).toBe('utxo')
      expect(coin.origin).toBe('utxo')
      expect(coin.status).toBe('clean')
      expect(coin.outpoint).toEqual({
        txid: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        vout: 0,
      })
      expect(coin.balanceWei).toBe(50_000n)

      const fetched = pool.utxo.getOutpoint(
        '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        0,
        'xec-mainnet',
      )
      expect(fetched).toBeDefined()
      expect(fetched?.id).toBe(coin.id)
    })

    it('tracks spent outpoints and marks them spent across the pool', () => {
      const txid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const coin1 = pool.utxo.registerOutpoint({
        chain: 'ecash',
        address: 'ecash:qz2708636sn2st080sfs53q9fa2z6q5925d40gv4e5',
        privateKey: '0x' + 'bb'.repeat(32),
        txid,
        vout: 0,
        balanceWei: 100_000n,
      })
      const coin2 = pool.utxo.registerOutpoint({
        chain: 'ecash',
        address: 'ecash:qz2708636sn2st080sfs53q9fa2z6q5925d40gv4e5',
        privateKey: '0x' + 'bb'.repeat(32),
        txid,
        vout: 1,
        balanceWei: 200_000n,
      })

      expect(pool.getCleanCoins('ecash')).toHaveLength(2)

      // Mark outpoint 0 spent
      const spent = pool.utxo.markOutpointSpent(txid, 0, 'ecash')
      expect(spent).toBeDefined()
      expect(spent?.status).toBe('spent')
      expect(spent?.balanceWei).toBe(0n)

      // Verify outpoint 0 is recognized as spent and removed from clean inventory
      expect(pool.utxo.isOutpointSpent(txid, 0, 'ecash')).toBe(true)
      expect(pool.utxo.isOutpointSpent(txid, 1, 'ecash')).toBe(false)
      expect(pool.getCleanCoins('ecash')).toHaveLength(1)
      expect(pool.getCleanCoins('ecash')[0].id).toBe(coin2.id)

      // Track batch spent outpoints
      pool.utxo.trackSpentOutpoints([{ txid, vout: 1 }], 'ecash')
      expect(pool.utxo.isOutpointSpent(txid, 1, 'ecash')).toBe(true)
      expect(pool.getCleanCoins('ecash')).toHaveLength(0)

      // Re-registering spent outpoint immediately marks it spent
      const reRegistered = pool.utxo.registerOutpoint({
        chain: 'ecash',
        address: 'ecash:qz2708636sn2st080sfs53q9fa2z6q5925d40gv4e5',
        privateKey: '0x' + 'bb'.repeat(32),
        txid,
        vout: 0,
        balanceWei: 100_000n,
      })
      expect(reRegistered.status).toBe('spent')
      expect(reRegistered.balanceWei).toBe(0n)
    })

    it('selects UTXO outpoints greedily when no single outpoint covers target', () => {
      pool.utxo.registerOutpoint({
        chain: 'ecash',
        address: 'ecash:qz2708',
        privateKey: '0x' + '11'.repeat(32),
        txid: 'tx1',
        vout: 0,
        balanceWei: 10_000n,
      })
      pool.utxo.registerOutpoint({
        chain: 'ecash',
        address: 'ecash:qz2708',
        privateKey: '0x' + '11'.repeat(32),
        txid: 'tx2',
        vout: 0,
        balanceWei: 30_000n,
      })
      pool.utxo.registerOutpoint({
        chain: 'ecash',
        address: 'ecash:qz2708',
        privateKey: '0x' + '11'.repeat(32),
        txid: 'tx3',
        vout: 0,
        balanceWei: 50_000n,
      })

      // Target: 65,000 satoshis + 500 fee = 65,500 satoshis.
      // Greedy combines 50,000 + 30,000 = 80,000 satoshis.
      const res = pool.selectCoins({
        chain: 'ecash',
        targetAmountWei: 65_000n,
        feeReserveWei: 500n,
      })

      expect(res.selected).toHaveLength(2)
      expect(res.totalSelectedWei).toBe(80_000n)
      expect(res.changeWei).toBe(14_500n)
    })

    it('integrates with UtxoIndexer via syncIndexerUtxosToPool', async () => {
      const mockUtxos: UtxoItem[] = [
        { txId: 'chronikTx1', outputIndex: 0, satoshis: 15_000n },
        { txId: 'chronikTx1', outputIndex: 1, satoshis: 45_000n },
      ]

      const mockIndexer: UtxoIndexer = {
        chainId: 'xec-mainnet',
        fetchUtxos: jest.fn().mockResolvedValue(mockUtxos),
        fetchBalance: jest.fn().mockResolvedValue({ confirmed: 60_000n, unconfirmed: 0n }),
        broadcastTx: jest.fn().mockResolvedValue('txid_mock'),
        subscribe: jest.fn().mockResolvedValue(() => {}),
        close: jest.fn().mockResolvedValue(undefined),
      }

      const synced = await syncIndexerUtxosToPool({
        indexer: mockIndexer,
        address: 'ecash:qz2708636sn2st080sfs53q9fa2z6q5925d40gv4e5',
        privateKey: '0x' + 'cc'.repeat(32),
        pool,
      })

      expect(synced).toHaveLength(2)
      expect(synced[0].outpoint?.txid).toBe('chronikTx1')
      expect(synced[0].outpoint?.vout).toBe(0)
      expect(synced[1].outpoint?.txid).toBe('chronikTx1')
      expect(synced[1].outpoint?.vout).toBe(1)
      expect(pool.getTotalBalance('xec-mainnet')).toBe(60_000n)
    })
  })

  describe('Zero Network Calls & Sub-Millisecond Benchmark (Thousands of Coins)', () => {
    let benchmarkPool: ChainUtxoPool

    beforeAll(() => {
      benchmarkPool = new ChainUtxoPool()

      // 1. Populate 1,000 EVM sub-accounts
      for (let i = 0; i < 1_000; i++) {
        benchmarkPool.registerSubAccount({
          chain: 'monad',
          address: `0x${i.toString(16).padStart(40, '0')}`,
          privateKey: `0x${i.toString(16).padStart(64, '0')}`,
          balanceWei: BigInt(1_000 + i * 50),
          index: i,
        })
      }

      // 2. Populate 1,000 Solana accounts
      for (let i = 0; i < 1_000; i++) {
        benchmarkPool.solana.registerAccount({
          chain: 'solana',
          address: `SolAddr${i.toString().padStart(36, '0')}`,
          privateKey: `0x${i.toString(16).padStart(64, '0')}`,
          balanceWei: BigInt(10_000 + i * 100),
          label: `Solana Coin ${i}`,
        })
      }

      // 3. Populate 1,000 UTXO native outpoints
      for (let i = 0; i < 1_000; i++) {
        benchmarkPool.utxo.registerOutpoint({
          chain: 'ecash',
          address: `ecash:qp${i.toString().padStart(36, '0')}`,
          privateKey: `0x${i.toString(16).padStart(64, '0')}`,
          txid: `txid${i.toString(16).padStart(60, '0')}`,
          vout: i % 4,
          balanceWei: BigInt(500 + i * 20),
        })
      }
    })

    it('contains 3,000 coins in inventory across chain families', () => {
      expect(benchmarkPool.getAllCoins()).toHaveLength(3_000)
      expect(benchmarkPool.getCleanCoins('monad')).toHaveLength(1_000)
      expect(benchmarkPool.getCleanCoins('solana')).toHaveLength(1_000)
      expect(benchmarkPool.getCleanCoins('ecash')).toHaveLength(1_000)
    })

    it('performs EVM coin selection in sub-millisecond time with zero network calls', () => {
      const start = performance.now()
      const result = benchmarkPool.selectCoins({
        chain: 'monad',
        targetAmountWei: 30_000n,
        feeReserveWei: 1_000n,
      })
      const durationMs = performance.now() - start

      expect(result.selected.length).toBeGreaterThan(0)
      expect(result.totalSelectedWei).toBeGreaterThanOrEqual(31_000n)
      expect(durationMs).toBeLessThan(5) // Sub-millisecond target in modern engines, with generous CI headroom
    })

    it('performs Solana coin selection in sub-millisecond time', () => {
      const start = performance.now()
      const result = benchmarkPool.selectCoins({
        chain: 'solana',
        targetAmountWei: 50_000n,
        feeReserveWei: 5_000n,
      })
      const durationMs = performance.now() - start

      expect(result.selected.length).toBeGreaterThan(0)
      expect(result.totalSelectedWei).toBeGreaterThanOrEqual(55_000n)
      expect(durationMs).toBeLessThan(5)
    })

    it('performs UTXO outpoint coin selection in sub-millisecond time', () => {
      const start = performance.now()
      const result = benchmarkPool.selectCoins({
        chain: 'ecash',
        targetAmountWei: 10_000n,
        feeReserveWei: 500n,
      })
      const durationMs = performance.now() - start

      expect(result.selected.length).toBeGreaterThan(0)
      expect(result.totalSelectedWei).toBeGreaterThanOrEqual(10_500n)
      expect(durationMs).toBeLessThan(5)
    })
  })

  describe('ChainUtxoView Transactional Overlay & Chaining', () => {
    let pool: ChainUtxoPool
    const walletA = Wallet.createRandom()
    const walletChange1 = Wallet.createRandom()
    const walletChange2 = Wallet.createRandom()

    beforeEach(() => {
      pool = new ChainUtxoPool()
      // Initial state: 1 UTXO of 100,000 satoshis on eCash
      pool.utxo.registerOutpoint({
        chain: 'ecash',
        address: 'ecash:qzparent123',
        privateKey: walletA.privateKey,
        txid: 'tx_parent_001',
        vout: 0,
        balanceWei: 100_000n,
      })
    })

    it('allows chaining child transactions off unconfirmed change outputs in a view', () => {
      const view = pool.createView()

      // Tx 1: Spend 40,000 + 500 fee from parent -> creates 59,500 change
      const sel1 = view.selectCoins({
        chain: 'ecash',
        targetAmountWei: 40_000n,
        feeReserveWei: 500n,
      })
      expect(sel1.selected.length).toBe(1)
      expect(sel1.selected[0].balanceWei).toBe(100_000n)

      // Apply Tx 1 in the view
      view.applyTransaction({
        chain: 'ecash',
        inputs: sel1.selected,
        changeOutputs: [
          {
            address: 'ecash:qzchange1',
            privateKey: walletChange1.privateKey,
            balanceWei: 59_500n,
            outpoint: { txid: 'tx_child_001', vout: 1 },
            family: 'utxo',
          },
        ],
      })

      // The original parent UTXO is now marked spent in this view
      expect(view.isSpentInView(sel1.selected[0].id)).toBe(true)

      // Tx 2: Wants to spend 30,000 + 500 fee
      // Even though base pool only has the parent (which is spent in view),
      // the view can select the staged change output from Tx 1!
      const sel2 = view.selectCoins({
        chain: 'ecash',
        targetAmountWei: 30_000n,
        feeReserveWei: 500n,
      })
      expect(sel2.selected.length).toBe(1)
      expect(sel2.selected[0].address).toBe('ecash:qzchange1')
      expect(sel2.selected[0].balanceWei).toBe(59_500n)
      expect(sel2.selected[0].outpoint?.txid).toBe('tx_child_001')

      // Apply Tx 2 in the view
      view.applyTransaction({
        chain: 'ecash',
        inputs: sel2.selected,
        changeOutputs: [
          {
            address: 'ecash:qzchange2',
            privateKey: walletChange2.privateKey,
            balanceWei: 29_000n,
            outpoint: { txid: 'tx_child_002', vout: 1 },
            family: 'utxo',
          },
        ],
      })

      // Base pool is completely untouched prior to commit
      expect(pool.getCleanCoins('ecash').length).toBe(1)
      expect(pool.getCleanCoins('ecash')[0].balanceWei).toBe(100_000n)

      // Commit the view
      view.commit()

      // After commit, parent is pending in base pool, and the staged coins are registered
      expect(pool.getPendingCoins('ecash').length).toBe(1)
      expect(pool.getCleanCoins('ecash').length).toBe(1)
      expect(pool.getCleanCoins('ecash')[0].balanceWei).toBe(29_000n)
      expect(pool.getCleanCoins('ecash')[0].outpoint?.txid).toBe('tx_child_002')
    })

    it('stages sequential EVM account nonce and balance updates in a view', () => {
      const evmPool = new ChainUtxoPool()
      const evmWallet = Wallet.createRandom()
      evmPool.evm.registerSubAccount({
        chain: 'monad',
        address: evmWallet.address,
        privateKey: evmWallet.privateKey,
        balanceWei: 50_000_000n,
      })

      const view = evmPool.createView()

      // Tx 1: Spends 20,000,000 + 21,000 fee
      const sel1 = view.selectCoins({
        chain: 'monad',
        targetAmountWei: 20_000_000n,
        feeReserveWei: 21_000n,
      })
      expect(sel1.selected[0].nonce).toBe(0)

      view.applyTransaction({
        chain: 'monad',
        inputs: sel1.selected,
        updatedAccounts: [
          {
            id: sel1.selected[0].id,
            remainingBalanceWei: 29_979_000n,
            nextNonce: 1,
          },
        ],
      })

      // Tx 2: Chained spend from the same account with incremented nonce
      const sel2 = view.selectCoins({
        chain: 'monad',
        targetAmountWei: 10_000_000n,
        feeReserveWei: 21_000n,
      })
      expect(sel2.selected.length).toBe(1)
      expect(sel2.selected[0].nonce).toBe(1)
      expect(sel2.selected[0].balanceWei).toBe(29_979_000n)

      // Rollback discards all changes cleanly
      view.rollback()
      expect(view.getCleanCoins('monad')[0].nonce).toBe(0)
      expect(view.getCleanCoins('monad')[0].balanceWei).toBe(50_000_000n)
    })

    it('distinguishes between mempool-chainable coins and coins requiring on-chain confirmation', () => {
      const view = pool.createView()
      const childWallet = Wallet.createRandom()

      // Tx 1 on Monad: Funds a brand new ephemeral child account
      view.applyTransaction({
        chain: 'monad',
        inputs: [],
        changeOutputs: [
          {
            address: childWallet.address,
            privateKey: childWallet.privateKey,
            balanceWei: 10_000_000n,
            family: 'evm',
            parentTxHash: '0xparent123',
          },
        ],
      })

      // The newly funded EVM child account has requiresConfirmation = true
      const stagedChild = view.getCoin(
        makeUtxoId('monad', childWallet.address, 0, 'evm'),
      )
      expect(stagedChild?.requiresConfirmation).toBe(true)
      expect(stagedChild?.parentTxHash).toBe('0xparent123')

      // By default, selectCoins excludes coins that require on-chain confirmation
      expect(() => {
        view.selectCoins({
          chain: 'monad',
          targetAmountWei: 5_000_000n,
          allowUnconfirmedDependencies: false,
        })
      }).toThrow(/Insufficient funds/i)

      // When explicitly allowed (e.g. for pipeline orchestration with confirmation wait):
      const sel = view.selectCoins({
        chain: 'monad',
        targetAmountWei: 5_000_000n,
        allowUnconfirmedDependencies: true,
      })
      expect(sel.selected.length).toBe(1)
      expect(sel.selected[0].address).toBe(childWallet.address)
      expect(sel.selected[0].requiresConfirmation).toBe(true)
    })
  })
})

