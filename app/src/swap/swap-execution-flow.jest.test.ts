/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-empty-function */
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  localStorage: dom.window.localStorage,
})
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
})

let mockSession: any
let mockSnapshot: any = null
jest.mock('../accounts/session', () => {
  const actual = jest.requireActual('../accounts/session')
  return {
    ...actual,
    get accountSession() {
      return mockSession
    },
  }
})
jest.mock('../utils/negotiation-recovery', () => ({
  negotiationRecoveryStatus: {
    get snapshot() {
      return mockSnapshot
    },
  },
}))

const { mount, flushPromises } = require('@vue/test-utils')
const { defineComponent, h } = require('vue')
const { addressFromCompressedPubkey, fromHex, toHex } = require('@frank/codec')
const {
  buildNegotiationOffer,
  buildNegotiationResponse,
  TESTNET_NEGOTIATION_POLICY,
} = require('@frank/swap-protocol/src/negotiation')
const { encodeSignedSwapEvent } = require('@frank/swap-protocol/src')
const { activeChain, setActiveChain } = require('@frank/wallet/chain')
const { messagingStateOwner } = require('../utils/messaging-state')
const {
  createSwapExecutionCoordinator,
  installSwapExecutionCoordinator,
  prepareSwapExecution,
  fundSwapExecution,
  reconcileSwapExecution,
} = require('./swap-execution-commands')
const Card = require('./SignedNegotiationCard.vue').default
const en = require('../i18n/en-us').default

const QBtnStub = defineComponent({
  props: ['label', 'disable', 'loading'],
  setup:
    (p: any, { attrs, slots }: any) =>
    () =>
      h('button', { ...attrs, disabled: p.disable || p.loading }, [
        p.label,
        slots.default?.(),
      ]),
})

const translate = (key: string, params: Record<string, unknown> = {}) =>
  String(
    key.split('.').reduce((v: any, k: string) => v?.[k], en) ?? key,
  ).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))

const globalOptions = {
  components: { QBtn: QBtnStub },
  mocks: { $t: translate },
}

const { MonadIdentity: EvmIdentity } = require('@frank/wallet/evm-identity')

