import { computeAddress, SigningKey } from 'ethers'
import {
  CLAIM_HASH_PARAM,
  CLAIM_LINK_VERSION,
  calculateClaimFundingBreakdown,
  createClaimLink,
  deriveClaimBearerAccount,
  evaluateClaimBearerState,
  hasClaimLinkInHash,
  netSweepableAmountWei,
  parseClaimLink,
} from './index'

describe('Zero-backend Ephemeral Bearer Claim Links (#1706)', () => {
  const fixedSeed16 = Uint8Array.from([
    0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb,
    0xdc, 0xed, 0xfe, 0x0f,
  ])

  const fixedSeed32 = Uint8Array.from([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
    0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
    0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
  ])

  describe('deriveClaimBearerAccount', () => {
    it('deterministically derives a valid secp256k1 keypair, EIP-55 address, AEAD key, and claimIdHex', () => {
      const account1 = deriveClaimBearerAccount(fixedSeed16)
      const account2 = deriveClaimBearerAccount(fixedSeed16)

      expect(account1).toEqual(account2)
      expect(account1.privateKeyHex).toMatch(/^[0-9a-f]{64}$/)
      expect(account1.publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/)
      expect(account1.claimIdHex).toMatch(/^[0-9a-f]{32}$/)
      expect(account1.noteEncryptionKey).toBeInstanceOf(Uint8Array)
      expect(account1.noteEncryptionKey.length).toBe(32)

      // Cross-verify EIP-55 checksummed address and compressed public key against ethers SigningKey
      const signingKey = new SigningKey('0x' + account1.privateKeyHex)
      expect('0x' + account1.publicKeyHex).toBe(
        signingKey.compressedPublicKey.toLowerCase(),
      )
      const expectedChecksumAddress = computeAddress(
        '0x' + account1.privateKeyHex,
      )
      expect(account1.evmAddress).toBe(expectedChecksumAddress)
      expect(account1.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('supports 32-byte seeds and produces distinct keys from 16-byte seeds', () => {
      const account16 = deriveClaimBearerAccount(fixedSeed16)
      const account32 = deriveClaimBearerAccount(fixedSeed32)

      expect(account32.evmAddress).not.toBe(account16.evmAddress)
      expect(account32.claimIdHex).not.toBe(account16.claimIdHex)
      expect(account32.evmAddress).toBe(
        computeAddress('0x' + account32.privateKeyHex),
      )
    })

    it('rejects seed lengths other than 16 or 32 bytes', () => {
      expect(() => deriveClaimBearerAccount(new Uint8Array(0))).toThrow(
        /16-byte or 32-byte/,
      )
      expect(() => deriveClaimBearerAccount(new Uint8Array(15))).toThrow(
        /16-byte or 32-byte/,
      )
      expect(() => deriveClaimBearerAccount(new Uint8Array(24))).toThrow(
        /16-byte or 32-byte/,
      )
    })
  })

  describe('createClaimLink & parseClaimLink round-trip and URL fragment privacy', () => {
    it('round-trips full URL, #claim=... hash, and raw token with all metadata fields', () => {
      const created = createClaimLink({
        seedBytes: fixedSeed16,
        chainKey: 'monad',
        senderAddress: '0x1111111111111111111111111111111111111111',
        senderName: 'Alice',
        amountAtomic: 250_000_000_000_000_000n,
        note: 'Welcome to Frank! Grab a coffee on me ☕',
        createdAtMs: 1_700_000_000_000,
        expiresAtMs: 1_700_086_400_000,
      })

      expect(created.metadata.version).toBe(CLAIM_LINK_VERSION)
      expect(created.url.startsWith('https://signet.mx/#claim=')).toBe(true)

      const fromFullUrl = parseClaimLink(created.url)
      const fromLocationHash = parseClaimLink(
        `#${CLAIM_HASH_PARAM}=${created.fragmentToken}`,
      )
      const fromRawToken = parseClaimLink(created.fragmentToken)

      expect(fromFullUrl).not.toBeNull()
      expect(fromLocationHash).toEqual(fromFullUrl)
      expect(fromRawToken).toEqual(fromFullUrl)

      expect(fromFullUrl?.bearerAccount.evmAddress).toBe(
        created.bearerAccount.evmAddress,
      )
      expect(fromFullUrl?.bearerAccount.privateKeyHex).toBe(
        created.bearerAccount.privateKeyHex,
      )
      expect(fromFullUrl?.bearerAccount.claimIdHex).toBe(
        created.bearerAccount.claimIdHex,
      )
      expect(fromFullUrl?.chainKey).toBe('monad')
      expect(fromFullUrl?.senderAddress).toBe(
        '0x1111111111111111111111111111111111111111',
      )
      expect(fromFullUrl?.senderName).toBe('Alice')
      expect(fromFullUrl?.amountAtomic).toBe(250_000_000_000_000_000n)
      expect(fromFullUrl?.note).toBe('Welcome to Frank! Grab a coffee on me ☕')
      expect(fromFullUrl?.createdAtMs).toBe(1_700_000_000_000)
      expect(fromFullUrl?.expiresAtMs).toBe(1_700_086_400_000)
    })

    it('places the bearer secret strictly in the URL fragment (#claim=) and never in path or query string', () => {
      const created = createClaimLink({
        senderAddress: '0x2222222222222222222222222222222222222222',
        amountAtomic: 1_000_000_000_000_000n,
      })

      const parsedUrl = new URL(created.url)
      expect(parsedUrl.pathname).toBe('/')
      expect(parsedUrl.search).toBe('')
      expect(parsedUrl.hash).toBe(`#claim=${created.fragmentToken}`)
      expect(hasClaimLinkInHash(parsedUrl.hash)).toBe(true)

      // Must reject tokens leaked in query strings (?claim=...) so callers never accept server-visible links
      const leakedQueryUrl = `https://signet.mx/?claim=${created.fragmentToken}`
      expect(parseClaimLink(leakedQueryUrl)).toBeNull()
      expect(parseClaimLink(`?claim=${created.fragmentToken}`)).toBeNull()
      expect(hasClaimLinkInHash(`?claim=${created.fragmentToken}`)).toBe(false)
      expect(hasClaimLinkInHash('')).toBe(false)
      expect(hasClaimLinkInHash('#other=1')).toBe(false)
    })

    it('rejects any AEAD tampering across every character of the fragment token', () => {
      const created = createClaimLink({
        seedBytes: fixedSeed16,
        senderAddress: '0x3333333333333333333333333333333333333333',
        senderName: 'Bob',
        amountAtomic: 50_000_000_000_000_000n,
        note: 'Untampered secret note',
        createdAtMs: 1_700_000_000_000,
      })

      const token = created.fragmentToken
      // Flip every single character position in the token and verify parseClaimLink returns null
      for (let i = 0; i < token.length; i++) {
        const originalChar = token[i]
        const replacementChar = originalChar === 'A' ? 'B' : 'A'
        const tamperedToken =
          token.slice(0, i) + replacementChar + token.slice(i + 1)
        expect(parseClaimLink(tamperedToken)).toBeNull()
      }

      // Truncated or extended tokens also fail
      expect(parseClaimLink(token.slice(0, -1))).toBeNull()
      expect(parseClaimLink(token + 'A')).toBeNull()
    })
  })

  describe('calculateClaimFundingBreakdown & evaluateClaimBearerState', () => {
    it('calculates gift amount + sweep gas reserve + first-reply stamp reserve accurately', () => {
      const giftAmountWei = 100_000_000_000_000_000n // 0.1 MON
      const gasPriceWei = 50_000_000_000n // 50 gwei
      const replyStampWei = 2_000_000_000_000_000n // 0.002 MON per reply

      const breakdown = calculateClaimFundingBreakdown({
        giftAmountWei,
        gasPriceWei,
        replyStampWei,
        replyCount: 2,
      })

      expect(breakdown.sweepGasLimit).toBe(21_000n)
      expect(breakdown.sweepFeeReserveWei).toBe(21_000n * 50_000_000_000n)
      expect(breakdown.replyStampReserveWei).toBe(4_000_000_000_000_000n)
      expect(breakdown.totalFundingRequiredWei).toBe(
        giftAmountWei + breakdown.sweepFeeReserveWei + 4_000_000_000_000_000n,
      )

      // When the bearer EOA holds totalFundingRequiredWei and sweeps at the same gas price,
      // the recipient receives exact giftAmountWei + replyStampReserveWei
      const netReceived = breakdown.netSweepableAmountWei(
        breakdown.totalFundingRequiredWei,
        gasPriceWei,
      )
      expect(netReceived).toBe(giftAmountWei + breakdown.replyStampReserveWei)
      expect(netSweepableAmountWei(100n, gasPriceWei)).toBe(0n)
    })

    it('evaluates claimable, already_claimed (multi-device dedup), empty_or_swept, and expired_clawback_eligible states', () => {
      const account = deriveClaimBearerAccount(fixedSeed16)
      const gasPriceWei = 50_000_000_000n
      const fundedBalanceWei = 100_000_000_000_000_000n
      const createdAtMs = 1_700_000_000_000
      const expiresAtMs = createdAtMs + 86_400_000

      // 1. Claimable before expiry
      const claimable = evaluateClaimBearerState({
        observedBalanceWei: fundedBalanceWei,
        currentGasPriceWei: gasPriceWei,
        nowMs: createdAtMs + 1_000,
        expiresAtMs,
        claimIdHex: account.claimIdHex,
      })
      expect(claimable).toEqual({
        status: 'claimable',
        netSweepableWei: fundedBalanceWei - 21_000n * gasPriceWei,
        canRecipientClaim: true,
        canSenderClawback: false,
      })

      // 2. Multi-device deduplication: claimIdHex is already in alreadyClaimedIds
      const alreadyClaimed = evaluateClaimBearerState({
        observedBalanceWei: fundedBalanceWei,
        currentGasPriceWei: gasPriceWei,
        nowMs: createdAtMs + 1_000,
        expiresAtMs,
        alreadyClaimedIds: new Set([account.claimIdHex]),
        claimIdHex: account.claimIdHex,
      })
      expect(alreadyClaimed.status).toBe('already_claimed')
      expect(alreadyClaimed.canRecipientClaim).toBe(false)
      expect(alreadyClaimed.canSenderClawback).toBe(false)

      // 3. Empty or already swept on-chain (balance <= gas fee)
      const emptyOrSwept = evaluateClaimBearerState({
        observedBalanceWei: 21_000n * gasPriceWei,
        currentGasPriceWei: gasPriceWei,
        nowMs: createdAtMs + 1_000,
        expiresAtMs,
        claimIdHex: account.claimIdHex,
      })
      expect(emptyOrSwept).toEqual({
        status: 'empty_or_swept',
        netSweepableWei: 0n,
        canRecipientClaim: false,
        canSenderClawback: false,
      })

      // 4. Expired and still funded -> sender clawback eligible
      const expiredClawback = evaluateClaimBearerState({
        observedBalanceWei: fundedBalanceWei,
        currentGasPriceWei: gasPriceWei,
        nowMs: expiresAtMs + 1,
        expiresAtMs,
        claimIdHex: account.claimIdHex,
      })
      expect(expiredClawback).toEqual({
        status: 'expired_clawback_eligible',
        netSweepableWei: fundedBalanceWei - 21_000n * gasPriceWei,
        canRecipientClaim: false,
        canSenderClawback: true,
      })
    })
  })
})
