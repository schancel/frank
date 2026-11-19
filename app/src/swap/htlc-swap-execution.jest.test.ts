/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * The session's HTLC swap runner and the swap card that reads it.
 *
 * The runner is composed and stopped by the session (`startAppSwapExecution`), not by the card:
 * with no card mounted, and after a reload (a new composition over the same swap records), B
 * still claims and A still refunds. The chains and wallets are stubbed at the runner's capability
 * seam only to drive those steps; the swap itself runs on real nodes in
 * packages/bot/demo/regtest/htlc-swap.livecheck.ts (`yarn --cwd packages/bot regtest:htlc-swap`).
 */
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
const { sha256 } = require('@noble/hashes/sha256.js')
const { hmac } = require('@noble/hashes/hmac.js')
const { bytesToHex } = require('@noble/hashes/utils.js')
const {
  TESTNET_NEGOTIATION_POLICY,
  buildNegotiationOffer,
  buildNegotiationResponse,
  deriveOfferSwapId,
  reduceNegotiationStandalone,
} = require('@frank/swap-protocol/src/negotiation')
const { encodeSignedSwapEvent } = require('@frank/swap-protocol/src')
const {
  FIXTURE_XEC_CLAIM_KEY,
  FIXTURE_XEC_REFUND_KEY,
  fixtureAccept,
  fixtureOfferFields,
} = require('@frank/swap-protocol/src/negotiation-fixtures.testutil')
const { htlcSwapTermsOf } = require('@frank/swap-protocol/src/htlc-swap')
const {
  MemoryHtlcSwapRecordStore,
} = require('@frank/swap-protocol/src/htlc-swap-runner')
const { activeChain, setActiveChain } = require('@frank/wallet/chain')
const { MonadIdentity } = require('@frank/wallet/evm-identity')
const { messagingStateOwner } = require('../utils/messaging-state')
const {
  activeForSwaps,
  startAppSwapExecution,
  swapRecordNamespace,
  retiredExecutionDatabase,
} = require('./htlc-swap-execution')
const { swapExecutionState } = require('./swap-execution-state')
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
const units = { xec: 'tXEC', evm: 'MONT', unit: '' }
const phaseText = (phase: string) =>
  translate(`signedSwap.execution.phases.${phase}`, units)

