import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import {
  createSwapHandshakePlugin,
  DEFAULT_SWAP_LEASE_DURATION_MS,
  deriveSwapSecrets,
  encodeSwapHandshakePayload,
   decodeSwapHandshakePayload,
  extractSwapHandshakePayload,
  foldSwapHandshakeState,
  formatSwapLegAmount,
  parseSwapHandshakeApplicationItem,
  SWAP_HANDSHAKE_PLUGIN_ID,
  SWAP_HANDSHAKE_SCHEMA_VERSION,
  toSwapHandshakeApplicationItem,
  validateSwapHandshakePayload,
  verifyPreimageAgainstHashlock,
  type SwapHandshakePayload,
  type SwapLegSpec,
} from './index'

const sampleMasterSeed = sha256(utf8ToBytes('frank-test-master-seed-1705'))

const giveLeg: SwapLegSpec = {
  chainKey: 'monad',
  assetSymbol: 'MON',
  amountAtomic: '25000000000000000000', // 25 MON
  decimals: 18,
  recipientAddress: '0x2222222222222222222222222222222222222222',
}

const wantLeg: SwapLegSpec = {
  chainKey: 'solana',
  assetSymbol: 'SOL',
  amountAtomic: '1500000000', // 1.5 SOL
  decimals: 9,
  recipientAddress: 'So11111111111111111111111111111111111111112',
}

function makeProposalPayload(
  overrides: Partial<SwapHandshakePayload> = {},
): SwapHandshakePayload {
  const secrets = deriveSwapSecrets({
    masterSeed: sampleMasterSeed,
    swapId: overrides.swapId ?? 'swap_otc_1705_demo',
    role: 'maker',
  })
  return {
    schemaVersion: SWAP_HANDSHAKE_SCHEMA_VERSION,
    swapId: 'swap_otc_1705_demo',
    mode: 'atomic_swap',
    action: 'propose',
    sequence: 0,
    executorDeviceId: 'device-phone-1',
    leaseExpiresAtMs: 1_700_000_060_000,
    makerAddress: '0x1111111111111111111111111111111111111111',
    takerAddress: '0x2222222222222222222222222222222222222222',
    giveLeg,
    wantLeg,
    hashlockSha256Hex: secrets.hashlockSha256Hex,
    timelockExpiresAtMs: 1_700_003_600_000,
    memo: 'Cross-chain OTC swap 25 MON for 1.5 SOL',
    ...overrides,
  }
}