describe('SignedNegotiationCard principal execution & recovery flow (S7, S8)', () => {
  const previousChain = { ...activeChain }
  const aliceId = EvmIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`)
  const bobId = EvmIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
  const alicePub = aliceId.compressedPubKey
  const bobPub = bobId.compressedPubKey
  const aliceAddress = aliceId.displayAddress
  const bobAddress = bobId.displayAddress
  const conversationId = '11111111-1111-4111-8111-111111111111'
  const swapId = new Uint8Array(32).fill(0x42)
  const mounted: any[] = []

  let offerHex = ''
  let journalInspection: any

  beforeEach(async () => {
    setActiveChain({
      ...activeChain,
      chainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
    })
    messagingStateOwner.status = 'ready'
    messagingStateOwner.reason = null
    mockSession = {
      state: {
        status: 'ready',
        revision: 1,
        account: {
          receipt: {
            context: { accountId: 'alice-acc' },
            revision: 1,
          },
        },
      },
      getCachedCurvePublicKey: () => alicePub,
    }

    const context = {
      swapId,
      conversationId: fromHex(conversationId.replace(/-/g, '')),
      parties: [alicePub, bobPub] as const,
      policy: TESTNET_NEGOTIATION_POLICY,
    }
    const offerRes = await buildNegotiationOffer(
      context,
      {
        xecPrincipal: 25_000n,
        evmPrincipal: 1_000_000_000_000_000n,
        expiry: 3_000_000_000n,
      },
      async (d: Uint8Array) => new Uint8Array(aliceId.signHash(Buffer.from(d))),
    )
    const offerBytes = encodeSignedSwapEvent(offerRes.value).value
    offerHex = toHex(offerBytes)
    const acceptRes = await buildNegotiationResponse(
      context,
      offerBytes,
      'accept',
      async (d: Uint8Array) => new Uint8Array(bobId.signHash(Buffer.from(d))),
    )
    const acceptBytes = encodeSignedSwapEvent(acceptRes.value).value

    journalInspection = {
      rowKey: 'row-1',
      owner: {
        accountIncarnation: 'alice-acc:1',
        messagingChainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
        localPublicKey: alicePub,
      },
      context,
      entries: [
        {
          eventBytes: offerBytes,
          direction: 'outbound-replay',
          senderPublicKey: alicePub,
          recipientPublicKey: bobPub,
          messageId: new Uint8Array(16).fill(1),
          stampedPayloadDigest: new Uint8Array(32).fill(2),
        },
        {
          eventBytes: acceptBytes,
          direction: 'incoming',
          senderPublicKey: bobPub,
          recipientPublicKey: alicePub,
          messageId: new Uint8Array(16).fill(3),
          stampedPayloadDigest: new Uint8Array(32).fill(4),
        },
      ],
      reduction: {
        violation: null,
        history: {
          offer: {
            kind: 'offer',
            event: offerRes.value,
            terms: {
              xecPrincipal: 25_000n,
              evmPrincipal: 1_000_000_000_000_000n,
              expiry: 3_000_000_000n,
            },
          },
          decision: 'accept',
        },
      },
    }
    mockSnapshot = {
      state: 'ready',
      coverage: 1000,
      journals: [journalInspection],
    }
  })

  afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    installSwapExecutionCoordinator(null)
    mockSnapshot = null
    setActiveChain(previousChain)
  })

  // New swaps are turned off (review A3): the card offers neither Review nor Fund. A swap
  // prepared and funded before that (driven here through the commands) still claims and
  // refunds from the card.
  const prepareEarlierSwap = async () => {
    await prepareSwapExecution({
      swapId: toHex(swapId),
      conversationId,
      peerPublicKey: toHex(bobPub),
      role: 'initiator',
      xecChainIdentifier: TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
      evmChainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
      xecPrincipal: 25_000n,
      evmPrincipal: 1_000_000_000_000_000n,
      expiry: 3_000_000_000,
    })
    await flushPromises()
  }

  test('offers no prepare or fund for a new swap, and an earlier funded swap still claims to completion', async () => {
    const activeHolds = new Set<string>()
    let xecFunding = { status: 'unseen' as const, confirmations: 0 }
    let evmFunding = { status: 'unseen' as const, confirmations: 0 }
    let xecSettlement = {
      effect: 'none' as const,
      status: 'unseen' as const,
      confirmations: 0,
    }
    let evmSettlement = {
      effect: 'none' as const,
      status: 'unseen' as const,
      confirmations: 0,
    }

    createSwapExecutionCoordinator({
      custody: {
        async acquireHold(opId: string) {
          activeHolds.add(opId)
          return { operationId: opId }
        },
        async releaseHold(opId: string) {
          activeHolds.delete(opId)
        },
      },
      xec: {
        async reserveInputs({ principalSats }: { principalSats: bigint }) {
          return {
            inputs: [
              {
                txid: 'cafebabe1234'.padEnd(64, '0'),
                vout: 1,
                valueSats: (principalSats + 400n).toString(),
              },
            ],
            feeSats: 400n,
            fundingTxHex: '0200xecfund',
            fundingTxid: 'aa'.repeat(32),
            claimTxHex: '0200xecclaim',
            claimTxid: 'bb'.repeat(32),
            refundTxHex: '0200xecrefund',
            refundTxid: 'cc'.repeat(32),
          }
        },
        async broadcastTransaction() {
          return { txid: 'aa'.repeat(32) }
        },
        async observeFunding() {
          return xecFunding
        },
        async observeSettlement() {
          return xecSettlement
        },
        async releaseInputs() {},
      },
      evm: {
        async reserveInput() {
          return {
            input: {
              address: '0x1234567890123456789012345678901234567890',
              nonce: 12,
              feeBudgetWei: '42000000000000',
            },
            fundingTxHex: '0x02evmfund',
            fundingTxHash: '0x' + 'dd'.repeat(32),
            claimTxHex: '0x02evmclaim',
            claimTxHash: '0x' + 'ee'.repeat(32),
            refundTxHex: '0x02evmrefund',
            refundTxHash: '0x' + 'ff'.repeat(32),
          }
        },
        async broadcastTransaction() {
          return { txHash: '0x' + 'dd'.repeat(32) }
        },
        async observeFunding() {
          return evmFunding
        },
        async observeSettlement() {
          return evmSettlement
        },
        async releaseInput() {},
      },
    })

    const card = mount(Card, {
      props: {
        item: {
          type: 'application',
          itemType: 'swap-negotiation-v1',
          value: { eventHex: offerHex },
        },
        address: bobAddress,
        senderAddress: aliceAddress,
        outbound: true,
        conversationId,
        deliveryStatus: 'confirmed',
      },
      global: globalOptions,
    })
    mounted.push(card)

    expect(card.find('[data-testid="swap-execution-panel"]').exists()).toBe(
      true,
    )
    expect(card.find('[data-testid="swap-prepare-btn"]').exists()).toBe(false)
    expect(card.find('[data-testid="swap-fund-btn"]').exists()).toBe(false)
    expect(card.find('[data-testid="swap-execution-turned-off"]').text()).toBe(
      en.chatMessageSwap.executionTurnedOff,
    )

    // 1. A swap prepared earlier: inputs reserved and custody hold acquired
    await prepareEarlierSwap()

    expect(activeHolds.size).toBe(1)
    const inputsBox = card.find('[data-testid="swap-selected-inputs"]')
    expect(inputsBox.exists()).toBe(true)
    expect(inputsBox.text()).toContain('cafebabe1234:1 (25400)')
    expect(inputsBox.text()).toContain(
      '0x1234567890123456789012345678901234567890 #12',
    )
    expect(card.find('[data-testid="swap-fund-btn"]').exists()).toBe(false)
    expect(card.find('[data-testid="swap-cancel-btn"]').exists()).toBe(true)

    // 2. Funded & locked on both legs earlier
    xecFunding = { status: 'included', confirmations: 10 }
    evmFunding = { status: 'included', confirmations: 10 }
    await fundSwapExecution(toHex(swapId))
    await flushPromises()
    expect(
      card.find('[data-testid="swap-execution-turned-off"]').exists(),
    ).toBe(false)

    expect(card.find('[data-testid="swap-execution-status"]').text()).toBe(
      en.chatMessageSwap.statusLocked,
    )
    expect(card.find('[data-testid="swap-cancel-btn"]').exists()).toBe(false)
    expect(card.find('[data-testid="swap-claim-btn"]').exists()).toBe(true)

    // 3. Claim funds and reach 10-block finality
    xecSettlement = {
      effect: 'claim',
      status: 'included',
      confirmations: 10,
    }
    evmSettlement = {
      effect: 'claim',
      status: 'included',
      confirmations: 10,
    }
    await card.find('[data-testid="swap-claim-btn"]').trigger('click')
    await flushPromises()

    expect(card.find('[data-testid="swap-execution-status"]').text()).toBe(
      en.chatMessageSwap.statusWithdrawn,
    )
    expect(activeHolds.size).toBe(0)
  })

  test('the live app runtime refuses to start a new swap execution (A3)', async () => {
    const {
      startAppSwapExecution,
      SwapExecutionDisabledError,
    } = require('./live-swap-execution')
    const { swapExecutionState } = require('./swap-execution-commands')
    const runtime = startAppSwapExecution({
      wallet: {
        chainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
        identity: { compressedPubKey: alicePub },
      },
      revision: 1,
      account: {
        receipt: { context: { accountId: 'alice-acc' }, revision: 1 },
      },
    })
    try {
      // The coordinator stays installed so swaps funded earlier can still be refunded.
      expect(swapExecutionState.coordinator).not.toBeNull()
      const refused = prepareEarlierSwap()
      await expect(refused).rejects.toBeInstanceOf(SwapExecutionDisabledError)
      expect(Object.keys(swapExecutionState.records)).toHaveLength(0)
    } finally {
      await runtime.stop()
    }
  })

  test('displays deep-reorg warning and enables unilateral refund when reorg exceeds 10 blocks', async () => {
    let xecFunding: any = { status: 'included', confirmations: 10 }
    const evmFunding: any = { status: 'included', confirmations: 10 }
    let xecSettlement: any = {
      effect: 'none',
      status: 'unseen',
      confirmations: 0,
    }
    let evmSettlement: any = {
      effect: 'none',
      status: 'unseen',
      confirmations: 0,
    }

    createSwapExecutionCoordinator({
      custody: {
        async acquireHold(opId: string) {
          return { operationId: opId }
        },
        async releaseHold() {},
      },
      xec: {
        async reserveInputs({ principalSats }: { principalSats: bigint }) {
          return {
            inputs: [
              {
                txid: 'deadbeef0000'.padEnd(64, '0'),
                vout: 0,
                valueSats: principalSats.toString(),
              },
            ],
            feeSats: 300n,
            fundingTxHex: '0200xecfund',
            fundingTxid: 'aa'.repeat(32),
            claimTxHex: '0200xecclaim',
            claimTxid: 'bb'.repeat(32),
            refundTxHex: '0200xecrefund',
            refundTxid: 'cc'.repeat(32),
          }
        },
        async broadcastTransaction() {
          return { txid: 'aa'.repeat(32) }
        },
        async observeFunding() {
          return xecFunding
        },
        async observeSettlement() {
          return xecSettlement
        },
        async releaseInputs() {},
      },
      evm: {
        async reserveInput() {
          return {
            input: {
              address: '0x9999999999999999999999999999999999999999',
              nonce: 3,
              feeBudgetWei: '21000000000000',
            },
            fundingTxHex: '0x02evmfund',
            fundingTxHash: '0x' + 'dd'.repeat(32),
            claimTxHex: '0x02evmclaim',
            claimTxHash: '0x' + 'ee'.repeat(32),
            refundTxHex: '0x02evmrefund',
            refundTxHash: '0x' + 'ff'.repeat(32),
          }
        },
        async broadcastTransaction() {
          return { txHash: '0x' + 'dd'.repeat(32) }
        },
        async observeFunding() {
          return evmFunding
        },
        async observeSettlement() {
          return evmSettlement
        },
        async releaseInput() {},
      },
    })

    const card = mount(Card, {
      props: {
        item: {
          type: 'application',
          itemType: 'swap-negotiation-v1',
          value: { eventHex: offerHex },
        },
        address: bobAddress,
        senderAddress: aliceAddress,
        outbound: true,
        conversationId,
        deliveryStatus: 'confirmed',
      },
      global: globalOptions,
    })
    mounted.push(card)

    await prepareEarlierSwap()
    await fundSwapExecution(toHex(swapId))
    await flushPromises()

    // Trigger >10-block deep reorg on XEC leg
    xecFunding = { status: 'included', confirmations: 1, revertedDepth: 12 }
    await reconcileSwapExecution(toHex(swapId))
    await flushPromises()

    const alert = card.find('[data-testid="swap-reorg-warning"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('deep-reorg-exceeded-finality')
    expect(card.find('[data-testid="swap-refund-btn"]').exists()).toBe(true)

    xecSettlement = {
      effect: 'refund',
      status: 'final',
      confirmations: 10,
    }
    evmSettlement = {
      effect: 'refund',
      status: 'final',
      confirmations: 10,
    }
    await card.find('[data-testid="swap-refund-btn"]').trigger('click')
    await flushPromises()
    expect(card.find('[data-testid="swap-execution-status"]').text()).toBe(
      en.chatMessageSwap.statusRefunded,
    )
  })
})
