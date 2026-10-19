import { Transaction, TypedDataEncoder, Wallet, verifyMessage, verifyTypedData } from 'ethers'
import {
  DAPP_PERSONA_BIP44_PATH_PREFIX,
  DappPersonaKeyring,
  EIP1193_ERROR_CODES,
  Eip1193ProviderRpcError,
  FRANK_EIP6963_NAME,
  FRANK_EIP6963_RDNS,
  FrankDappBridgeRouter,
  STAMP_POOL_BIP44_PATH_PREFIX,
  assertNotIdentityOrStampPoolAddress,
  buildPersonaReturnSweepTx,
  calculateDappJitSweepRequirement,
  createExtensionOriginSyncHandshake,
  createFrankEip6963ProviderInfo,
  deriveDappPersonaKeypair,
  deriveStampPoolSubAccountAddress,
  executeDappJitSweepAndSignTx,
  normalizeDappOrigin,
} from './index'
import type { DeviceSyncBundle } from '../device-pairing'

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'

describe('dApp Bridge (#1708, #1709, #1710)', () => {
  describe('EIP-6963 provider announcement metadata (#1709)', () => {
    it('builds valid EIP-6963 provider info with mx.signet.frank rdns', () => {
      const info = createFrankEip6963ProviderInfo()
      expect(info.name).toBe(FRANK_EIP6963_NAME)
      expect(info.rdns).toBe(FRANK_EIP6963_RDNS)
      expect(info.icon.startsWith('data:image/svg+xml;utf8,')).toBe(true)
      expect(info.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    })
  })

  describe('dApp Persona EOA Keyring & Cryptographic Isolation (#1708)', () => {
    it('derives m/44\'/60\'/1\'/0/k completely disjoint from m/44\'/60\'/0\'/0/i stamp pool sub-accounts', () => {
      const stampPoolAddresses = new Set<string>()
      for (let i = 0; i < 32; i++) {
        const sub = deriveStampPoolSubAccountAddress(TEST_MNEMONIC, i)
        expect(sub.derivationPath).toBe(`${STAMP_POOL_BIP44_PATH_PREFIX}/${i}`)
        stampPoolAddresses.add(sub.address.toLowerCase())
      }

      for (let k = 0; k < 16; k++) {
        const persona = deriveDappPersonaKeypair(TEST_MNEMONIC, k)
        expect(persona.derivationPath).toBe(`${DAPP_PERSONA_BIP44_PATH_PREFIX}/${k}`)
        expect(stampPoolAddresses.has(persona.address.toLowerCase())).toBe(false)
        expect(() =>
          assertNotIdentityOrStampPoolAddress(persona.address, stampPoolAddresses),
        ).not.toThrow()
      }

      const firstStampPool = deriveStampPoolSubAccountAddress(TEST_MNEMONIC, 0)
      expect(() =>
        assertNotIdentityOrStampPoolAddress(firstStampPool.address, stampPoolAddresses),
      ).toThrow(/Security invariant violation/)
    })

    it('isolates per-origin burner personas so app.uniswap.org and opensea.io receive unlinked addresses', () => {
      const identityWallet = Wallet.createRandom()
      const keyring = new DappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MNEMONIC,
        forbiddenAddresses: [identityWallet.address],
      })

      const primary = keyring.connectOrigin('https://stake.monad.xyz', { burner: false })
      const uniswapBurner = keyring.connectOrigin('https://app.uniswap.org', {
        burner: true,
      })
      const openseaBurner = keyring.connectOrigin('https://opensea.io', {
        burner: true,
      })

      expect(primary.index).toBe(0)
      expect(uniswapBurner.index).toBe(1)
      expect(openseaBurner.index).toBe(2)

      expect(uniswapBurner.address).not.toBe(primary.address)
      expect(openseaBurner.address).not.toBe(primary.address)
      expect(uniswapBurner.address).not.toBe(openseaBurner.address)
      expect(uniswapBurner.boundOrigin).toBe('https://app.uniswap.org')
      expect(openseaBurner.boundOrigin).toBe('https://opensea.io')

      // Reconnecting the same origin returns the same bound burner persona
      const uniswapAgain = keyring.connectOrigin('https://app.uniswap.org', {
        burner: true,
      })
      expect(uniswapAgain.address).toBe(uniswapBurner.address)
      expect(uniswapAgain.index).toBe(1)

      // Identity address and stamp pool addresses are strictly rejected
      expect(() =>
        keyring.assertNotIdentityOrStampPoolAddress(identityWallet.address),
      ).toThrow(/Security invariant violation/)
      const poolSub0 = deriveStampPoolSubAccountAddress(TEST_MNEMONIC, 0)
      expect(() =>
        keyring.assertNotIdentityOrStampPoolAddress(poolSub0.address),
      ).toThrow(/Security invariant violation/)
    })
  })

  describe('Just-In-Time (JIT) Balance Consolidation & Return Sweep (#1708)', () => {
    it('skips pool sweep when persona balance already covers txValue + gasLimit * maxFeePerGas', () => {
      const calc = calculateDappJitSweepRequirement({
        personaBalanceWei: 2_000_000_000_000_000_000n, // 2 MON
        txValueWei: 1_000_000_000_000_000_000n, // 1 MON
        gasLimit: 100_000n,
        maxFeePerGasWei: 50_000_000_000n, // 50 gwei -> 0.005 MON gas
      })

      expect(calc.requiresSweep).toBe(false)
      expect(calc.shortfallWei).toBe(0n)
      expect(calc.sweepFeeOverheadWei).toBe(0n)
      expect(calc.totalPoolClaimWei).toBe(0n)
      expect(calc.requiredPersonaWei).toBe(1_005_000_000_000_000_000n)
    })

    it('calculates exact shortfallWei and sweepFeeOverheadWei when persona balance is insufficient', () => {
      const calc = calculateDappJitSweepRequirement({
        personaBalanceWei: 200_000_000_000_000_000n, // 0.2 MON
        txValueWei: 1_000_000_000_000_000_000n, // 1.0 MON
        gasLimit: 150_000n,
        maxFeePerGasWei: 10_000_000_000n, // 10 gwei -> 0.0015 MON
      })

      // required = 1.0015 MON = 1_001_500_000_000_000_000n
      // shortfall = 1.0015 - 0.2 = 0.8015 MON = 801_500_000_000_000_000n
      // sweepFeeOverhead = 21_000 * 10 gwei = 210_000_000_000_000n
      expect(calc.requiresSweep).toBe(true)
      expect(calc.requiredPersonaWei).toBe(1_001_500_000_000_000_000n)
      expect(calc.shortfallWei).toBe(801_500_000_000_000_000n)
      expect(calc.sweepFeeOverheadWei).toBe(210_000_000_000_000n)
      expect(calc.totalPoolClaimWei).toBe(801_710_000_000_000_000n)
    })

    it('executes JIT pool sweep and signs EIP-1559 transaction with the persona EOA', async () => {
      const keyring = new DappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MNEMONIC,
      })
      const burner = keyring.connectOrigin('https://app.uniswap.org', { burner: true })
      const recipient = Wallet.createRandom().address

      const sweepCalls: Array<{ shortfallWei: bigint; recipient: string }> = []
      const outcome = await executeDappJitSweepAndSignTx({
        keyring,
        personaIndex: burner.index,
        personaBalanceWei: 100_000_000_000_000_000n, // 0.1 MON
        txRequest: {
          to: recipient,
          value: 500_000_000_000_000_000n, // 0.5 MON
          data: '0x1234abcd',
          nonce: 3,
          gasLimit: 120_000n,
          maxFeePerGasWei: 20_000_000_000n, // 20 gwei
          maxPriorityFeePerGasWei: 2_000_000_000n,
          chainId: 10143n,
        },
        sweepFromPool: async (shortfallWei, recipientPersonaAddress) => {
          sweepCalls.push({ shortfallWei, recipient: recipientPersonaAddress })
          return {
            sweepTxHashes: ['0x' + 'a'.repeat(64)],
            fundedWei: shortfallWei,
          }
        },
      })

      expect(outcome.sweepExecuted).toBe(true)
      expect(outcome.sweepTxHashes).toEqual(['0x' + 'a'.repeat(64)])
      expect(sweepCalls).toHaveLength(1)
      expect(sweepCalls[0].recipient).toBe(burner.address)
      expect(sweepCalls[0].shortfallWei).toBe(402_400_000_000_000_000n)

      const parsedTx = Transaction.from(outcome.signedTxHex)
      expect(parsedTx.type).toBe(2)
      expect(parsedTx.from).toBe(burner.address)
      expect(parsedTx.to).toBe(recipient)
      expect(parsedTx.value).toBe(500_000_000_000_000_000n)
      expect(parsedTx.data).toBe('0x1234abcd')
      expect(parsedTx.chainId).toBe(10143n)
    })

    it('sweeps remaining funds from a burner persona back to the Frank pool with zero dust', async () => {
      const keyring = new DappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MNEMONIC,
      })
      const burner = keyring.connectOrigin('https://opensea.io', { burner: true })
      const poolSubAccount = deriveStampPoolSubAccountAddress(TEST_MNEMONIC, 7)

      const observedBalanceWei = 350_000_000_000_000_000n // 0.35 MON
      const maxFeePerGasWei = 10_000_000_000n // 10 gwei -> 21,000 * 10 gwei = 210,000,000,000,000 wei
      const returnSweep = await buildPersonaReturnSweepTx({
        keyring,
        personaIndex: burner.index,
        observedBalanceWei,
        destinationPoolAddress: poolSubAccount.address,
        nonce: 4,
        chainId: 10143n,
        maxFeePerGasWei,
      })

      expect(returnSweep.fromPersonaAddress).toBe(burner.address)
      expect(returnSweep.destinationPoolAddress).toBe(poolSubAccount.address)
      expect(returnSweep.feeWei).toBe(210_000_000_000_000n)
      expect(returnSweep.sweptValueWei).toBe(observedBalanceWei - returnSweep.feeWei)
      expect(returnSweep.sweptValueWei + returnSweep.feeWei).toBe(observedBalanceWei)
      expect(returnSweep.remainingDustWei).toBe(0n)

      const parsed = Transaction.from(returnSweep.signedTxHex)
      expect(parsed.from).toBe(burner.address)
      expect(parsed.to).toBe(poolSubAccount.address)
      expect(parsed.value).toBe(returnSweep.sweptValueWei)
    })
  })

  describe('EIP-1193 Request Router & Origin-Verified Approval Queue (#1709)', () => {
    it('queues eth_requestAccounts, personal_sign, eth_signTypedData_v4, eth_sendTransaction, wallet_switchEthereumChain and supports 4001 rejection', async () => {
      const keyring = new DappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MNEMONIC,
      })

      const broadcastedTxs: string[] = []
      const router = new FrankDappBridgeRouter({
        keyring,
        initialChainId: 10143n,
        defaultBurnerForNewOrigins: true,
        rpcBackend: {
          getBalanceWei: async () => 50_000_000_000_000_000n, // 0.05 MON
          getTransactionCount: async () => 1,
          estimateGas: async () => 50_000n,
          getMaxFeePerGasWei: async () => 10_000_000_000n,
          sweepFromPool: async (shortfallWei) => ({
            sweepTxHashes: ['0x' + 'b'.repeat(64)],
            fundedWei: shortfallWei,
          }),
          broadcastSignedTransaction: async (signedTxHex) => {
            broadcastedTxs.push(signedTxHex)
            return '0x' + 'c'.repeat(64)
          },
        },
      })

      const dappOrigin = 'https://app.uniswap.org'
      expect(await router.handleRequest(dappOrigin, { method: 'eth_chainId' })).toBe(
        '0x279f',
      )
      expect(await router.handleRequest(dappOrigin, { method: 'eth_accounts' })).toEqual(
        [],
      )

      // 1. eth_requestAccounts -> queued approval -> approve as burner persona
      const connectPromise = router.handleRequest(dappOrigin, {
        method: 'eth_requestAccounts',
      })
      const pending1 = router.listPendingApprovals()
      expect(pending1).toHaveLength(1)
      expect(pending1[0].kind).toBe('connect')
      expect(pending1[0].origin).toBe(dappOrigin)

      await router.approveRequest(pending1[0].id, { burner: true })
      const accounts = (await connectPromise) as string[]
      expect(accounts).toHaveLength(1)
      const connectedAddress = accounts[0]
      expect(connectedAddress).toBe(
        keyring.getConnectedPersonaForOrigin(dappOrigin)?.address,
      )

      // 2. personal_sign -> queued approval -> verify signature recovers to connected persona
      const signPromise = router.handleRequest(dappOrigin, {
        method: 'personal_sign',
        params: ['Sign in to Uniswap on Monad', connectedAddress],
      })
      const pendingSign = router.listPendingApprovals()
      expect(pendingSign).toHaveLength(1)
      expect(pendingSign[0].kind).toBe('personal_sign')
      await router.approveRequest(pendingSign[0].id)
      const signature = (await signPromise) as string
      expect(verifyMessage('Sign in to Uniswap on Monad', signature)).toBe(
        connectedAddress,
      )

      // 3. eth_signTypedData_v4 -> queued approval -> verify EIP-712 signature
      const domain = {
        name: 'Permit2',
        version: '1',
        chainId: 10143,
        verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      }
      const types = {
        PermitSingle: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
      }
      const message = {
        spender: '0x1111111111111111111111111111111111111111',
        amount: '1000000',
      }
      const typedPromise = router.handleRequest(dappOrigin, {
        method: 'eth_signTypedData_v4',
        params: [connectedAddress, JSON.stringify({ domain, types, message })],
      })
      const pendingTyped = router.listPendingApprovals()
      expect(pendingTyped).toHaveLength(1)
      expect(pendingTyped[0].kind).toBe('sign_typed_data')
      await router.approveRequest(pendingTyped[0].id)
      const typedSig = (await typedPromise) as string
      expect(verifyTypedData(domain, types, message, typedSig)).toBe(connectedAddress)
      expect(TypedDataEncoder.hash(domain, types, message)).toMatch(/^0x[0-9a-f]{64}$/)

      // 4. eth_sendTransaction -> computes JIT requirement, sweeps shortfall, signs, broadcasts
      const recipient = Wallet.createRandom().address
      const txPromise = router.handleRequest(dappOrigin, {
        method: 'eth_sendTransaction',
        params: [
          {
            from: connectedAddress,
            to: recipient,
            value: '0x2c68af0bb140000', // 0.2 MON (exceeds 0.05 MON balance -> triggers JIT sweep)
            data: '0x',
          },
        ],
      })
      const pendingTx = router.listPendingApprovals()
      expect(pendingTx).toHaveLength(1)
      expect(pendingTx[0].kind).toBe('send_transaction')
      expect(pendingTx[0].jitRequirement?.requiresSweep).toBe(true)

      await router.approveRequest(pendingTx[0].id)
      const txHash = await txPromise
      expect(txHash).toBe('0x' + 'c'.repeat(64))
      expect(broadcastedTxs).toHaveLength(1)

      // 5. wallet_switchEthereumChain
      const switchPromise = router.handleRequest(dappOrigin, {
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x1' }],
      })
      const pendingSwitch = router.listPendingApprovals()
      expect(pendingSwitch).toHaveLength(1)
      expect(pendingSwitch[0].kind).toBe('switch_chain')
      await router.approveRequest(pendingSwitch[0].id)
      await switchPromise
      expect(router.getChainIdHex()).toBe('0x1')

      // 6. Rejecting a request returns EIP-1193 4001 User Rejected Request
      const rejectSignPromise = router.handleRequest(dappOrigin, {
        method: 'personal_sign',
        params: ['Malicious payload', connectedAddress],
      })
      const pendingReject = router.listPendingApprovals()
      router.rejectRequest(pendingReject[0].id, 'User declined signature')

      await expect(rejectSignPromise).rejects.toMatchObject({
        code: EIP1193_ERROR_CODES.USER_REJECTED_REQUEST,
        message: 'User declined signature',
      })
      await expect(rejectSignPromise).rejects.toBeInstanceOf(Eip1193ProviderRpcError)

      // 7. Rejects opaque/insecure origins
      expect(() => normalizeDappOrigin('null')).toThrow()
      expect(() => normalizeDappOrigin('http://evil.example.com')).toThrow()
    })
  })

  describe('PWA <-> Extension Origin Bridge (#1710)', () => {
    it('performs verified E2EE DeviceSyncBundle handshake between https://signet.mx and browser extensions', () => {
      const handshake = createExtensionOriginSyncHandshake({
        pwaOrigin: 'https://signet.mx',
        extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        nowMs: 1_760_000_000_000,
      })

      expect(handshake.pwaOrigin).toBe('https://signet.mx')
      expect(handshake.extensionOrigin).toBe(
        'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      )
      expect(handshake.sasDigits).toMatch(/^\d{6}$/)
      expect(handshake.sasWords).toHaveLength(4)
      expect(handshake.qrUri.startsWith('frank://pair?')).toBe(true)

      const sampleBundle: DeviceSyncBundle = {
        schemaVersion: 1,
        exportedAtMs: 1_760_000_000_500,
        sourceDeviceId: 'frank-pwa',
        accountAddress: '0x1111111111111111111111111111111111111111',
        mnemonicOrSeedHex: TEST_MNEMONIC,
        contacts: [
          {
            address: '0x2222222222222222222222222222222222222222',
            name: 'Alice',
            username: 'alice',
          },
        ],
        conversations: [
          {
            id: 'conv-1',
            address: '0x2222222222222222222222222222222222222222',
            name: 'Alice',
            updatedAt: 1_760_000_000_100,
          },
        ],
      }

      const encrypted = handshake.encryptFromPwa(sampleBundle)
      const decryptedInExt = handshake.decryptInExtension(encrypted)
      expect(decryptedInExt).toEqual(sampleBundle)

      const encryptedBack = handshake.encryptFromExtension(sampleBundle)
      const decryptedInPwa = handshake.decryptInPwa(encryptedBack)
      expect(decryptedInPwa).toEqual(sampleBundle)

      handshake.zeroize()
      expect(() => handshake.encryptFromPwa(sampleBundle)).toThrow(
        /zeroized encryptionKey/,
      )
    })
  })

  describe('Multi-Chain dApp Isolation & Stamp Chain Decoupling', () => {
    it('decouples Frank stampChainId from per-origin dApp chains, supports EIP-3085 wallet_addEthereumChain, and scopes JIT pool sweeps per chain', async () => {
      const keyring = new DappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MNEMONIC,
      })
      const frankStampChainId = 0xf7a6n // Example dedicated low-fee Frank Stamp chain
      const sweepCalls: Array<{ shortfallWei: bigint; recipient: string; chainId?: bigint }> = []

      const router = new FrankDappBridgeRouter({
        keyring,
        initialChainId: 10143n, // Monad default
        stampChainId: frankStampChainId,
        supportedChainIds: [10143n, 1n, 42161n, 137n, frankStampChainId],
        poolEnabledChainIds: [10143n, frankStampChainId],
        rpcBackend: {
          getBalanceWei: async (_addr, chainId) => {
            // Persona has 0 balance on Monad (triggers JIT pool sweep), 1 ETH on Arbitrum
            return chainId === 10143n ? 0n : 1_000_000_000_000_000_000n
          },
          getTransactionCount: async () => 0,
          estimateGas: async () => 21_000n,
          getMaxFeePerGasWei: async () => 1_000_000_000n,
          sweepFromPool: async (shortfallWei, recipient, chainId) => {
            sweepCalls.push({ shortfallWei, recipient, chainId })
            return {
              sweepTxHashes: ['0x' + 'c'.repeat(64)],
              fundedWei: shortfallWei,
            }
          },
        },
      })

      // 1. Frank's internal stamp chain is tracked independently of dApp origins
      expect(router.getStampChainId()).toBe(frankStampChainId)
      expect(router.getStampChainIdHex()).toBe('0xf7a6')

      const uniswapOrigin = 'https://app.uniswap.org'
      const polymarketOrigin = 'https://polymarket.com'

      // Connect both dApps (each gets its own isolated burner persona EOA)
      const p1 = router.handleRequest(uniswapOrigin, { method: 'eth_requestAccounts' })
      await router.approveRequest(router.listPendingApprovals()[0].id, { burner: true })
      const [uniswapAddr] = (await p1) as string[]

      const p2 = router.handleRequest(polymarketOrigin, { method: 'eth_requestAccounts' })
      await router.approveRequest(router.listPendingApprovals()[0].id, { burner: true })
      const [polymarketAddr] = (await p2) as string[]
      expect(uniswapAddr).not.toBe(polymarketAddr)

      // 2. Switch Uniswap to Arbitrum (0xa4b1 = 42161) and Polymarket to Polygon (0x89 = 137)
      const switchUni = router.handleRequest(uniswapOrigin, {
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xa4b1' }],
      })
      await router.approveRequest(router.listPendingApprovals()[0].id)
      await switchUni

      const switchPoly = router.handleRequest(polymarketOrigin, {
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x89' }],
      })
      await router.approveRequest(router.listPendingApprovals()[0].id)
      await switchPoly

      // Verify per-origin chain isolation: both tabs operate simultaneously on different chains!
      expect(await router.handleRequest(uniswapOrigin, { method: 'eth_chainId' })).toBe('0xa4b1')
      expect(await router.handleRequest(polymarketOrigin, { method: 'eth_chainId' })).toBe('0x89')
      // And Frank's stamp chain is still untouched:
      expect(router.getStampChainIdHex()).toBe('0xf7a6')

      // 3. EIP-3085 wallet_addEthereumChain adds a custom L2/AppChain and switches that origin to it
      const customOrigin = 'https://dex.custom-rollup.xyz'
      const addChainPromise = router.handleRequest(customOrigin, {
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: '0x12345',
            chainName: 'Custom Rollup Mainnet',
            nativeCurrency: { name: 'Rollup Gas', symbol: 'RGAS', decimals: 18 },
            rpcUrls: ['https://rpc.custom-rollup.xyz'],
          },
        ],
      })
      const pendingAdd = router.listPendingApprovals()
      expect(pendingAdd).toHaveLength(1)
      expect(pendingAdd[0].kind).toBe('add_chain')
      await router.approveRequest(pendingAdd[0].id)
      await addChainPromise

      expect(await router.handleRequest(customOrigin, { method: 'eth_chainId' })).toBe('0x12345')
      expect(router.getCustomChain(0x12345n)?.chainName).toBe('Custom Rollup Mainnet')
      // Uniswap is still on Arbitrum!
      expect(await router.handleRequest(uniswapOrigin, { method: 'eth_chainId' })).toBe('0xa4b1')

      // 4. JIT pool sweep is chain-scoped: Monad (10143n) is in poolEnabledChainIds, so a shortfall sweeps on 10143n
      const monadDapp = 'https://nad.fun'
      const pMonad = router.handleRequest(monadDapp, { method: 'eth_requestAccounts' })
      await router.approveRequest(router.listPendingApprovals()[0].id)
      const [monadPersonaAddr] = (await pMonad) as string[]

      const txMonadPromise = router.handleRequest(monadDapp, {
        method: 'eth_sendTransaction',
        params: [
          {
            from: monadPersonaAddr,
            to: '0x3333333333333333333333333333333333333333',
            value: '0xde0b6b3a7640000', // 1 MON
          },
        ],
      })
      await router.approveRequest(router.listPendingApprovals()[0].id)
      await txMonadPromise
      expect(sweepCalls).toHaveLength(1)
      expect(sweepCalls[0].chainId).toBe(10143n)
    })

    it('reports virtual aggregated pool balance to connected dApps (eth_getBalance, Multicall3 eth_call, and stateOverrides) with default 10 AVU per-origin privacy mask while sweeping real shortfall on send', async () => {
      const keyring = new DappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MNEMONIC,
      })
      const poolBalanceWei = 100_000_000_000_000_000_000n // 100 AVU / MON across sub-account pool EOAs
      const observedStateOverrides: Array<Record<string, { balance: string }> | undefined> = []
      const sweepCalls: Array<{ shortfallWei: bigint; recipient: string }> = []

      const router = new FrankDappBridgeRouter({
        keyring,
        initialChainId: 10143n,
        rpcBackend: {
          getBalanceWei: async () => 0n, // Ephemeral persona EOA has 0 on-chain balance before JIT sweep
          getSpendablePoolBalanceWei: async () => poolBalanceWei,
          getTransactionCount: async () => 0,
          getMaxFeePerGasWei: async () => 1_000_000_000n,
          estimateGas: async (_tx, _chainId, stateOverride) => {
            observedStateOverrides.push(stateOverride)
            return 21_000n
          },
          sweepFromPool: async (shortfallWei, recipient) => {
            sweepCalls.push({ shortfallWei, recipient })
            return {
              sweepTxHashes: ['0x' + 'd'.repeat(64)],
              fundedWei: shortfallWei,
            }
          },
        },
      })

      const siteA = 'https://app.uniswap.org'
      const siteB = 'https://opensea.io'

      const pA = router.handleRequest(siteA, { method: 'eth_requestAccounts' })
      await router.approveRequest(router.listPendingApprovals()[0].id, { burner: true })
      const [personaA] = (await pA) as string[]

      const pB = router.handleRequest(siteB, { method: 'eth_requestAccounts' })
      await router.approveRequest(router.listPendingApprovals()[0].id, { burner: true })
      const [personaB] = (await pB) as string[]

      // 1. Both sites see a substantial spendable balance in [90 AVU, 99 AVU] even though their ephemeral EOAs hold 0 on-chain!
      const balHexA = (await router.handleRequest(siteA, {
        method: 'eth_getBalance',
        params: [personaA, 'latest'],
      })) as string
      const balHexB = (await router.handleRequest(siteB, {
        method: 'eth_getBalance',
        params: [personaB, 'latest'],
      })) as string

      const balWeiA = BigInt(balHexA)
      const balWeiB = BigInt(balHexB)

      expect(balWeiA).toBeGreaterThanOrEqual(90_000_000_000_000_000_000n)
      expect(balWeiA).toBeLessThanOrEqual(99_000_000_000_000_000_000n)
      expect(balWeiB).toBeGreaterThanOrEqual(90_000_000_000_000_000_000n)
      expect(balWeiB).toBeLessThanOrEqual(99_000_000_000_000_000_000n)
      // Even when rounded to 2 decimal places (centi-tokens), the two websites see different macro numbers!
      const centiTokensA = balWeiA / 10_000_000_000_000_000n
      const centiTokensB = balWeiB / 10_000_000_000_000_000n
      expect(centiTokensA).not.toBe(centiTokensB)

      // 2. Multicall3.getEthBalance(personaA) (0x4d2301cc) also returns the virtual balance
      const multicallData = `0x4d2301cc000000000000000000000000${personaA.slice(2).toLowerCase()}`
      const multicallRes = (await router.handleRequest(siteA, {
        method: 'eth_call',
        params: [
          {
            to: '0xcA11bde05977b3631167028862bE2a173976CA11',
            data: multicallData,
          },
          'latest',
        ],
      })) as string
      expect(BigInt(multicallRes)).toBe(balWeiA)

      // 3. eth_estimateGas passes stateOverride so node gas estimation doesn't revert with 'insufficient funds'
      await router.handleRequest(siteA, {
        method: 'eth_estimateGas',
        params: [{ from: personaA, to: personaB, value: '0xde0b6b3a7640000' }],
      })
      expect(observedStateOverrides).toHaveLength(1)
      expect(observedStateOverrides[0]?.[personaA]?.balance).toBe(balHexA)

      // 4. When eth_sendTransaction is actually triggered, JIT sweep still uses real 0n on-chain balance!
      const txPromise = router.handleRequest(siteA, {
        method: 'eth_sendTransaction',
        params: [
          {
            from: personaA,
            to: '0x3333333333333333333333333333333333333333',
            value: '0xde0b6b3a7640000', // 1 MON
          },
        ],
      })
      await router.approveRequest(router.listPendingApprovals()[0].id)
      await txPromise
      expect(sweepCalls).toHaveLength(1)
      expect(sweepCalls[0].recipient).toBe(personaA)
      expect(sweepCalls[0].shortfallWei).toBe(1_000_021_000_000_000_000n)
    })
  })
})