const alice = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`)
const bob = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
const alicePub = new Uint8Array(alice.compressedPubKey)
const bobPub = new Uint8Array(bob.compressedPubKey)
const conversationId = '11111111-1111-4111-8111-111111111111'
const salt = new Uint8Array(32).fill(0x5a)
const keyedHash = (t: Uint8Array) => hmac(sha256, salt, t)
const preimageOf = (swapId: Uint8Array) =>
  sha256(Uint8Array.from([...swapId, 7]))
const E = 2_000_000_000
const T_B = E + 43_200
const T_A = E + 86_400
const sign = (id: any) => async (d: Uint8Array) =>
  new Uint8Array(id.signHash(Buffer.from(d)))
const must = (r: any) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value
}
const receipt = (accountId: string) => ({
  schema: 1,
  policy: 'browser-preview-aes-gcm-v1',
  context: {
    accountId,
    creationId: `${accountId}-creation`,
    recoveryFormat: 'bip39',
    registry: 'frank',
    purposes: ['identity'],
    custodyEpoch: 1,
    recoveryFingerprint: `${accountId}-fingerprint`,
    retirementContext: `${accountId}-retirement`,
  },
  previousRevision: 0,
  revision: 1,
  operationId: `${accountId}-op`,
})

/** A testnet negotiation A offered (its swapId derived under A's salt) and B accepted. */
async function acceptedNegotiation(local: 'A' | 'B') {
  const parties = [alicePub, bobPub] as const
  const policy = TESTNET_NEGOTIATION_POLICY
  const conv = new Uint8Array(
    Buffer.from(conversationId.replace(/-/g, ''), 'hex'),
  )
  const facts = fixtureOfferFields({
    expiry: BigInt(E),
    evmExpiry: BigInt(T_B),
    xecRefundTime: BigInt(T_A),
  })
  const swapId = must(
    deriveOfferSwapId(
      { policy, conversationId: conv, parties, ...facts },
      keyedHash,
    ),
  )
  const context = { swapId, conversationId: conv, parties, policy }
  const offer = must(
    encodeSignedSwapEvent(
      must(
        await buildNegotiationOffer(
          context,
          { ...facts, hashLock: sha256(preimageOf(swapId)) },
          sign(alice),
        ),
      ),
    ),
  )
  const accept = must(
    encodeSignedSwapEvent(
      must(
        await buildNegotiationResponse(
          context,
          offer,
          fixtureAccept(),
          sign(bob),
        ),
      ),
    ),
  )
  const reduction = must(reduceNegotiationStandalone([offer, accept], context))
  const self = local === 'A' ? alicePub : bobPub
  const entry = (bytes: Uint8Array, from: Uint8Array, to: Uint8Array) => ({
    eventBytes: bytes,
    direction:
      bytesToHex(from) === bytesToHex(self) ? 'outbound-replay' : 'incoming',
    senderPublicKey: from,
    recipientPublicKey: to,
    messageId: new Uint8Array(16).fill(1),
    stampedPayloadDigest: new Uint8Array(32).fill(2),
  })
  return {
    offerHex: bytesToHex(offer),
    journal: {
      rowKey: 'row-1',
      owner: {
        accountIncarnation: `${local}:1`,
        localPublicKey: self,
        messagingChainIdentifier: policy.evmChainIdentifier,
      },
      context,
      entries: [
        entry(offer, alicePub, bobPub),
        entry(accept, bobPub, alicePub),
      ],
      reduction,
      buffered: [],
    },
  }
}

/** The runner's capabilities, with the chains as `chain` says; `log` records what it did. */
function capabilities(local: 'A' | 'B', chain: any, log: string[]) {
  return {
    xec: {
      chainIdentifier: TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
      htlcPublicKey: (_s: string, role: string) =>
        new Uint8Array(
          role === 'refund' ? FIXTURE_XEC_REFUND_KEY : FIXTURE_XEC_CLAIM_KEY,
        ),
      observe: async () => chain.xec,
      lockOperation: async () => chain.lockOperation,
      fund: async () => {
        log.push('fund')
        chain.lockOperation = 'submitted'
        return { txid: 'ab'.repeat(32) }
      },
      releaseLock: async () => void log.push('release'),
      signSpend: async (input: any) => {
        log.push(`sign ${input.branch}`)
        return {
          rawTx: input.branch === 'claim' ? '02c1' : '02e7',
          txid: 'cd'.repeat(32),
        }
      },
      broadcast: async (raw: string) => {
        if (chain.broadcastFails) throw new Error('page closed')
        log.push(`broadcast ${raw}`)
      },
    },
    evm: {
      chainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
      mainAccount: () => '0x' + (local === 'A' ? 'aa' : 'bb').repeat(20),
      htlcContract: () => '0x' + 'cc'.repeat(20),
      observe: async () => chain.evm,
      ownCalls: async () => [],
      lock: async () => {
        log.push('lock')
        return { operationId: 'op-lock' }
      },
      withdraw: async () => {
        log.push('withdraw')
        return { operationId: 'op-withdraw' }
      },
      refund: async () => {
        log.push('refund evm')
        return { operationId: 'op-refund' }
      },
      claimOwed: async () => void log.push('claimOwed'),
    },
    secrets: {
      swapPreimage: ({ swapId }: { swapId: Uint8Array }) => preimageOf(swapId),
    },
    offerSwapId: keyedHash,
  }
}

describe('session HTLC swap runner and card', () => {
  const previousChain = { ...activeChain }
  const mounted: any[] = []
  const running: { stop(): Promise<void> }[] = []

  const session = (local: 'A' | 'B') => {
    const pub = local === 'A' ? alicePub : bobPub
    const id = local === 'A' ? alice : bob
    return {
      wallet: {
        chainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
        identity: {
          compressedPubKey: pub,
          address: { raw: id.displayAddress },
          displayAddress: id.displayAddress,
        },
      },
      revision: 1,
      account: { receipt: receipt(local) },
    }
  }

  /** One page load: the session starts the runner; nothing mounts a card. */
  function load(
    local: 'A' | 'B',
    journal: any,
    store: any,
    chain: any,
    log: string[],
    overrides: Record<string, unknown> = {},
    inputOverrides: Record<string, unknown> = {},
  ) {
    const opened: string[] = []
    const execution = startAppSwapExecution(
      {
        ...session(local),
        relayBaseUrl: 'http://relay.invalid',
        negotiations: { journals: () => [journal] },
        ...inputOverrides,
      },
      {
        openCapabilities: async () => {
          opened.push('capabilities')
          return capabilities(local, chain, log)
        },
        openStore: () => store,
        listDatabases: async () => [],
        isActiveDevice: () => true,
        now: () => chain.now,
        // Ticks only when the test pokes: the session's timer is not what drives these steps.
        intervalMs: 3_600_000,
        retryMs: 10,
        ...overrides,
      },
    )
    running.push(execution)
    return { execution, opened }
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await flushPromises()
  }

  beforeEach(() => {
    setActiveChain({
      ...activeChain,
      chainIdentifier: TESTNET_NEGOTIATION_POLICY.evmChainIdentifier,
    })
    messagingStateOwner.status = 'ready'
    messagingStateOwner.reason = null
  })
  afterEach(async () => {
    mounted.splice(0).forEach(w => w.unmount())
    for (const r of running.splice(0)) await r.stop()
    mockSnapshot = null
    setActiveChain(previousChain)
  })

  const mountCard = (local: 'A' | 'B', offerHex: string) => {
    const self = local === 'A' ? alice : bob
    const peer = local === 'A' ? bob : alice
    mockSession = {
      state: {
        status: 'ready',
        revision: 1,
        account: { receipt: receipt(local) },
      },
      getCachedCurvePublicKey: () => new Uint8Array(self.compressedPubKey),
    }
    const card = mount(Card, {
      props: {
        item: {
          type: 'application',
          itemType: 'swap-negotiation-v1',
          value: { eventHex: offerHex },
        },
        address: peer.displayAddress,
        senderAddress: alice.displayAddress,
        outbound: local === 'A',
        conversationId,
        deliveryStatus: 'confirmed',
      },
      global: globalOptions,
    })
    mounted.push(card)
    return card
  }

  test('B claims the XEC with no card mounted, and a reload re-broadcasts the same signed claim', async () => {
    const { journal, offerHex } = await acceptedNegotiation('B')
    mockSnapshot = { state: 'ready', coverage: 1, journals: [journal] }
    const terms = htlcSwapTermsOf(journal)
    const funding = {
      txid: 'ab'.repeat(32),
      vout: 0,
      valueSats: terms.xec.fundingValueSats,
      final: true,
    }
    const chain: any = {
      now: E + 60,
      xec: { tipMedianTime: E, outputs: [funding] },
      evm: {
        latest: { state: 'open', preimage: null },
        final: { state: 'open', preimage: null },
        blockTimestamp: E + 60,
        owedWei: 0n,
        mainBalanceWei: 10n ** 18n,
        callCostWei: 1n,
      },
    }
    const store = new MemoryHtlcSwapRecordStore()
    const log: string[] = []
    const first = load('B', journal, store, chain, log)
    await settle()
    // B's MON lock is on chain; the card shows it, with the deadlines and no swap buttons.
    const card = mountCard('B', offerHex)
    await settle()
    expect(card.find('[data-testid="swap-execution-phase"]').text()).toBe(
      phaseText('evmLocked'),
    )
    expect(card.find('[data-testid="swap-deadline-evm"]').text()).toContain(
      new Date(T_B * 1000).toLocaleString(undefined, { timeZoneName: 'short' }),
    )
    expect(card.find('[data-testid="swap-deadline-xec"]').text()).toContain(
      new Date(T_A * 1000).toLocaleString(undefined, { timeZoneName: 'short' }),
    )
    expect(card.findAll('button')).toHaveLength(0)

    // The card goes away; A withdraws (revealing the preimage); the page closes mid-broadcast.
    card.unmount()
    mounted.splice(mounted.indexOf(card), 1)
    const preimage = preimageOf(journal.context.swapId)
    chain.evm = {
      ...chain.evm,
      latest: { state: 'withdrawn', preimage },
      final: { state: 'withdrawn', preimage },
    }
    chain.broadcastFails = true
    first.execution.poke()
    await settle()
    expect(log).toEqual(['sign claim'])
    const written = JSON.parse(
      (await store.getRecord(bytesToHex(journal.context.swapId))).raw,
    )
    expect(written.xecSpends).toEqual([
      expect.objectContaining({ branch: 'claim', rawTx: '02c1' }),
    ])
    await first.execution.stop()

    // Reload: a new session composition over the same records, still with no card.
    chain.broadcastFails = false
    const second = load('B', journal, store, chain, log)
    await settle()
    expect(second.opened).toEqual(['capabilities'])
    expect(log).toEqual(['sign claim', 'broadcast 02c1'])
    expect(
      swapExecutionState.views[bytesToHex(journal.context.swapId)],
    ).toMatchObject({
      role: 'B',
      phase: 'claimingXec',
    })
  })

  test('A locks its XEC on the accept and refunds it after T_A with no card mounted, across a reload', async () => {
    const { journal } = await acceptedNegotiation('A')
    const store = new MemoryHtlcSwapRecordStore()
    const log: string[] = []
    const chain: any = {
      now: E + 60,
      lockOperation: undefined,
      xec: { tipMedianTime: E, outputs: [] },
      evm: {
        latest: null,
        final: null,
        blockTimestamp: E + 60,
        owedWei: 0n,
        mainBalanceWei: 10n ** 18n,
        callCostWei: 1n,
      },
    }
    const first = load('A', journal, store, chain, log)
    await settle()
    // No Lock button anywhere: the accept was enough.
    expect(log).toEqual(['fund'])
    await first.execution.stop()

    // B never locks. Well after T_A, a reload: the session's runner refunds by itself.
    const terms = htlcSwapTermsOf(journal)
    chain.lockOperation = 'confirmed'
    chain.now = T_A + 7_200
    chain.xec = {
      tipMedianTime: T_A + 1,
      outputs: [
        {
          txid: 'ab'.repeat(32),
          vout: 0,
          valueSats: terms.xec.fundingValueSats,
          final: true,
        },
      ],
    }
    chain.evm = { ...chain.evm, blockTimestamp: T_A + 7_200 }
    load('A', journal, store, chain, log)
    await settle()
    expect(log).toEqual(['fund', 'sign refund', 'broadcast 02e7'])
    expect(
      swapExecutionState.views[bytesToHex(journal.context.swapId)],
    ).toMatchObject({
      role: 'A',
      phase: 'refunding',
    })
  })

  test('the card warns when the main account cannot pay the claim, and an inactive device only watches', async () => {
    const { journal, offerHex } = await acceptedNegotiation('A')
    mockSnapshot = { state: 'ready', coverage: 1, journals: [journal] }
    const terms = htlcSwapTermsOf(journal)
    const log: string[] = []
    const chain: any = {
      now: E + 60,
      lockOperation: 'confirmed',
      xec: {
        tipMedianTime: E,
        outputs: [
          {
            txid: 'ab'.repeat(32),
            vout: 0,
            valueSats: terms.xec.fundingValueSats,
            final: true,
          },
        ],
      },
      evm: {
        latest: null,
        final: null,
        blockTimestamp: E + 60,
        owedWei: 0n,
        mainBalanceWei: 0n,
        callCostWei: 10n ** 15n,
      },
    }
    load('A', journal, new MemoryHtlcSwapRecordStore(), chain, log, {
      isActiveDevice: () => false,
    })
    await settle()
    const card = mountCard('A', offerHex)
    await settle()
    expect(card.find('[data-testid="swap-execution-phase"]').text()).toBe(
      phaseText('xecLocked'),
    )
    expect(card.find('[data-testid="swap-warning-claim-gas-low"]').text()).toBe(
      translate('signedSwap.execution.warnings.claim-gas-low', units),
    )
    expect(
      card.find('[data-testid="swap-execution-other-device"]').exists(),
    ).toBe(true)
    expect(card.findAll('button')).toHaveLength(0)
    expect(log).toEqual([])
  })

  test('retired execution records stop the runner with their reset named on the card', async () => {
    const { journal, offerHex } = await acceptedNegotiation('A')
    mockSnapshot = { state: 'ready', coverage: 1, journals: [journal] }
    const old = retiredExecutionDatabase(swapRecordNamespace(session('A')))
    const log: string[] = []
    const errors = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const { opened } = load(
      'A',
      journal,
      new MemoryHtlcSwapRecordStore(),
      {},
      log,
      {
        listDatabases: async () => [old],
      },
    )
    await settle()
    errors.mockRestore()
    expect(opened).toEqual([])
    expect(swapExecutionState).toMatchObject({
      status: 'failed',
      failure: 'old-execution-records',
      oldDatabase: old,
    })
    const card = mountCard('A', offerHex)
    await settle()
    expect(card.find('[data-testid="swap-execution-failed"]').text()).toContain(
      old,
    )
    expect(log).toEqual([])
  })

  test('stopping the session while the wallets are being retried resolves at once', async () => {
    const { journal } = await acceptedNegotiation('A')
    const log: string[] = []
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    let attempts = 0
    const { execution } = load(
      'A',
      journal,
      new MemoryHtlcSwapRecordStore(),
      {},
      log,
      {
        openCapabilities: async () => {
          attempts += 1
          throw new Error('relay unreachable')
        },
        // A retry far in the future: only the stop can end the wait.
        retryMs: 3_600_000,
      },
    )
    await settle()
    expect(attempts).toBe(1)
    expect(swapExecutionState.failure).toBe('wallet-unavailable')
    let stopped = false
    await Promise.race([
      execution.stop().then(() => (stopped = true)),
      new Promise(resolve => setTimeout(resolve, 1_000)),
    ])
    warn.mockRestore()
    expect(stopped).toBe(true)
    await settle()
    expect(attempts).toBe(1)
    expect(swapExecutionState.status).toBe('off')
  })

  test('stopping the session while a wallet open never returns resolves at once', async () => {
    const { journal } = await acceptedNegotiation('A')
    const { execution } = load(
      'A',
      journal,
      new MemoryHtlcSwapRecordStore(),
      {},
      [],
      {
        openCapabilities: () => new Promise(() => undefined),
      },
    )
    await settle()
    let stopped = false
    await Promise.race([
      execution.stop().then(() => (stopped = true)),
      new Promise(resolve => setTimeout(resolve, 1_000)),
    ])
    expect(stopped).toBe(true)
  })

  test('no new swap work starts before the device claims are read, then it does', async () => {
    const { journal } = await acceptedNegotiation('A')
    const log: string[] = []
    const chain: any = {
      now: E + 60,
      lockOperation: undefined,
      xec: { tipMedianTime: E, outputs: [] },
      evm: {
        latest: null,
        final: null,
        blockTimestamp: E + 60,
        owedWei: 0n,
        mainBalanceWei: 10n ** 18n,
        callCostWei: 1n,
      },
    }
    let firstRead!: () => void
    const activeDeviceKnown = new Promise<void>(resolve => {
      firstRead = resolve
    })
    load(
      'A',
      journal,
      new MemoryHtlcSwapRecordStore(),
      chain,
      log,
      {},
      {
        activeDeviceKnown,
      },
    )
    await settle()
    expect(log).toEqual([])
    expect(swapExecutionState.activeDevice).toBe(false)
    firstRead()
    await settle()
    expect(log).toEqual(['fund'])
  })

  test('after the first read, no claim at all means active; a claim of another device means observing', () => {
    expect(activeForSwaps({ masterInstanceId: null, myInstanceId: 'me' })).toBe(
      true,
    )
    expect(activeForSwaps({ masterInstanceId: 'me', myInstanceId: 'me' })).toBe(
      true,
    )
    expect(
      activeForSwaps({ masterInstanceId: 'other', myInstanceId: 'me' }),
    ).toBe(false)
  })

  test('the default device check reads the leader store: no claim acts, another device’s claim observes', async () => {
    const { createPinia, setActivePinia } = require('pinia')
    const { useLeaderStore } = require('../stores/leader')
    setActivePinia(createPinia())
    const leader = useLeaderStore()
    const { journal } = await acceptedNegotiation('A')
    const chainOf = () => ({
      now: E + 60,
      lockOperation: undefined,
      xec: { tipMedianTime: E, outputs: [] },
      evm: {
        latest: null,
        final: null,
        blockTimestamp: E + 60,
        owedWei: 0n,
        mainBalanceWei: 10n ** 18n,
        callCostWei: 1n,
      },
    })
    const withDefaultCheck = (log: string[]) =>
      load('A', journal, new MemoryHtlcSwapRecordStore(), chainOf(), log, {
        isActiveDevice: () => activeForSwaps(leader),
      })
    leader.masterInstanceId = 'another-device'
    const observing: string[] = []
    const first = withDefaultCheck(observing)
    await settle()
    expect(observing).toEqual([])
    await first.execution.stop()
    leader.masterInstanceId = null
    const acting: string[] = []
    withDefaultCheck(acting)
    await settle()
    expect(acting).toEqual(['fund'])
  })

  test('an inactive device still re-submits its own exposed XEC lock', async () => {
    const { journal } = await acceptedNegotiation('A')
    const log: string[] = []
    const chain: any = {
      now: E + 60,
      lockOperation: 'exposed',
      xec: { tipMedianTime: E, outputs: [] },
      evm: {
        latest: null,
        final: null,
        blockTimestamp: E + 60,
        owedWei: 0n,
        mainBalanceWei: 10n ** 18n,
        callCostWei: 1n,
      },
    }
    load('A', journal, new MemoryHtlcSwapRecordStore(), chain, log, {
      isActiveDevice: () => false,
    })
    await settle()
    expect(log).toEqual(['fund'])
  })

  test('stopping the session stops the runner and clears what the card reads', async () => {
    const { journal } = await acceptedNegotiation('B')
    const log: string[] = []
    const chain: any = {
      now: E + 60,
      xec: { tipMedianTime: E, outputs: [] },
      evm: {
        latest: null,
        final: null,
        blockTimestamp: E + 60,
        owedWei: 0n,
        mainBalanceWei: 10n ** 18n,
        callCostWei: 1n,
      },
    }
    const { execution } = load(
      'B',
      journal,
      new MemoryHtlcSwapRecordStore(),
      chain,
      log,
    )
    await settle()
    expect(swapExecutionState.status).toBe('ready')
    expect(Object.keys(swapExecutionState.views)).toHaveLength(1)
    await execution.stop()
    expect(swapExecutionState.status).toBe('off')
    expect(swapExecutionState.views).toEqual({})
    execution.poke()
    await settle()
    expect(log).toEqual([])
  })
})
