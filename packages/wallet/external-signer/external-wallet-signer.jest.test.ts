import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { Wallet } from 'ethers'
import { PublicKey } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { createMonadWalletMaterial } from '../evm-wallet-material'
import { DEFAULT_MONAD_MAX_HOT_BALANCE_ATOMIC } from '../hygiene/cold-vault-sweeper'
import {
  buildEvmExternalSignerChallenge,
  buildExternalSignerStatement,
  buildSolanaExternalSignerChallenge,
  deriveExternalWalletMessagingKeys,
  deriveMessagingRootFromExternalSignature,
  EXTERNAL_SIGNER_DOMAIN_NAME,
  EXTERNAL_SIGNER_DOMAIN_VERSION,
  EXTERNAL_SIGNER_HKDF_SALT,
  signWithEip1193Provider,
  signWithSolanaWalletStandard,
} from './external-wallet-signer'

function makeHighEntropySignature(length: 64 | 65, seedByte = 1): Uint8Array {
  const firstHalf = sha256(Uint8Array.from([seedByte, 0xaa, 0x55]))
  const secondHalf = sha256(Uint8Array.from([seedByte, 0xbb, 0x66]))
  const out = new Uint8Array(length)
  out.set(firstHalf, 0)
  out.set(secondHalf, 32)
  if (length === 65) {
    out[64] = 27
  }
  return out
}

