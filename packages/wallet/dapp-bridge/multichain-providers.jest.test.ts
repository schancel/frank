import { ed25519 } from '@noble/curves/ed25519'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { BTC_MAINNET, verifyMessage as verifyNakamotoMessage } from '@frank/nakamoto'
import {
  ALL_DAPP_CHAIN_FAMILIES,
  BchUtxoBridge,
  BitcoinDappBridge,
  DappTrackabilityPolicy,
  EIP1193_ERROR_CODES,
  EcashCashtabBridge,
  MultiChainDappPersonaKeyring,
  SolanaWalletStandardBridge,
  UnifiedMultiChainDappRouter,
  deriveMultiChainDappPersona,
  derivePrimaryAccountZeroAddresses,
  planUtxoPersonaJitInputSelection,
} from './index'

const TEST_MASTER_SEED = new Uint8Array(32).fill(0x42)

describe('Unified Multi-Chain dApp Provider & Anti-Supercookie Persona Isolation', () => {
  describe('MultiChainDappPersonaKeyring & Cryptographic Disjointness across all 7 chains', () => {
    it('derives valid account=1 personas across evm, solana, btc (P2WPKH + Taproot P2TR), bch, xec, doge, and ltc that are 100% disjoint from account=0', () => {
      const keyring = new MultiChainDappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MASTER_SEED,
        accountZeroGuardCount: 16,
      })

      for (const family of ALL_DAPP_CHAIN_FAMILIES) {
        const accountZeroSet = new Set<string>()
        for (let i = 0; i < 16; i++) {
          const { addresses } = derivePrimaryAccountZeroAddresses(
            TEST_MASTER_SEED,
            family,
            i,
            'mainnet',
          )
          for (const addr of addresses) {
            accountZeroSet.add(addr.toLowerCase())
          }
        }

        const persona = keyring.getOrAssignOriginPersona(
          'https://app.example.org',
          family,
        )
        expect(persona.chainFamily).toBe(family)
        expect(persona.index).toBeGreaterThanOrEqual(1)
        expect(persona.mode).toBe('per-origin-burner')
        expect(accountZeroSet.has(persona.address.toLowerCase())).toBe(false)

        if (family === 'evm') {
          expect(persona.derivationPath).toBe("m/44'/60'/1'/0/1")
          expect(persona.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        } else if (family === 'solana') {
          expect(persona.derivationPath).toBe("m/44'/501'/1'/1'")
          expect(persona.publicKeyBytes).toHaveLength(32)
        } else if (family === 'btc') {
          expect(persona.paymentDerivationPath).toBe("m/84'/0'/1'/0/1")
          expect(persona.ordinalsDerivationPath).toBe("m/86'/0'/1'/0/1")
          expect(persona.paymentAddress).toMatch(/^bc1q[a-z0-9]+$/)
          expect(persona.ordinalsAddress).toMatch(/^bc1p[a-z0-9]+$/)
          expect(
            accountZeroSet.has(persona.ordinalsAddress!.toLowerCase()),
          ).toBe(false)
        } else if (family === 'bch') {
          expect(persona.derivationPath).toBe("m/44'/145'/1'/0/1")
          expect(persona.address).toMatch(/^bitcoincash:q[a-z0-9]+$/)
        } else if (family === 'xec') {
          expect(persona.derivationPath).toBe("m/44'/899'/1'/0/1")
          expect(persona.address).toMatch(/^ecash:q[a-z0-9]+$/)
        } else if (family === 'doge') {
          expect(persona.derivationPath).toBe("m/44'/3'/1'/0/1")
          expect(persona.address).toMatch(/^D[1-9A-HJ-NP-Za-km-z]+$/)
        } else if (family === 'ltc') {
          expect(persona.derivationPath).toBe("m/84'/2'/1'/0/1")
          expect(persona.address).toMatch(/^ltc1q[a-z0-9]+$/)
        }
      }
    })

    it('assigns completely different per-origin burner addresses across sites (Solana, BTC, eCash, BCH)', () => {
      const keyring = new MultiChainDappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MASTER_SEED,
      })

      // Solana: jup.ag vs raydium.io
      const jupSol = keyring.getOrAssignOriginPersona('https://jup.ag', 'solana')
      const raySol = keyring.getOrAssignOriginPersona('https://raydium.io', 'solana')
      expect(jupSol.address).not.toBe(raySol.address)
      expect(jupSol.publicKeyHex).not.toBe(raySol.publicKeyHex)
      // Re-querying the same origin returns the exact same bound burner
      expect(
        keyring.getOrAssignOriginPersona('https://jup.ag', 'solana').address,
      ).toBe(jupSol.address)

      // Bitcoin: magiceden.io vs unisat.io
      const meBtc = keyring.getOrAssignOriginPersona('https://magiceden.io', 'btc')
      const unisatBtc = keyring.getOrAssignOriginPersona('https://unisat.io', 'btc')
      expect(meBtc.paymentAddress).not.toBe(unisatBtc.paymentAddress)
      expect(meBtc.ordinalsAddress).not.toBe(unisatBtc.ordinalsAddress)

      // eCash: cashtab.com vs ecash.supply
      const cashtabXec = keyring.getOrAssignOriginPersona('https://cashtab.com', 'xec')
      const supplyXec = keyring.getOrAssignOriginPersona('https://ecash.supply', 'xec')
      expect(cashtabXec.address).not.toBe(supplyXec.address)

      // Shared primary mode when explicitly requested uses index 0 (still on account=1')
      const sharedA = keyring.getOrAssignOriginPersona('https://site-a.example', 'solana', {
        mode: 'shared-primary',
      })
      const sharedB = keyring.getOrAssignOriginPersona('https://site-b.example', 'solana', {
        mode: 'shared-primary',
      })
      expect(sharedA.index).toBe(0)
      expect(sharedA.address).toBe(sharedB.address)
      expect(sharedA.address).not.toBe(jupSol.address)
    })

    it('plans anti-clustering UTXO JIT input selection without exposing the main receive address', () => {
      const keyring = new MultiChainDappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MASTER_SEED,
      })
      const btcPersona = keyring.getOrAssignOriginPersona('https://magiceden.io', 'btc')

      // Case 1: UTXO already sits on the origin's persona address -> direct spend, no JIT hop needed
      const directPlan = planUtxoPersonaJitInputSelection({
        origin: 'https://magiceden.io',
        personaAddress: btcPersona.paymentAddress!,
        chainFamily: 'btc',
        targetAmountSatoshis: 50_000n,
        feeRateSatPerVbyte: 2n,
        availableUtxos: [
          {
            txid: 'a'.repeat(64),
            vout: 0,
            satoshis: 5_000_000n,
            address: 'bc1qmainreceiveaddress000000000000000000',
            isMainReceiveAddress: true,
          },
          {
            txid: 'b'.repeat(64),
            vout: 1,
            satoshis: 100_000n,
            address: btcPersona.paymentAddress!,
            originTag: 'https://magiceden.io',
          },
        ],
      })
      expect(directPlan.requiresJitFundingHop).toBe(false)
      expect(directPlan.exposesMainReceiveAddress).toBe(false)
      expect(directPlan.leaksMultiAddressCluster).toBe(false)
      expect(directPlan.selectedUtxos).toHaveLength(1)
      expect(directPlan.selectedUtxos[0]?.txid).toBe('b'.repeat(64))

      // Case 2: Persona has no UTXO yet -> selects a single non-main-receive UTXO for a 1-hop JIT funding transfer
      const jitHopPlan = planUtxoPersonaJitInputSelection({
        origin: 'https://unisat.io',
        personaAddress: 'bc1qfreshburnerpersona000000000000000000',
        chainFamily: 'btc',
        targetAmountSatoshis: 40_000n,
        feeRateSatPerVbyte: 2n,
        availableUtxos: [
          {
            txid: '1'.repeat(64),
            vout: 0,
            satoshis: 10_000_000n,
            address: 'bc1qmainreceiveaddress000000000000000000',
            isMainReceiveAddress: true,
          },
          {
            txid: '2'.repeat(64),
            vout: 2,
            satoshis: 75_000n,
            address: 'bc1qinternalchange0000000000000000000000',
            isMainReceiveAddress: false,
          },
        ],
      })
      expect(jitHopPlan.requiresJitFundingHop).toBe(true)
      expect(jitHopPlan.exposesMainReceiveAddress).toBe(false)
      expect(jitHopPlan.leaksMultiAddressCluster).toBe(false)
      expect(jitHopPlan.selectedUtxos).toHaveLength(1)
      expect(jitHopPlan.selectedUtxos[0]?.txid).toBe('2'.repeat(64))
    })
  })

  describe('SolanaWalletStandardBridge (solana:connect, signMessage, signIn SIWS)', () => {
    it('returns [] on silent connect for unapproved origins and signs messages & SIWS with Ed25519 after approval', async () => {
      const keyring = new MultiChainDappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MASTER_SEED,
      })
      const router = new UnifiedMultiChainDappRouter({ keyring })
      const solanaBridge = new SolanaWalletStandardBridge(router)

      // 1. Silent connect on unapproved origin NEVER prompts and returns empty accounts
      const silentRes = (await solanaBridge.handleRequest('https://jup.ag', {
        method: 'solana_connect',
        params: { silent: true },
      })) as { publicKey: string | null; accounts: unknown[] }
      expect(silentRes.publicKey).toBeNull()
      expect(silentRes.accounts).toEqual([])
      expect(router.listPendingApprovals()).toHaveLength(0)

      // 2. Interactive connect enqueues approval and assigns per-origin Solana burner persona
      const connectPromise = solanaBridge.handleRequest('https://jup.ag', {
        method: 'solana_connect',
      })
      const pending = router.listPendingApprovals()
      expect(pending).toHaveLength(1)
      expect(pending[0]?.request.chainFamily).toBe('solana')
      expect(pending[0]?.request.action).toBe('connect')

      await router.approveRequest(pending[0]!.id)
      const connectedRes = (await connectPromise) as {
        publicKey: string
        accounts: Array<{ address: string; publicKey: Uint8Array }>
      }
      expect(connectedRes.accounts).toHaveLength(1)
      const jupAccount = connectedRes.accounts[0]!
      expect(jupAccount.address).toBe(connectedRes.publicKey)

      // 3. Subsequent silent connect on approved origin returns that origin's Persona without prompting
      const silentAfterApprove = (await solanaBridge.handleRequest('https://jup.ag', {
        method: 'solana_connect',
        params: { silent: true },
      })) as { publicKey: string | null; accounts: Array<{ address: string }> }
      expect(silentAfterApprove.publicKey).toBe(jupAccount.address)
      expect(silentAfterApprove.accounts).toHaveLength(1)
      expect(router.listPendingApprovals()).toHaveLength(0)

      // 4. Another origin (https://raydium.io) still sees [] on silent check!
      const raySilent = (await solanaBridge.handleRequest('https://raydium.io', {
        method: 'solana_connect',
        params: { silent: true },
      })) as { publicKey: string | null; accounts: unknown[] }
      expect(raySilent.accounts).toEqual([])

      // 5. solana_signMessage produces a valid Ed25519 signature over the message bytes
      const messageBytes = utf8ToBytes('Swap 10 USDC for SOL on Jupiter')
      const signMsgPromise = solanaBridge.handleRequest('https://jup.ag', {
        method: 'solana_signMessage',
        params: { message: messageBytes },
      })
      const signPending = router.listPendingApprovals()
      expect(signPending).toHaveLength(1)
      await router.approveRequest(signPending[0]!.id)

      const signMsgRes = (await signMsgPromise) as {
        signature: Uint8Array
        signedMessage: Uint8Array
        publicKey: string
      }
      expect(signMsgRes.publicKey).toBe(jupAccount.address)
      expect(
        ed25519.verify(
          signMsgRes.signature,
          signMsgRes.signedMessage,
          jupAccount.publicKey,
        ),
      ).toBe(true)

      // 6. solana_signIn (SIWS) on a new origin connects and signs the canonical SIWS challenge
      const siwsPromise = solanaBridge.handleRequest('https://tensor.trade', {
        method: 'solana_signIn',
        params: {
          domain: 'tensor.trade',
          statement: 'Sign in to Tensor',
          nonce: '987654321',
        },
      })
      const siwsPending = router.listPendingApprovals()
      expect(siwsPending).toHaveLength(1)
      await router.approveRequest(siwsPending[0]!.id)

      const siwsRes = (await siwsPromise) as {
        account: { address: string; publicKey: Uint8Array }
        signedMessage: Uint8Array
        signature: Uint8Array
      }
      expect(siwsRes.account.address).not.toBe(jupAccount.address)
      const decodedChallenge = new TextDecoder().decode(siwsRes.signedMessage)
      expect(decodedChallenge).toContain('tensor.trade wants you to sign in with your Solana account:')
      expect(decodedChallenge).toContain(siwsRes.account.address)
      expect(decodedChallenge).toContain('Nonce: 987654321')
      expect(
        ed25519.verify(
          siwsRes.signature,
          siwsRes.signedMessage,
          siwsRes.account.publicKey,
        ),
      ).toBe(true)
    })
  })

  describe('BitcoinDappBridge (UniSat + WBIP004 / sats-connect)', () => {
    it('supports UniSat silent getAccounts, requestAccounts, getPublicKey, signMessage, and signPsbt', async () => {
      const keyring = new MultiChainDappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MASTER_SEED,
      })
      const router = new UnifiedMultiChainDappRouter({ keyring })
      const btcBridge = new BitcoinDappBridge(router)

      // Silent unisat_getAccounts and unisat_getPublicKey before connection
      const unapprovedAccounts = await btcBridge.handleUnisatRequest('https://unisat.io', {
        method: 'unisat_getAccounts',
      })
      expect(unapprovedAccounts).toEqual([])
      expect(
        await btcBridge.handleUnisatRequest('https://unisat.io', {
          method: 'unisat_getPublicKey',
        }),
      ).toBe('')
      expect(router.listPendingApprovals()).toHaveLength(0)

      // Interactive unisat_requestAccounts
      const reqAccountsPromise = btcBridge.handleUnisatRequest('https://unisat.io', {
        method: 'unisat_requestAccounts',
      })
      const pending = router.listPendingApprovals()
      expect(pending).toHaveLength(1)
      await router.approveRequest(pending[0]!.id)
      const accounts = (await reqAccountsPromise) as string[]
      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toMatch(/^bc1q[a-z0-9]+$/)

      const pubKeyHex = (await btcBridge.handleUnisatRequest('https://unisat.io', {
        method: 'unisat_getPublicKey',
      })) as string
      expect(pubKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/)

      // Sign ECDSA Bitcoin Message and verify with @frank/nakamoto verifyMessage
      const msgText = 'Verify UniSat Bitcoin Persona ownership'
      const signPromise = btcBridge.handleUnisatRequest('https://unisat.io', {
        method: 'unisat_signMessage',
        params: { message: msgText, type: 'ecdsa' },
      })
      const signPending = router.listPendingApprovals()
      await router.approveRequest(signPending[0]!.id)
      const sigBase64 = (await signPromise) as string
      const sigBytes = new Uint8Array(Buffer.from(sigBase64, 'base64'))
      const verified = verifyNakamotoMessage(
        BTC_MAINNET,
        hexToBytes(pubKeyHex),
        utf8ToBytes(msgText),
        sigBytes,
      )
      expect(verified).toEqual({ ok: true, value: true })

      // Sign PSBT
      const psbtPromise = btcBridge.handleUnisatRequest('https://unisat.io', {
        method: 'unisat_signPsbt',
        params: { psbtHex: '70736274ff0100' },
      })
      const psbtPending = router.listPendingApprovals()
      await router.approveRequest(psbtPending[0]!.id)
      const signedPsbtHex = (await psbtPromise) as string
      expect(signedPsbtHex.startsWith('70736274ff0100')).toBe(true)
      expect(signedPsbtHex.length).toBeGreaterThan('70736274ff0100'.length)
    })

    it('supports WBIP004 getAccounts returning both P2WPKH payment and P2TR ordinals addresses', async () => {
      const keyring = new MultiChainDappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MASTER_SEED,
      })
      const router = new UnifiedMultiChainDappRouter({ keyring })
      const btcBridge = new BitcoinDappBridge(router)

      const connectPromise = btcBridge.handleWbip004Request('https://magiceden.io', {
        method: 'getAccounts',
        params: { purposes: ['payment', 'ordinals'] },
      })
      const pending = router.listPendingApprovals()
      expect(pending).toHaveLength(1)
      await router.approveRequest(pending[0]!.id)

      const res = (await connectPromise) as {
        accounts: Array<{
          address: string
          publicKey: string
          purpose: 'payment' | 'ordinals'
          addressType: 'p2wpkh' | 'p2tr'
        }>
      }
      expect(res.accounts).toHaveLength(2)
      const paymentAcc = res.accounts.find((a) => a.purpose === 'payment')!
      const ordinalsAcc = res.accounts.find((a) => a.purpose === 'ordinals')!
      expect(paymentAcc.addressType).toBe('p2wpkh')
      expect(paymentAcc.address).toMatch(/^bc1q[a-z0-9]+$/)
      expect(ordinalsAcc.addressType).toBe('p2tr')
      expect(ordinalsAcc.address).toMatch(/^bc1p[a-z0-9]+$/)
    })
  })

  describe('EcashCashtabBridge (FROM_PAGE -> FROM_CASHTAB)', () => {
    it('handles Cashtab addressRequest and txInfo messages with per-origin eCash Persona isolation', async () => {
      const keyring = new MultiChainDappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MASTER_SEED,
      })
      const router = new UnifiedMultiChainDappRouter({ keyring })
      const cashtabBridge = new EcashCashtabBridge(router)

      // Ignore unrelated window.postMessage payloads
      expect(
        await cashtabBridge.handlePagePostMessage('https://ecash.supply', {
          type: 'OTHER_EVENT',
        }),
      ).toBeNull()

      // 1. Cashtab addressRequest
      const addrPromise = cashtabBridge.handlePagePostMessage('https://ecash.supply', {
        type: 'FROM_PAGE',
        text: 'Cashtab',
        addressRequest: true,
      })
      const pendingAddr = router.listPendingApprovals()
      expect(pendingAddr).toHaveLength(1)
      expect(pendingAddr[0]?.request.chainFamily).toBe('xec')
      expect(pendingAddr[0]?.request.protocol).toBe('xec-cashtab')

      await router.approveRequest(pendingAddr[0]!.id)
      const addrResponse = await addrPromise
      expect(addrResponse).toEqual({
        type: 'FROM_CASHTAB',
        address: expect.stringMatching(/^ecash:q[a-z0-9]+$/),
      })

      // 2. Cashtab txInfo send request
      const txPromise = cashtabBridge.handlePagePostMessage('https://ecash.supply', {
        type: 'FROM_PAGE',
        text: 'Cashtab',
        txInfo: {
          address: 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwva87rkuu2',
          value: '100.5',
          opReturn: '6d02',
        },
      })
      const pendingTx = router.listPendingApprovals()
      expect(pendingTx).toHaveLength(1)
      expect(pendingTx[0]?.request.action).toBe('sign_and_send_transaction')

      await router.approveRequest(pendingTx[0]!.id)
      const txResponse = await txPromise
      expect(txResponse).toEqual({
        type: 'FROM_CASHTAB',
        txid: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    })
  })

  describe('BchUtxoBridge & Anti-Spam Rejection Cooldown (DappTrackabilityPolicy)', () => {
    it('enforces announceMode visibility, maxPendingPerOrigin=1, and post-rejection cooldown against popup loops', async () => {
      let currentTimeMs = 1_700_000_000_000
      const policy = new DappTrackabilityPolicy({
        announceMode: 'connected-only',
        defaultPersonaMode: 'per-origin-burner',
        maxPendingPerOrigin: 1,
        rejectionCooldownMs: 5_000,
        nowMs: () => currentTimeMs,
      })
      const keyring = new MultiChainDappPersonaKeyring({
        masterSeedOrMnemonic: TEST_MASTER_SEED,
        nowMs: () => currentTimeMs,
      })
      const router = new UnifiedMultiChainDappRouter({
        keyring,
        policy,
        nowMs: () => currentTimeMs,
      })
      const bchBridge = new BchUtxoBridge(router)

      // In 'connected-only' announceMode, unapproved origins are hidden
      expect(
        policy.shouldAnnounceProviderToOrigin(
          'https://spammy-dapp.org',
          keyring.listConnectedOrigins(),
        ),
      ).toBe(false)

      // First connect request from https://spammy-dapp.org is enqueued
      const firstConnect = bchBridge.handleRequest('https://spammy-dapp.org', {
        method: 'bch_requestAccounts',
      })
      expect(router.listPendingApprovals()).toHaveLength(1)

      // Concurrent duplicate connect request while one is already pending is rejected immediately
      await expect(
        bchBridge.handleRequest('https://spammy-dapp.org', {
          method: 'bch_requestAccounts',
        }),
      ).rejects.toMatchObject({
        code: EIP1193_ERROR_CODES.USER_REJECTED_REQUEST,
      })

      // User rejects the pending connect request
      const pendingId = router.listPendingApprovals()[0]!.id
      router.rejectRequest(pendingId)
      await expect(firstConnect).rejects.toMatchObject({
        code: EIP1193_ERROR_CODES.USER_REJECTED_REQUEST,
      })

      // Immediate retry 100ms later is blocked by the 5000ms rejection cooldown!
      currentTimeMs += 100
      await expect(
        bchBridge.handleRequest('https://spammy-dapp.org', {
          method: 'bch_requestAccounts',
        }),
      ).rejects.toMatchObject({
        code: EIP1193_ERROR_CODES.USER_REJECTED_REQUEST,
      })
      expect(router.listPendingApprovals()).toHaveLength(0)

      // After cooldown expires (+5000ms), origin can request connection again
      currentTimeMs += 5_000
      const retryConnect = bchBridge.handleRequest('https://spammy-dapp.org', {
        method: 'bch_requestAccounts',
      })
      const retryPending = router.listPendingApprovals()
      expect(retryPending).toHaveLength(1)
      await router.approveRequest(retryPending[0]!.id)
      const bchAccounts = (await retryConnect) as string[]
      expect(bchAccounts[0]).toMatch(/^bitcoincash:q[a-z0-9]+$/)

      // Now that https://spammy-dapp.org is connected, 'connected-only' announceMode allows it
      expect(
        policy.shouldAnnounceProviderToOrigin(
          'https://spammy-dapp.org',
          keyring.listConnectedOrigins(),
        ),
      ).toBe(true)
      // 'stealth' mode never announces
      expect(
        policy.shouldAnnounceProviderToOrigin(
          'https://spammy-dapp.org',
          keyring.listConnectedOrigins(),
          'stealth',
        ),
      ).toBe(false)
    })
  })
})