describe('swap-handshake-v1 message-item plugin (#1705)', () => {
  describe('deterministic per-swap secret derivation (multi-device safe)', () => {
    it('derives identical preimage, hashlock, adaptor scalar, and signing seed across devices from masterSeed + swapId + role', () => {
      const phoneSecrets = deriveSwapSecrets({
        masterSeed: sampleMasterSeed,
        swapId: 'swap_otc_1705_demo',
        role: 'maker',
      })
      const laptopSecrets = deriveSwapSecrets({
        masterSeed: new Uint8Array(sampleMasterSeed),
        swapId: 'swap_otc_1705_demo',
        role: 'maker',
      })

      expect(phoneSecrets.preimage).toHaveLength(32)
      expect(phoneSecrets.hashlockSha256).toHaveLength(32)
      expect(phoneSecrets.adaptorSecretScalar).toHaveLength(32)
      expect(phoneSecrets.ephemeralSigningSeed).toHaveLength(32)

      expect(laptopSecrets.preimageHex).toBe(phoneSecrets.preimageHex)
      expect(laptopSecrets.hashlockSha256Hex).toBe(
        phoneSecrets.hashlockSha256Hex,
      )
      expect(laptopSecrets.adaptorSecretScalarHex).toBe(
        phoneSecrets.adaptorSecretScalarHex,
      )
      expect(laptopSecrets.ephemeralSigningSeedHex).toBe(
        phoneSecrets.ephemeralSigningSeedHex,
      )

      // Verify hashlock is SHA-256(preimage)
      expect(bytesToHex(sha256(phoneSecrets.preimage))).toBe(
        phoneSecrets.hashlockSha256Hex,
      )
      expect(
        verifyPreimageAgainstHashlock(
          phoneSecrets.preimageHex,
          phoneSecrets.hashlockSha256Hex,
        ),
      ).toBe(true)
    })

    it('domain-separates secrets by swapId and role', () => {
      const makerSwapA = deriveSwapSecrets({
        masterSeed: sampleMasterSeed,
        swapId: 'swap_alpha',
        role: 'maker',
      })
      const takerSwapA = deriveSwapSecrets({
        masterSeed: sampleMasterSeed,
        swapId: 'swap_alpha',
        role: 'taker',
      })
      const makerSwapB = deriveSwapSecrets({
        masterSeed: sampleMasterSeed,
        swapId: 'swap_beta',
        role: 'maker',
      })

      expect(makerSwapA.preimageHex).not.toBe(takerSwapA.preimageHex)
      expect(makerSwapA.preimageHex).not.toBe(makerSwapB.preimageHex)
      expect(makerSwapA.hashlockSha256Hex).not.toBe(
        makerSwapB.hashlockSha256Hex,
      )
    })

    it('rejects short or invalid masterSeed', () => {
      expect(() =>
        deriveSwapSecrets({
          masterSeed: new Uint8Array(8),
          swapId: 'swap_short_seed',
          role: 'maker',
        }),
      ).toThrow(/masterSeed/)
    })
  })

  describe('wire codec and application item wrapping', () => {
    it('round-trips SwapHandshakePayload through canonical CBOR and application item helpers', () => {
      const plugin = createSwapHandshakePlugin()
      const proposal = makeProposalPayload()

      const encoded = encodeSwapHandshakePayload(proposal)
      const decoded = decodeSwapHandshakePayload(encoded)
      expect(decoded).toEqual(proposal)

      const appItem = toSwapHandshakeApplicationItem(proposal)
      expect(appItem.type).toBe('application')
      expect(appItem.itemType).toBe(SWAP_HANDSHAKE_PLUGIN_ID)

      expect(parseSwapHandshakeApplicationItem(appItem)).toEqual(proposal)
      expect(extractSwapHandshakePayload(appItem)).toEqual(proposal)
      expect(plugin.decode(plugin.encode(appItem))).toEqual(proposal)
      expect(plugin.previewText(appItem)).toContain('25 MON ↔ 1.5 SOL')
      expect(formatSwapLegAmount(giveLeg.amountAtomic, giveLeg.decimals)).toBe(
        '25',
      )
      expect(formatSwapLegAmount(wantLeg.amountAtomic, wantLeg.decimals)).toBe(
        '1.5',
      )
    })

    it('rejects malformed payloads and unknown properties', () => {
      expect(() =>
        validateSwapHandshakePayload({
          ...makeProposalPayload(),
          unexpectedField: true,
        }),
      ).toThrow(/Unexpected/)

      expect(() =>
        validateSwapHandshakePayload({
          ...makeProposalPayload(),
          hashlockSha256Hex: 'deadbeef',
        }),
      ).toThrow(/64 hexadecimal/)

      expect(() =>
        validateSwapHandshakePayload({
          ...makeProposalPayload(),
          sequence: -1,
        }),
      ).toThrow(/sequence/)

      expect(extractSwapHandshakePayload({ type: 'text', text: 'hi' })).toBe(
        null,
      )
    })
  })

  describe('transcript folding & preimage verification (foldSwapHandshakeState)', () => {
    it('folds propose -> accept_and_lock -> counter_lock -> settle_claim when preimage matches hashlock', () => {
      const secrets = deriveSwapSecrets({
        masterSeed: sampleMasterSeed,
        swapId: 'swap_otc_1705_demo',
        role: 'maker',
      })
      const baseTime = 1_700_000_000_000
      const leaseExpiry = baseTime + DEFAULT_SWAP_LEASE_DURATION_MS

      const step0 = makeProposalPayload({
        sequence: 0,
        executorDeviceId: 'maker-phone',
        leaseExpiresAtMs: leaseExpiry,
        hashlockSha256Hex: secrets.hashlockSha256Hex,
      })

      const step1: SwapHandshakePayload = {
        schemaVersion: 1,
        swapId: step0.swapId,
        mode: 'atomic_swap',
        action: 'accept_and_lock',
        sequence: 1,
        executorDeviceId: 'maker-phone',
        leaseExpiresAtMs: leaseExpiry + 30_000,
        lockTxHash: '0xmakerlocktx111',
      }

      const step2: SwapHandshakePayload = {
        schemaVersion: 1,
        swapId: step0.swapId,
        mode: 'atomic_swap',
        action: 'counter_lock',
        sequence: 2,
        executorDeviceId: 'taker-desktop',
        leaseExpiresAtMs: leaseExpiry + 60_000,
        counterLockTxHash: '0xtakerlocktx222',
      }

      const bothLocked = foldSwapHandshakeState([step0, step1, step2], {
        localDeviceId: 'maker-phone',
        localRole: 'maker',
        nowMs: baseTime + 10_000,
      })
      expect(bothLocked?.phase).toBe('both_locked')
      expect(bothLocked?.makerLockTxHash).toBe('0xmakerlocktx111')
      expect(bothLocked?.takerLockTxHash).toBe('0xtakerlocktx222')
      expect(bothLocked?.availableActions).toEqual(['settle_claim', 'refund'])

      const step3: SwapHandshakePayload = {
        schemaVersion: 1,
        swapId: step0.swapId,
        mode: 'atomic_swap',
        action: 'settle_claim',
        sequence: 3,
        executorDeviceId: 'maker-phone',
        leaseExpiresAtMs: leaseExpiry + 90_000,
        settleTxHash: '0xsettletx333',
        revealedPreimageHex: secrets.preimageHex,
      }

      const settled = foldSwapHandshakeState([step0, step1, step2, step3], {
        localDeviceId: 'maker-phone',
        localRole: 'maker',
        nowMs: baseTime + 20_000,
      })
      expect(settled?.phase).toBe('settled')
      expect(settled?.settleTxHash).toBe('0xsettletx333')
      expect(settled?.revealedPreimageHex).toBe(secrets.preimageHex)
      expect(settled?.availableActions).toEqual([])
    })

    it('rejects settle_claim when revealedPreimageHex does not hash to hashlockSha256Hex', () => {
      const secrets = deriveSwapSecrets({
        masterSeed: sampleMasterSeed,
        swapId: 'swap_otc_1705_demo',
        role: 'maker',
      })
      const wrongSecrets = deriveSwapSecrets({
        masterSeed: sampleMasterSeed,
        swapId: 'swap_wrong_id',
        role: 'maker',
      })

      const step0 = makeProposalPayload({
        sequence: 0,
        hashlockSha256Hex: secrets.hashlockSha256Hex,
      })
      const step1: SwapHandshakePayload = {
        schemaVersion: 1,
        swapId: step0.swapId,
        mode: 'atomic_swap',
        action: 'accept_and_lock',
        sequence: 1,
        executorDeviceId: 'device-phone-1',
        leaseExpiresAtMs: 1_700_000_060_000,
        lockTxHash: '0xmakerlock',
      }
      const step2: SwapHandshakePayload = {
        schemaVersion: 1,
        swapId: step0.swapId,
        mode: 'atomic_swap',
        action: 'counter_lock',
        sequence: 2,
        executorDeviceId: 'device-taker-1',
        leaseExpiresAtMs: 1_700_000_060_000,
        counterLockTxHash: '0xtakerlock',
      }
      const forgedSettle: SwapHandshakePayload = {
        schemaVersion: 1,
        swapId: step0.swapId,
        mode: 'atomic_swap',
        action: 'settle_claim',
        sequence: 3,
        executorDeviceId: 'device-phone-1',
        leaseExpiresAtMs: 1_700_000_060_000,
        settleTxHash: '0xforgedsettle',
        revealedPreimageHex: wrongSecrets.preimageHex,
      }

      const folded = foldSwapHandshakeState(
        [step0, step1, step2, forgedSettle],
        {
          localDeviceId: 'device-phone-1',
          nowMs: 1_700_000_010_000,
        },
      )

      expect(folded?.phase).toBe('both_locked')
      expect(folded?.settleTxHash).toBeNull()
      expect(folded?.revealedPreimageHex).toBeNull()
    })

    it('enforces multi-device execution leases and allows failover takeover after lease expiry', () => {
      const baseTime = 1_700_000_000_000
      const leaseExpiresAtMs = baseTime + DEFAULT_SWAP_LEASE_DURATION_MS

      const step0 = makeProposalPayload({
        sequence: 0,
        executorDeviceId: 'device-phone',
        leaseExpiresAtMs,
      })

      // 1. On active leader device ('device-phone') before lease expiry -> can execute
      const leaderView = foldSwapHandshakeState([step0], {
        localDeviceId: 'device-phone',
        nowMs: baseTime + 15_000,
      })
      expect(leaderView?.makerLease).toEqual({
        executorDeviceId: 'device-phone',
        leaseExpiresAtMs,
        isLocalDeviceLeader: true,
        isLeaseExpired: false,
        canLocalDeviceExecute: true,
        requiresFailoverTakeover: false,
      })
      expect(leaderView?.availableActions).toEqual([
        'accept_and_lock',
        'cancel',
      ])

      // 2. On secondary device ('device-laptop') BEFORE lease expiry -> blocked from double-broadcast
      const followerBlockedView = foldSwapHandshakeState([step0], {
        localDeviceId: 'device-laptop',
        nowMs: baseTime + 15_000,
      })
      expect(followerBlockedView?.makerLease).toEqual({
        executorDeviceId: 'device-phone',
        leaseExpiresAtMs,
        isLocalDeviceLeader: false,
        isLeaseExpired: false,
        canLocalDeviceExecute: false,
        requiresFailoverTakeover: false,
      })
      expect(followerBlockedView?.availableActions).toEqual([])

      // 3. On secondary device ('device-laptop') AFTER lease expiry -> requiresFailoverTakeover & can execute
      const followerExpiredView = foldSwapHandshakeState([step0], {
        localDeviceId: 'device-laptop',
        nowMs: leaseExpiresAtMs + 1_000,
      })
      expect(followerExpiredView?.makerLease).toEqual({
        executorDeviceId: 'device-phone',
        leaseExpiresAtMs,
        isLocalDeviceLeader: false,
        isLeaseExpired: true,
        canLocalDeviceExecute: true,
        requiresFailoverTakeover: true,
      })
      expect(followerExpiredView?.availableActions).toEqual([
        'accept_and_lock',
        'cancel',
      ])

      // 4. Secondary device emits lease_heartbeat to claim leadership
      const takeoverHeartbeat: SwapHandshakePayload = {
        schemaVersion: 1,
        swapId: step0.swapId,
        mode: 'atomic_swap',
        action: 'lease_heartbeat',
        sequence: 1,
        executorDeviceId: 'device-laptop',
        leaseExpiresAtMs: leaseExpiresAtMs + DEFAULT_SWAP_LEASE_DURATION_MS,
      }

      const afterTakeoverLaptop = foldSwapHandshakeState(
        [step0, takeoverHeartbeat],
        {
          localDeviceId: 'device-laptop',
          nowMs: leaseExpiresAtMs + 5_000,
        },
      )
      expect(afterTakeoverLaptop?.makerLease?.isLocalDeviceLeader).toBe(true)
      expect(afterTakeoverLaptop?.makerLease?.requiresFailoverTakeover).toBe(
        false,
      )
      expect(afterTakeoverLaptop?.makerLease?.canLocalDeviceExecute).toBe(true)

      const afterTakeoverPhone = foldSwapHandshakeState(
        [step0, takeoverHeartbeat],
        {
          localDeviceId: 'device-phone',
          nowMs: leaseExpiresAtMs + 5_000,
        },
      )
      expect(afterTakeoverPhone?.makerLease?.isLocalDeviceLeader).toBe(false)
      expect(afterTakeoverPhone?.makerLease?.canLocalDeviceExecute).toBe(false)
      expect(afterTakeoverPhone?.availableActions).toEqual([])
    })
  })
})
