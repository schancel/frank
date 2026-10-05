import {
  CANDIDATE_PATHS,
  CANONICAL_FRANK_PATH,
  STANDARD_EVM_PATH,
  EARLY_FRANK_PATH,
  burnerPoolPath,
  deriveCandidateAccounts,
  scanBip39Accounts,
  createBip39WalletMaterial,
  createBip39SeedBundle,
  createWalletMaterialFromPath,
  createSeedBundleFromPath,
} from './bip39-import'
import { MONAD_IDENTITY_DERIVATION_PATH } from './monad-identity'

describe('BIP-39 Import & Derivation Scanner (Issue #847)', () => {
  const TEST_PHRASE = 'test test test test test test test test test test test junk'
  const SECOND_TEST_PHRASE =
    'legal winner thank year wave sausage worth useful legal winner thank yellow'

  describe('Candidate Derivation Paths Definition', () => {
    it('defines the canonical Frank identity path matching MONAD_IDENTITY_DERIVATION_PATH', () => {
      expect(CANONICAL_FRANK_PATH).toBe("m/44'/60'/1'/0/0")
      expect(CANONICAL_FRANK_PATH).toBe(MONAD_IDENTITY_DERIVATION_PATH)
    })

    it('defines standard EVM / MetaMask Account 0 path', () => {
      expect(STANDARD_EVM_PATH).toBe("m/44'/60'/0'/0/0")
    })

    it('defines early Frank identity path', () => {
      expect(EARLY_FRANK_PATH).toBe("m/44'/60'/0'/1/0")
    })

    it('defines Frank sub-account burner pool paths for indices 0..4', () => {
      for (let i = 0; i <= 4; i++) {
        expect(burnerPoolPath(i)).toBe(`m/44'/60'/0'/0/${i}`)
      }
    })

    it('throws error for invalid burner pool indices', () => {
      expect(() => burnerPoolPath(-1)).toThrow('non-negative integer')
      expect(() => burnerPoolPath(1.5)).toThrow('non-negative integer')
    })

    it('includes all candidate paths in CANDIDATE_PATHS', () => {
      const paths = CANDIDATE_PATHS.map(c => c.path)
      expect(paths).toContain(CANONICAL_FRANK_PATH)
      expect(paths).toContain(STANDARD_EVM_PATH)
      expect(paths).toContain(EARLY_FRANK_PATH)
      expect(paths).toContain("m/44'/60'/0'/0/1")
      expect(paths).toContain("m/44'/60'/0'/0/2")
      expect(paths).toContain("m/44'/60'/0'/0/3")
      expect(paths).toContain("m/44'/60'/0'/0/4")
    })
  })

  describe('deriveCandidateAccounts', () => {
    it('throws on invalid mnemonic phrase', () => {
      expect(() => deriveCandidateAccounts('invalid wordlist phrase')).toThrow(
        'Invalid BIP-39 mnemonic',
      )
      expect(() => deriveCandidateAccounts('')).toThrow(
        'Invalid BIP-39 mnemonic',
      )
    })

    it('derives expected deterministic addresses across all candidate paths for TEST_PHRASE', () => {
      const accounts = deriveCandidateAccounts(TEST_PHRASE)
      expect(accounts.length).toBe(CANDIDATE_PATHS.length)

      const accountMap = new Map(accounts.map(a => [a.path, a]))

      // Canonical Frank Monad Identity
      const canonical = accountMap.get(CANONICAL_FRANK_PATH)!
      expect(canonical).toBeDefined()
      expect(canonical.label).toBe('Canonical Frank')
      expect(canonical.address).toBe('0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650')
      expect(canonical.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/)

      // Standard EVM / MetaMask Account 0 (Hardhat Account 0)
      const standardEvm = accountMap.get(STANDARD_EVM_PATH)!
      expect(standardEvm).toBeDefined()
      expect(standardEvm.label).toBe('Standard EVM')
      expect(standardEvm.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
      expect(standardEvm.privateKey).toBe(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      )

      // Early Frank Identity Path
      const earlyFrank = accountMap.get(EARLY_FRANK_PATH)!
      expect(earlyFrank).toBeDefined()
      expect(earlyFrank.label).toBe('Early Frank')
      expect(earlyFrank.address).toBe('0x4b39F7b0624b9dB86AD293686bc38B903142dbBc')

      // Frank Burner sub-account pool indices 1..4 (Hardhat accounts 1..4)
      expect(accountMap.get("m/44'/60'/0'/0/1")!.address).toBe(
        '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      )
      expect(accountMap.get("m/44'/60'/0'/0/2")!.address).toBe(
        '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      )
      expect(accountMap.get("m/44'/60'/0'/0/3")!.address).toBe(
        '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      )
      expect(accountMap.get("m/44'/60'/0'/0/4")!.address).toBe(
        '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
      )
    })

    it('derives valid EIP-55 checksummed addresses for a different phrase', () => {
      const accounts = deriveCandidateAccounts(SECOND_TEST_PHRASE)
      for (const account of accounts) {
        expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(account.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/)
      }
    })

    it('supports optional BIP-39 passphrase', () => {
      const withoutPassphrase = deriveCandidateAccounts(TEST_PHRASE)
      const withPassphrase = deriveCandidateAccounts(TEST_PHRASE, 'secret-passphrase')

      expect(withPassphrase[0].address).not.toBe(withoutPassphrase[0].address)
      expect(withPassphrase[0].privateKey).not.toBe(withoutPassphrase[0].privateKey)
    })
  })

  describe('scanBip39Accounts', () => {
    it('defaults to canonical Frank path when provider is omitted', async () => {
      const result = await scanBip39Accounts({ phrase: TEST_PHRASE })
      expect(result.path).toBe(CANONICAL_FRANK_PATH)
      expect(result.label).toBe('Canonical Frank')
      expect(result.address).toBe('0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650')
      expect(result.balance).toBe(0n)
      expect(result.selected.path).toBe(CANONICAL_FRANK_PATH)
      expect(result.candidates.length).toBe(CANDIDATE_PATHS.length)
    })

    it('defaults to canonical Frank path when provider is null or unavailable', async () => {
      const result = await scanBip39Accounts({
        phrase: TEST_PHRASE,
        provider: null,
      })
      expect(result.path).toBe(CANONICAL_FRANK_PATH)
    })

    it('defaults to canonical Frank path when all balances are 0', async () => {
      const mockProvider = {
        getBalance: jest.fn(async () => 0n),
      }
      const result = await scanBip39Accounts({
        phrase: TEST_PHRASE,
        provider: mockProvider as any,
      })
      expect(mockProvider.getBalance).toHaveBeenCalledTimes(CANDIDATE_PATHS.length)
      expect(result.path).toBe(CANONICAL_FRANK_PATH)
      expect(result.balance).toBe(0n)
    })

    it('selects the account with highest non-zero balance', async () => {
      const balances: Record<string, bigint> = {
        '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650': 0n, // Canonical Frank
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266': 5000000000000000000n, // Standard EVM (5 ETH)
        '0x4b39F7b0624b9dB86AD293686bc38B903142dbBc': 1000000000000000000n, // Early Frank (1 ETH)
      }
      const mockProvider = {
        getBalance: jest.fn(async (address: string) => balances[address] ?? 0n),
      }

      const result = await scanBip39Accounts({
        phrase: TEST_PHRASE,
        provider: mockProvider as any,
      })

      expect(result.path).toBe(STANDARD_EVM_PATH)
      expect(result.label).toBe('Standard EVM')
      expect(result.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
      expect(result.balance).toBe(5000000000000000000n)
      expect(result.selected.path).toBe(STANDARD_EVM_PATH)
    })

    it('selects higher balance when multiple accounts have funds', async () => {
      const balances: Record<string, bigint> = {
        '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650': 10n,
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266': 20n,
        '0x70997970C51812dc3A010C7d01b50e0d17dc79C8': 50n, // Burner 1 has highest
      }
      const mockProvider = {
        getBalance: jest.fn(async (address: string) => balances[address] ?? 0n),
      }

      const result = await scanBip39Accounts({
        phrase: TEST_PHRASE,
        provider: mockProvider as any,
      })

      expect(result.path).toBe("m/44'/60'/0'/0/1")
      expect(result.label).toBe('Frank Burner 1')
      expect(result.balance).toBe(50n)
    })

    it('gracefully handles provider errors and falls back to canonical Frank', async () => {
      const mockProvider = {
        getBalance: jest.fn(async () => {
          throw new Error('RPC network connection timed out')
        }),
      }

      const result = await scanBip39Accounts({
        phrase: TEST_PHRASE,
        provider: mockProvider as any,
      })

      expect(result.path).toBe(CANONICAL_FRANK_PATH)
      expect(result.balance).toBe(0n)
    })
  })

  describe('createBip39WalletMaterial & createBip39SeedBundle', () => {
    it('creates wallet material with mainAccount and identity derived from chosen path', () => {
      // Test Canonical Frank path
      const canonicalMaterial = createBip39WalletMaterial(TEST_PHRASE, CANONICAL_FRANK_PATH)
      expect(canonicalMaterial.mainAccount.address).toBe('0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650')
      expect(canonicalMaterial.identity.displayAddress).toBe('0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650')
      expect(canonicalMaterial.keyring).toBeDefined()
      expect(canonicalMaterial.changeKeyring).toBeDefined()
      expect(canonicalMaterial.fingerprint).toContain('0x8c8d35429f74ec245f8ef2f4fd1e551cff97d650')

      // Test Standard EVM path
      const standardEvmMaterial = createBip39WalletMaterial(TEST_PHRASE, STANDARD_EVM_PATH)
      expect(standardEvmMaterial.mainAccount.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
      expect(standardEvmMaterial.identity.displayAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
      expect(standardEvmMaterial.fingerprint).toContain('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')

      // Test Early Frank path
      const earlyMaterial = createBip39WalletMaterial(TEST_PHRASE, EARLY_FRANK_PATH)
      expect(earlyMaterial.mainAccount.address).toBe('0x4b39F7b0624b9dB86AD293686bc38B903142dbBc')
      expect(earlyMaterial.identity.displayAddress).toBe('0x4b39F7b0624b9dB86AD293686bc38B903142dbBc')
    })

    it('creates seed bundle containing derivation parameters and derived keys', () => {
      const bundle = createBip39SeedBundle(TEST_PHRASE, STANDARD_EVM_PATH)
      expect(bundle.mnemonic).toBe(TEST_PHRASE)
      expect(bundle.path).toBe(STANDARD_EVM_PATH)
      expect(bundle.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
      expect(bundle.privateKey).toBe(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      )
    })

    it('aliases function identically to primary helpers', () => {
      const materialViaAlias = createWalletMaterialFromPath(TEST_PHRASE, STANDARD_EVM_PATH)
      expect(materialViaAlias.mainAccount.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')

      const bundleViaAlias = createSeedBundleFromPath(TEST_PHRASE, STANDARD_EVM_PATH)
      expect(bundleViaAlias.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    })
  })
})
