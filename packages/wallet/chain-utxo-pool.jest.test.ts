import { Wallet } from 'ethers'
import { Keypair } from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'
import {
  ChainUtxoPool,
  ChainUtxoCoin,
  ArchiveSpentCoinsParams,
  makeUtxoId,
  inferChainFamily,
  normalizeUtxoAddress,
  formatUtxoAddress,
  MAX_UNCONFIRMED_MEMPOOL_ANCESTORS,
} from './chain-utxo-pool'
import { orderOfMagnitude2 } from './monad-change-distribution'
import { SolanaWallet } from './solana-wallet'
import { EcashWallet } from './ecash-wallet'

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
      expect(inferChainFamily('lotus')).toBe('utxo')
      expect(inferChainFamily('lotus-mainnet')).toBe('utxo')
      expect(inferChainFamily('xpi')).toBe('utxo')
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

      const lotusAddr = 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi'
      expect(normalizeUtxoAddress(lotusAddr, 'lotus')).toBe(lotusAddr)
      expect(formatUtxoAddress(lotusAddr, 'lotus')).toBe(lotusAddr)
    })

    it('formats canonical UTXO id for account and native UTXO', () => {
      const evmId = makeUtxoId('monad', '0x1111111111111111111111111111111111111111', 0, 'evm')
      expect(evmId).toBe('monad:evm:0x1111111111111111111111111111111111111111:0')

      const solanaId = makeUtxoId('solana', 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', 0, 'solana')
      expect(solanaId).toBe('solana:solana:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB:0')

      const utxoId = makeUtxoId('ecash', 'ecash:qztest', { txid: 'abc1234', vout: 1 }, 'utxo')
      expect(utxoId).toBe('ecash:utxo:ecash:qztest:abc1234:1')

      const lotusId = makeUtxoId('lotus', 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi', { txid: 'tx_lotus_1', vout: 0 }, 'utxo')
      expect(lotusId).toBe('lotus:utxo:lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi:tx_lotus_1:0')
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

    // Moved from the deleted alias-pool suite (the alias module is gone; the behaviour is
    // ChainUtxoPool's own). Replaces the test of the removed atomic-selection helper, which
    // had no caller outside this suite.
    it('immediately marks a spent coin as pending and keeps it out of selection', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 100_000n,
      })

      expect(pool.getCleanUtxos('monad')).toHaveLength(1)

      const pending = pool.markPending(utxo.id)
      expect(pending.status).toBe('pending')

      expect(pool.getCleanUtxos('monad')).toHaveLength(0)
      expect(pool.getPendingUtxos('monad')).toHaveLength(1)

      expect(() => {
        pool.selectCoins({ chain: 'monad', targetAmountWei: 50_000n })
      }).toThrow(/Insufficient funds/)
    })

    it('rolls back pending status to clean if broadcast fails', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 100_000n,
      })

      pool.markPending(utxo.id)
      expect(pool.getCleanUtxos('monad')).toHaveLength(0)

      pool.releasePending(utxo.id)
      expect(pool.getCleanUtxos('monad')).toHaveLength(1)
      expect(pool.getPendingUtxos('monad')).toHaveLength(0)
    })

    it('permanently marks a confirmed spend as spent and advances the nonce', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 100_000n,
      })

      pool.markPending(utxo.id)
      const spent = pool.markSpent(utxo.id, 1)

      expect(spent.status).toBe('spent')
      expect(spent.nonce).toBe(1)
      expect(spent.balanceWei).toBe(0n)

      expect(pool.getCleanUtxos('monad')).toHaveLength(0)
      expect(pool.getPendingUtxos('monad')).toHaveLength(0)
    })

    it('identifies dirty coins with nonce > 0 and remaining balance', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 500_000n,
      })

      pool.updateBalanceAndNonce({
        id: utxo.id,
        balanceWei: 350_000n,
        nonce: 1,
      })

      const dirty = pool.getDirtyUtxos('monad')
      expect(dirty).toHaveLength(1)
      expect(dirty[0].address.toLowerCase()).toBe(wallet1.address.toLowerCase())
      expect(dirty[0].nonce).toBe(1)
    })

    it('generates a sweep plan for a dirty coin that conserves the sweepable balance', () => {
      const utxo = pool.registerSubAccount({
        chain: 'monad',
        address: wallet1.address,
        privateKey: wallet1.privateKey,
        balanceWei: 1_000_000n,
      })

      pool.updateBalanceAndNonce({
        id: utxo.id,
        balanceWei: 800_000n,
        nonce: 2,
      })

      const plan = pool.createSweepPlan({
        chain: 'monad',
        dirtyUtxoId: utxo.id,
        changeAddresses: [wallet2.address, wallet3.address],
        minFeeWei: 21_000n,
      })

      expect(plan.dirtyUtxo.id).toBe(utxo.id)
      expect(plan.totalSweepableWei).toBe(800_000n - 21_000n)
      expect(plan.changeOutputs.length).toBeGreaterThanOrEqual(1)
      const totalPlanned = plan.changeOutputs.reduce(
        (sum, o) => sum + o.amountWei,
        0n,
      )
      expect(totalPlanned).toBe(plan.totalSweepableWei)
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
describe('Two-Tier Storage Archiving (archiveSpentCoins & getArchivedCoins)', () => {
    let archivePool: ChainUtxoPool
    const walletA = Wallet.createRandom()
    const walletB = Wallet.createRandom()
    const walletC = Wallet.createRandom()
    const walletD = Wallet.createRandom()

    beforeEach(() => {
      archivePool = new ChainUtxoPool()
    })

    it('moves fully drained ($0 wei) and spent coins older than maxAgeMs into archivedCoinsById', () => {
      const twoHoursAgo = Date.now() - 7_200_000
      const fiveMinutesAgo = Date.now() - 300_000

      // 1. Clean active coin with balance
      const cleanCoin = archivePool.evm.registerSubAccount({
        chain: 'monad',
        address: walletA.address,
        privateKey: walletA.privateKey,
        balanceWei: 100_000n,
      })

      // 2. Fully drained spent coin older than 1 hour (eligible for archive)
      const oldSpentCoin = archivePool.evm.registerSubAccount({
        chain: 'monad',
        address: walletB.address,
        privateKey: walletB.privateKey,
        balanceWei: 10_000n,
      })
      archivePool.markSpent(oldSpentCoin.id)
      oldSpentCoin.lastUpdatedMs = twoHoursAgo

      // 3. Fully drained spent coin recent (< 1 hour, not yet eligible by default)
      const recentSpentCoin = archivePool.evm.registerSubAccount({
        chain: 'monad',
        address: walletC.address,
        privateKey: walletC.privateKey,
        balanceWei: 20_000n,
      })
      archivePool.markSpent(recentSpentCoin.id)
      recentSpentCoin.lastUpdatedMs = fiveMinutesAgo

      // 4. Dirty spent account with positive balance remaining (not drained, should NOT archive)
      const positiveBalanceSpentCoin = archivePool.evm.importPrivateKey({
        chain: 'monad',
        address: walletD.address,
        privateKey: walletD.privateKey,
        balanceWei: 50_000n,
        nonce: 1, // status: 'spent'
      })

      expect(archivePool.getAllCoins('monad')).toHaveLength(4)
      expect(archivePool.getArchivedCoins('monad')).toHaveLength(0)

      // Run default archiveSpentCoins (default maxAgeMs: 1 hour)
      const archived = archivePool.archiveSpentCoins()

      expect(archived).toHaveLength(1)
      expect(archived[0].id).toBe(oldSpentCoin.id)

      // Active pool size is reduced from 4 to 3
      const activeCoins = archivePool.getAllCoins('monad')
      expect(activeCoins).toHaveLength(3)
      const activeIds = activeCoins.map(c => c.id)
      expect(activeIds).toContain(cleanCoin.id)
      expect(activeIds).toContain(recentSpentCoin.id)
      expect(activeIds).toContain(positiveBalanceSpentCoin.id)
      expect(activeIds).not.toContain(oldSpentCoin.id)

      // Active lookup returns undefined
      expect(archivePool.getCoin(oldSpentCoin.id)).toBeUndefined()
      // Querying with includeArchived returns it
      expect(archivePool.getCoin(oldSpentCoin.id, { includeArchived: true })).toBeDefined()

      // Querying cold archive preserves full queryability
      const coldArchive = archivePool.getArchivedCoins('monad')
      expect(coldArchive).toHaveLength(1)
      expect(coldArchive[0].id).toBe(oldSpentCoin.id)
      expect(archivePool.getArchivedCoin(oldSpentCoin.id)).toBeDefined()
      expect(archivePool.getArchivedCoin(oldSpentCoin.id)?.address.toLowerCase()).toBe(walletB.address.toLowerCase())
    })

    it('supports custom maxAgeMs override such as 0 to archive all drained spent coins immediately', () => {
      const coin = archivePool.evm.registerSubAccount({
        chain: 'monad',
        address: walletA.address,
        privateKey: walletA.privateKey,
        balanceWei: 50_000n,
      })
      archivePool.markSpent(coin.id)
      // coin was just marked spent (0ms ago)

      expect(archivePool.getAllCoins('monad')).toHaveLength(1)
      expect(archivePool.getArchivedCoins('monad')).toHaveLength(0)

      // With maxAgeMs = 0, immediately archives
      const archived = archivePool.archiveSpentCoins({ maxAgeMs: 0 })
      expect(archived).toHaveLength(1)
      expect(archived[0].id).toBe(coin.id)

      expect(archivePool.getAllCoins('monad')).toHaveLength(0)
      expect(archivePool.getArchivedCoins('monad')).toHaveLength(1)
    })

    it('scopes cold storage archiving by chain parameter', () => {
      const monadCoin = archivePool.evm.registerSubAccount({
        chain: 'monad',
        address: walletA.address,
        privateKey: walletA.privateKey,
        balanceWei: 10_000n,
      })
      archivePool.markSpent(monadCoin.id)

      const solanaCoin = archivePool.solana.registerAccount({
        chain: 'solana',
        address: 'SolAddr111111111111111111111111111111111111',
        privateKey: '0x' + '11'.repeat(32),
        balanceWei: 50_000n,
      })
      archivePool.markSpent(solanaCoin.id)

      expect(archivePool.getAllCoins()).toHaveLength(2)

      // Archive only monad coins
      const archivedMonad = archivePool.archiveSpentCoins({ chain: 'monad', maxAgeMs: 0 })
      expect(archivedMonad).toHaveLength(1)
      expect(archivedMonad[0].id).toBe(monadCoin.id)

      // Solana coin remains in active pool
      expect(archivePool.getAllCoins('monad')).toHaveLength(0)
      expect(archivePool.getAllCoins('solana')).toHaveLength(1)

      expect(archivePool.getArchivedCoins('monad')).toHaveLength(1)
      expect(archivePool.getArchivedCoins('solana')).toHaveLength(0)
      expect(archivePool.getArchivedCoins()).toHaveLength(1)

      // Archive solana coins
      const archivedSolana = archivePool.archiveSpentCoins({ chain: 'solana', maxAgeMs: 0 })
      expect(archivedSolana).toHaveLength(1)
      expect(archivePool.getAllCoins()).toHaveLength(0)
      expect(archivePool.getArchivedCoins()).toHaveLength(2)
      expect(archivePool.getArchivedCoins('solana')).toHaveLength(1)
    })

    it('removes coin from cold archive if re-registered into active pool', () => {
      const coin = archivePool.evm.registerSubAccount({
        chain: 'monad',
        address: walletA.address,
        privateKey: walletA.privateKey,
        balanceWei: 10_000n,
      })
      archivePool.markSpent(coin.id)
      archivePool.archiveSpentCoins({ maxAgeMs: 0 })

      expect(archivePool.getArchivedCoins('monad')).toHaveLength(1)
      expect(archivePool.getCoin(coin.id)).toBeUndefined()

      // Re-register into active pool
      archivePool.registerCoin({
        id: coin.id,
        chain: 'monad',
        address: walletA.address,
        privateKey: walletA.privateKey,
        balanceWei: 500_000n,
        status: 'clean',
      })

      expect(archivePool.getCoin(coin.id)).toBeDefined()
      expect(archivePool.getCoin(coin.id)?.balanceWei).toBe(500_000n)
      expect(archivePool.getArchivedCoins('monad')).toHaveLength(0)
      expect(archivePool.getArchivedCoin(coin.id)).toBeUndefined()
    })
  })
  describe('Native UTXO Mempool DAG Streaming & Ancestor Limits (Lotus & eCash, Issue #1219)', () => {
    let pool: ChainUtxoPool

    beforeEach(() => {
      pool = new ChainUtxoPool()
    })

    it('tracks DAG outpoint dependencies and dynamic ancestor counts across confirmation states', () => {
      // Register DAG dependencies: txA -> txB -> txC -> txD
      pool.utxo.registerOutpointDependency({
        parentTxHash: 'txA',
        outpoint: { txid: 'txB', vout: 0 },
        chain: 'lotus',
      })
      pool.utxo.registerOutpointDependency({
        parentTxHash: 'txB',
        outpoint: { txid: 'txC', vout: 1 },
        chain: 'lotus',
      })
      pool.utxo.registerDependency('txD', 'txC', 'lotus')

      // Outpoint dependency lookup
      const bDeps = pool.utxo.getOutpointDependencies('txB', 0, 'lotus')
      expect(bDeps).toEqual(['txa'])

      // Ancestor sets
      const cAncestors = pool.utxo.getMempoolAncestors('txC', 'lotus')
      expect(cAncestors.size).toBe(3)
      expect(cAncestors.has('txa')).toBe(true)
      expect(cAncestors.has('txb')).toBe(true)
      expect(cAncestors.has('txc')).toBe(true)

      const dAncestors = pool.utxo.getMempoolAncestors('txD', 'lotus')
      expect(dAncestors.size).toBe(4)
      expect(dAncestors.has('txa')).toBe(true)
      expect(dAncestors.has('txb')).toBe(true)
      expect(dAncestors.has('txc')).toBe(true)
      expect(dAncestors.has('txd')).toBe(true)
      expect(pool.utxo.getAncestorCount('txD', 'lotus')).toBe(4)

      // Mark txA as confirmed -> ancestors of txD become [txB, txC, txD]
      pool.utxo.markTransactionConfirmed('txA', 'lotus')
      expect(pool.utxo.isTransactionConfirmed('txA', 'lotus')).toBe(true)

      const dAncestorsAfterA = pool.utxo.getMempoolAncestors('txD', 'lotus')
      expect(dAncestorsAfterA.size).toBe(3)
      expect(dAncestorsAfterA.has('txa')).toBe(false)
      expect(dAncestorsAfterA.has('txb')).toBe(true)
      expect(dAncestorsAfterA.has('txc')).toBe(true)
      expect(dAncestorsAfterA.has('txd')).toBe(true)
      expect(pool.utxo.getAncestorCount('txD', 'lotus')).toBe(3)

      // Mark txB as confirmed -> only txC and txD remain unconfirmed
      pool.utxo.markTransactionConfirmed('txB', 'lotus')
      expect(pool.utxo.getAncestorCount('txD', 'lotus')).toBe(2)
    })
  })
})