describe('External Wallet Signer (EIP-1193 / EIP-712 & Solana Wallet-Standard) (Issue #1572)', () => {
  const evmChecksumAddress = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B'
  const evmLowerAddress = evmChecksumAddress.toLowerCase()
  const solanaAddress = new PublicKey(
    ed25519.getPublicKey(sha256(utf8ToBytes('frank-test-solana-external-signer'))),
  ).toBase58()

  describe('Canonical domain-separated challenges', () => {
    it('builds canonical EVM EIP-712 typed data and personal_sign fallback challenge', () => {
      const challenge = buildEvmExternalSignerChallenge(evmChecksumAddress, {
        chainId: 10143,
      })

      expect(challenge.family).toBe('evm')
      expect(challenge.canonicalAddress).toBe(evmLowerAddress)
      expect(challenge.checksumAddress).toBe(evmChecksumAddress)
      expect(challenge.statement).toBe(
        `Authorize deterministic Cashweb messaging keys for account ${evmLowerAddress}. Never sign this on untrusted origins.`,
      )
      expect(challenge.typedData.domain).toEqual({
        name: 'Signet Cashweb Messaging',
        version: '1',
        chainId: 10143,
      })
      expect(challenge.typedData.primaryType).toBe('CashwebMessagingAuth')
      expect(challenge.typedData.message).toEqual({
        account: evmLowerAddress,
        statement: buildExternalSignerStatement(evmLowerAddress),
      })
      expect(challenge.personalSignMessage).toContain(
        EXTERNAL_SIGNER_DOMAIN_NAME,
      )
      expect(challenge.personalSignMessage).toContain(challenge.statement)
    })

    it('builds canonical Solana Wallet-Standard UTF-8 domain-separated challenge', () => {
      const challenge = buildSolanaExternalSignerChallenge(solanaAddress)

      expect(challenge.family).toBe('solana')
      expect(challenge.canonicalAddress).toBe(solanaAddress)
      expect(challenge.statement).toBe(
        `Authorize deterministic Cashweb messaging keys for account ${solanaAddress}. Never sign this on untrusted origins.`,
      )
      expect(challenge.messageText).toContain(EXTERNAL_SIGNER_DOMAIN_NAME)
      expect(challenge.messageText).toContain(
        `(v${EXTERNAL_SIGNER_DOMAIN_VERSION})`,
      )
      expect(challenge.messageText).toContain(challenge.statement)
      expect(Buffer.from(challenge.messageBytes).toString('utf8')).toBe(
        challenge.messageText,
      )
    })
  })

  describe('deriveMessagingRootFromExternalSignature', () => {
    it('derives the exact HKDF-SHA256 32-byte messaging seed for EVM and normalizes address case and v recovery byte', () => {
      const sig27 = makeHighEntropySignature(65, 7)
      sig27[64] = 27
      const sig0 = Uint8Array.from(sig27)
      sig0[64] = 0 // Ledger-style v=0 recovery id

      const rootChecksum = deriveMessagingRootFromExternalSignature({
        family: 'evm',
        address: evmChecksumAddress,
        signatureBytes: sig27,
      })
      const rootLower = deriveMessagingRootFromExternalSignature({
        family: 'evm',
        address: evmLowerAddress,
        signatureBytes: sig0,
      })

      expect(rootChecksum).toHaveLength(32)
      expect(bytesToHex(rootChecksum)).toBe(bytesToHex(rootLower))

      const expectedHkdf = hkdf(
        sha256,
        sig27,
        utf8ToBytes(EXTERNAL_SIGNER_HKDF_SALT),
        utf8ToBytes(`evm:${evmLowerAddress}`),
        32,
      )
      expect(bytesToHex(rootChecksum)).toBe(bytesToHex(expectedHkdf))
    })

    it('derives the exact HKDF-SHA256 32-byte messaging seed for Solana 64-byte Ed25519 signatures', () => {
      const sig64 = makeHighEntropySignature(64, 42)
      const root = deriveMessagingRootFromExternalSignature({
        family: 'solana',
        address: solanaAddress,
        signatureBytes: sig64,
      })

      const expectedHkdf = hkdf(
        sha256,
        sig64,
        utf8ToBytes('frank/external-signer/v1'),
        utf8ToBytes(`solana:${solanaAddress}`),
        32,
      )
      expect(root).toHaveLength(32)
      expect(bytesToHex(root)).toBe(bytesToHex(expectedHkdf))
    })

    it('domain-separates roots across different addresses', () => {
      const sig = makeHighEntropySignature(65, 99)
      const otherAddress = '0x1111111111111111111111111111111111111111'

      const rootA = deriveMessagingRootFromExternalSignature({
        family: 'evm',
        address: evmChecksumAddress,
        signatureBytes: sig,
      })
      const rootB = deriveMessagingRootFromExternalSignature({
        family: 'evm',
        address: otherAddress,
        signatureBytes: sig,
      })

      expect(bytesToHex(rootA)).not.toBe(bytesToHex(rootB))
    })

    it('rejects malformed lengths, all-zero signatures, low-entropy bytes, or zero r/s components', () => {
      expect(() =>
        deriveMessagingRootFromExternalSignature({
          family: 'evm',
          address: evmChecksumAddress,
          signatureBytes: new Uint8Array(32),
        }),
      ).toThrow(/Invalid EVM signature length/)

      expect(() =>
        deriveMessagingRootFromExternalSignature({
          family: 'solana',
          address: solanaAddress,
          signatureBytes: makeHighEntropySignature(65, 1),
        }),
      ).toThrow(/Invalid Solana signature length/)

      expect(() =>
        deriveMessagingRootFromExternalSignature({
          family: 'evm',
          address: evmChecksumAddress,
          signatureBytes: new Uint8Array(65),
        }),
      ).toThrow(/insufficient entropy/)

      const repeatedPattern = new Uint8Array(64)
      for (let i = 0; i < 64; i++) repeatedPattern[i] = i % 3
      expect(() =>
        deriveMessagingRootFromExternalSignature({
          family: 'solana',
          address: solanaAddress,
          signatureBytes: repeatedPattern,
        }),
      ).toThrow(/insufficient entropy/)

      const zeroS = makeHighEntropySignature(64, 5)
      zeroS.fill(0, 32, 64)
      expect(() =>
        deriveMessagingRootFromExternalSignature({
          family: 'solana',
          address: solanaAddress,
          signatureBytes: zeroS,
        }),
      ).toThrow(/r or s component is all-zero/)
    })
  })

  describe('deriveExternalWalletMessagingKeys & Cold-Vault auto-configuration', () => {
    it('derives deterministic messaging keys, compatible MonadWalletMaterial roots, and auto-sets externalVaultAddress', () => {
      const sig = makeHighEntropySignature(65, 19)
      const bundle = deriveExternalWalletMessagingKeys({
        family: 'evm',
        address: evmChecksumAddress,
        signatureBytes: sig,
      })

      expect(bundle.messagingRoot).toHaveLength(32)
      expect(bundle.identityPrivateKey).toHaveLength(32)
      expect(bundle.messagingPrivateKey).toHaveLength(32)
      expect(bundle.selfOpenKey).toHaveLength(32)
      expect(bundle.externalVaultAddress).toBe(evmChecksumAddress)
      expect(bundle.coldVaultSweepConfig).toEqual({
        chainId: 'monad-testnet',
        enabled: true,
        externalVaultAddress: evmChecksumAddress,
        maxHotBalanceAtomic: DEFAULT_MONAD_MAX_HOT_BALANCE_ATOMIC,
        maxHotBalanceAvu: 150,
        hysteresisBps: 2000,
      })

      // Verify domainRoots construct valid MonadWalletMaterial with canonicalRoles
      const walletMaterial = createMonadWalletMaterial(bundle.domainRoots)
      expect(walletMaterial.mainAccount.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(walletMaterial.canonicalRoles).toBeDefined()
      walletMaterial.dispose()

      bundle.dispose()
      expect(bundle.messagingRoot.every(b => b === 0)).toBe(true)
      expect(bundle.identityPrivateKey.every(b => b === 0)).toBe(true)
      expect(bundle.messagingPrivateKey.every(b => b === 0)).toBe(true)
      expect(bundle.selfOpenKey.every(b => b === 0)).toBe(true)
    })
  })

  describe('EIP-1193 and Solana Wallet-Standard provider flows', () => {
    it('signs with EIP-712 via eth_signTypedData_v4 and falls back to personal_sign when unsupported', async () => {
      const wallet = new Wallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      )
      const sigHex = '0x' + bytesToHex(makeHighEntropySignature(65, 77))

      const typedDataProvider = {
        request: jest.fn(async ({ method }: { method: string }) => {
          expect(method).toBe('eth_signTypedData_v4')
          return sigHex
        }),
      }

      const res1 = await signWithEip1193Provider({
        provider: typedDataProvider,
        address: wallet.address,
        chainId: 10143,
      })
      expect(res1.methodUsed).toBe('eth_signTypedData_v4')
      expect(res1.keys.externalVaultAddress).toBe(wallet.address)

      // Provider that throws MethodNotFound on eth_signTypedData_v4 and succeeds on personal_sign
      const fallbackProvider = {
        request: jest.fn(async ({ method }: { method: string }) => {
          if (method === 'eth_signTypedData_v4') {
            throw new Error('Method eth_signTypedData_v4 not supported')
          }
          expect(method).toBe('personal_sign')
          return sigHex
        }),
      }

      const res2 = await signWithEip1193Provider({
        provider: fallbackProvider,
        address: wallet.address,
      })
      expect(res2.methodUsed).toBe('personal_sign')
      expect(bytesToHex(res2.keys.messagingRoot)).toBe(
        bytesToHex(res1.keys.messagingRoot),
      )

      // Provider where user explicitly clicks Reject (4001) should NOT fall back
      const rejectProvider = {
        request: jest.fn(async () => {
          const err = new Error('User rejected request') as Error & {
            code: number
          }
          err.code = 4001
          throw err
        }),
      }
      await expect(
        signWithEip1193Provider({
          provider: rejectProvider,
          address: wallet.address,
        }),
      ).rejects.toThrow('User rejected request')
      expect(rejectProvider.request).toHaveBeenCalledTimes(1)
    })

    it('signs with Solana Wallet-Standard signMessage and configures Solana cold vault address', async () => {
      const sigBytes = makeHighEntropySignature(64, 88)
      const solanaSigner = {
        signMessage: jest.fn(async (msg: Uint8Array) => {
          expect(Buffer.from(msg).toString('utf8')).toContain(
            `Authorize deterministic Cashweb messaging keys for account ${solanaAddress}. Never sign this on untrusted origins.`,
          )
          return { signature: sigBytes }
        }),
      }

      const res = await signWithSolanaWalletStandard({
        signer: solanaSigner,
        address: solanaAddress,
      })
      expect(solanaSigner.signMessage).toHaveBeenCalledTimes(1)
      expect(res.keys.externalVaultAddress).toBe(solanaAddress)
      expect(res.keys.coldVaultSweepConfig?.chainId).toBe('solana-devnet')
    })
  })
})
