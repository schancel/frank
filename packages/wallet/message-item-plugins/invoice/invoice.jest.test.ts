import { standaloneItemBudget } from '@frank/codec'
import { createMessageItemRegistry } from '../registry'
import {
  decodeInvoicePayload,
  encodeInvoicePayload,
  formatInvoiceAmount,
  generateInvoiceId,
  initInvoicePlugin,
  INVOICE_MAX_DESCRIPTION_BYTES,
  INVOICE_PLUGIN_ID,
  InvoiceAttemptStore,
  InvoiceDuplicateAttemptBlockedError,
  invoicePlugin,
  InvoicePrivateTagStore,
  type InvoiceReceiptPayload,
  type InvoiceRequestPayload,
  type InvoiceStorageLike,
  parseHumanAmountToBaseUnits,
  parseInvoiceApplicationItem,
  toInvoiceApplicationItem,
  validateInvoicePayload,
  verifyCanonicalInvoicePayment,
} from './index'

class MockMemoryStorage implements InvoiceStorageLike {
  readonly data = new Map<string, string>()

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }
}

const sampleRequest: InvoiceRequestPayload = {
  action: 'request',
  schemaVersion: 1,
  invoiceId: 'inv_20261017_0001_abcdef',
  payeeIdentity: '0x1111111111111111111111111111111111111111',
  chainKey: 'monad',
  networkId: '10143',
  nativeSymbol: 'MON',
  nativeDecimals: 18,
  amountBaseUnits: '1250000000000000000', // 1.25 MON
  receiveAddress: '0x2222222222222222222222222222222222222222',
  description: 'Q4 Design Sprint Milestone #1',
  expiresAtIso: '2030-01-01T00:00:00.000Z',
}

const sampleReceipt: InvoiceReceiptPayload = {
  action: 'receipt',
  schemaVersion: 1,
  invoiceId: 'inv_20261017_0001_abcdef',
  txHash: '0x9999888877776666555544443333222211110000aaaabbbbccccddddeeeeffff',
  chainKey: 'monad',
  networkId: '10143',
  amountBaseUnits: '1250000000000000000',
  payerIdentity: '0x3333333333333333333333333333333333333333',
}

describe('invoice-v1 plugin and lifecycle (#679)', () => {
  describe('wire encoding, decoding, and schema validation', () => {
    it('round-trips request and receipt payloads through canonical CBOR and MessageItemRegistry', () => {
      const encodedReq = encodeInvoicePayload(sampleRequest)
      const decodedReq = decodeInvoicePayload(encodedReq, {
        budget: standaloneItemBudget(),
      })
      expect(decodedReq).toEqual(sampleRequest)

      const encodedRec = encodeInvoicePayload(sampleReceipt)
      const decodedRec = decodeInvoicePayload(encodedRec, {
        budget: standaloneItemBudget(),
      })
      expect(decodedRec).toEqual(sampleReceipt)

      const registry = createMessageItemRegistry()
      initInvoicePlugin(registry)
      expect(registry.has(INVOICE_PLUGIN_ID)).toBe(true)

      const appItem = toInvoiceApplicationItem(sampleRequest)
      expect(appItem.type).toBe('application')
      expect(appItem.itemType).toBe(INVOICE_PLUGIN_ID)
      expect(parseInvoiceApplicationItem(appItem)).toEqual(sampleRequest)

      const wireEncoded = registry.encodeItem(appItem)
      const wireDecoded = registry.decodeItem(
        INVOICE_PLUGIN_ID,
        wireEncoded.bytes,
        { budget: standaloneItemBudget() },
      )
      expect(wireDecoded).toEqual({
        kind: 'item',
        item: appItem,
      })
      expect(registry.previewText(appItem)).toContain('1.25 MON')
      expect(invoicePlugin.previewText(sampleReceipt)).toContain(
        sampleReceipt.invoiceId.slice(0, 8),
      )
    })

    it('converts human amounts to exact base units without floating-point drift', () => {
      expect(parseHumanAmountToBaseUnits('1.25', 18)).toBe(
        '1250000000000000000',
      )
      expect(parseHumanAmountToBaseUnits('0.000000001', 9)).toBe('1')
      expect(parseHumanAmountToBaseUnits('42', 2)).toBe('4200')
      expect(formatInvoiceAmount('1250000000000000000', 18)).toBe('1.25')

      expect(() => parseHumanAmountToBaseUnits('0', 18)).toThrow()
      expect(() => parseHumanAmountToBaseUnits('-1.5', 18)).toThrow()
    })

    it('enforces 280 UTF-8 byte description bound and rejects invalid base units or ids', () => {
      const exact280 = 'a'.repeat(INVOICE_MAX_DESCRIPTION_BYTES)
      expect(
        validateInvoicePayload({ ...sampleRequest, description: exact280 })
          .action,
      ).toBe('request')

      const over280 = 'a'.repeat(INVOICE_MAX_DESCRIPTION_BYTES + 1)
      expect(() =>
        validateInvoicePayload({ ...sampleRequest, description: over280 }),
      ).toThrow(/280 UTF-8 bytes/)

      // Multi-byte UTF-8 characters (71 * 4 bytes = 284 bytes > 280)
      const multiByteOver = '🧾'.repeat(71)
      expect(() =>
        validateInvoicePayload({
          ...sampleRequest,
          description: multiByteOver,
        }),
      ).toThrow(/280 UTF-8 bytes/)

      // Reject non-integer or zero amountBaseUnits
      for (const badAmount of ['0', '0100', '-100', '1.5', '1e18', 'NaN', '']) {
        expect(() =>
          validateInvoicePayload({
            ...sampleRequest,
            amountBaseUnits: badAmount,
          }),
        ).toThrow()
      }

      // Generate valid unpredictable invoiceId
      const genId = generateInvoiceId()
      expect(genId.length).toBeGreaterThanOrEqual(16)
      expect(
        validateInvoicePayload({ ...sampleRequest, invoiceId: genId })
          .invoiceId,
      ).toBe(genId)
    })

    it('strictly excludes private tags from wire payloads and stores them only in InvoicePrivateTagStore', () => {
      expect(() =>
        validateInvoicePayload({
          ...sampleRequest,
          privateTags: ['tax-2026', 'client-acme'],
        } as unknown),
      ).toThrow(/Unexpected invoice payload property: privateTags/)

      expect(() =>
        validateInvoicePayload({
          ...sampleRequest,
          tags: ['internal'],
        } as unknown),
      ).toThrow(/Unexpected invoice payload property: tags/)

      const storage = new MockMemoryStorage()
      const tagStore = new InvoicePrivateTagStore({ storage })
      expect(tagStore.getTags(sampleRequest.invoiceId)).toEqual([])

      const saved = tagStore.setTags(sampleRequest.invoiceId, [
        '  consulting  ',
        'Q4-tax',
        'CONSULTING', // deduplicated case-insensitively
      ])
      expect(saved).toEqual(['consulting', 'Q4-tax'])

      // Re-hydrates from durable local storage across restarts
      const reloadedStore = new InvoicePrivateTagStore({ storage })
      expect(reloadedStore.getTags(sampleRequest.invoiceId)).toEqual([
        'consulting',
        'Q4-tax',
      ])

      reloadedStore.addTag(sampleRequest.invoiceId, 'reimbursable')
      expect(reloadedStore.getTags(sampleRequest.invoiceId)).toEqual([
        'consulting',
        'Q4-tax',
        'reimbursable',
      ])

      reloadedStore.removeTag(sampleRequest.invoiceId, 'q4-tax')
      expect(reloadedStore.getTags(sampleRequest.invoiceId)).toEqual([
        'consulting',
        'reimbursable',
      ])

      // Verify wire bytes never contain private tag strings
      const wireBytes = encodeInvoicePayload(sampleRequest)
      const wireText = new TextDecoder().decode(wireBytes)
      expect(wireText).not.toContain('consulting')
      expect(wireText).not.toContain('reimbursable')
    })
  });

  describe('durable pre-broadcast attempt persistence and outcome_unknown guard', () => {
    it('persists pre-broadcast attempt before send and blocks duplicate payments when outcome_unknown', () => {
      const storage = new MockMemoryStorage()
      const store = new InvoiceAttemptStore({ storage })

      expect(store.canCreateNewPaymentAttempt(sampleRequest.invoiceId)).toEqual(
        { allowed: true },
      )

      const preAttempt = store.recordPreBroadcast({
        invoiceId: sampleRequest.invoiceId,
        chainKey: sampleRequest.chainKey,
        networkId: sampleRequest.networkId,
        receiveAddress: sampleRequest.receiveAddress,
        amountBaseUnits: sampleRequest.amountBaseUnits,
        nowMs: 1_700_000_000_000,
      })
      expect(preAttempt.status).toBe('signing_or_broadcasting')

      // While signing_or_broadcasting, a second payment attempt is blocked
      expect(() =>
        store.recordPreBroadcast({
          invoiceId: sampleRequest.invoiceId,
          chainKey: sampleRequest.chainKey,
          networkId: sampleRequest.networkId,
          receiveAddress: sampleRequest.receiveAddress,
          amountBaseUnits: sampleRequest.amountBaseUnits,
        }),
      ).toThrow(InvoiceDuplicateAttemptBlockedError)

      // Transition to outcome_unknown when broadcast times out
      store.markOutcomeUnknown(sampleRequest.invoiceId, {
        signedTxId: '0xsigned_tx_1',
        errorReason: 'RPC timeout during broadcast',
      })

      // Simulate browser restart by instantiating a new InvoiceAttemptStore over the same storage
      const restartedStore = new InvoiceAttemptStore({ storage })
      const recovered = restartedStore.get(sampleRequest.invoiceId)
      expect(recovered?.status).toBe('outcome_unknown')
      expect(recovered?.signedTxId).toBe('0xsigned_tx_1')

      // Attempting a replacement payment while outcome_unknown MUST throw
      expect(
        restartedStore.canCreateNewPaymentAttempt(sampleRequest.invoiceId)
          .allowed,
      ).toBe(false)
      expect(() =>
        restartedStore.recordPreBroadcast({
          invoiceId: sampleRequest.invoiceId,
          chainKey: sampleRequest.chainKey,
          networkId: sampleRequest.networkId,
          receiveAddress: sampleRequest.receiveAddress,
          amountBaseUnits: sampleRequest.amountBaseUnits,
        }),
      ).toThrow(InvoiceDuplicateAttemptBlockedError)

      // Only after explicit chain reconciliation ('not-submitted') can a new attempt proceed
      restartedStore.reconcileNotSubmitted(sampleRequest.invoiceId)
      expect(
        restartedStore.canCreateNewPaymentAttempt(sampleRequest.invoiceId)
          .allowed,
      ).toBe(true)
    })
  })

  describe('independent canonical verification (verifyCanonicalInvoicePayment)', () => {
    it('marks paid_confirmed ONLY when canonical chain transfer matches chain, network, recipient, and exact base units', () => {
      // Peer receipt message alone without observed on-chain transfer does NOT mark paid_confirmed
      const receiptOnlyRes = verifyCanonicalInvoicePayment(
        sampleRequest,
        null,
        {
          receiptHints: [sampleReceipt, sampleReceipt], // duplicate receipt hints
          nowMs: Date.parse('2026-10-17T12:00:00Z'),
        },
      )
      expect(receiptOnlyRes.status).toBe('open')
      // Deduplicates receipt hints idempotently
      expect(receiptOnlyRes.receiptHintTxHashes).toEqual([sampleReceipt.txHash])

      // Canonical confirmed transfer matching all fields -> paid_confirmed
      const confirmedRes = verifyCanonicalInvoicePayment(
        sampleRequest,
        {
          txHash: sampleReceipt.txHash,
          chainKey: 'monad',
          networkId: '10143',
          toAddress: sampleRequest.receiveAddress.toUpperCase(), // case-insensitive EVM match
          amountBaseUnits: sampleRequest.amountBaseUnits,
          isNativeAsset: true,
          status: 'confirmed',
        },
        {
          receiptHints: [sampleReceipt],
        },
      )
      expect(confirmedRes.status).toBe('paid_confirmed')
      expect(confirmedRes.verifiedTxHash).toBe(sampleReceipt.txHash)
      expect(confirmedRes.paymentBlocked).toBe(true)
    })

    it('flags partial payment, excess payment, wrong network/chain/asset/recipient, and failed tx as exception_manual_review', () => {
      // Partial payment
      const partialRes = verifyCanonicalInvoicePayment(sampleRequest, {
        txHash: '0xpartial',
        chainKey: 'monad',
        networkId: '10143',
        toAddress: sampleRequest.receiveAddress,
        amountBaseUnits: '1000000000000000000', // 1.00 MON < 1.25 MON
        status: 'confirmed',
      })
      expect(partialRes.status).toBe('exception_manual_review')
      expect(partialRes.exceptionReason).toBe('partial_payment')

      // Excess payment
      const excessRes = verifyCanonicalInvoicePayment(sampleRequest, {
        txHash: '0xexcess',
        chainKey: 'monad',
        networkId: '10143',
        toAddress: sampleRequest.receiveAddress,
        amountBaseUnits: '2000000000000000000', // 2.00 MON > 1.25 MON
        status: 'confirmed',
      })
      expect(excessRes.status).toBe('exception_manual_review')
      expect(excessRes.exceptionReason).toBe('excess_payment')

      // Wrong network
      const wrongNetRes = verifyCanonicalInvoicePayment(sampleRequest, {
        txHash: '0xwrongnet',
        chainKey: 'monad',
        networkId: '1', // wrong networkId
        toAddress: sampleRequest.receiveAddress,
        amountBaseUnits: sampleRequest.amountBaseUnits,
        status: 'confirmed',
      })
      expect(wrongNetRes.status).toBe('exception_manual_review')
      expect(wrongNetRes.exceptionReason).toBe('wrong_network')

      // Wrong asset (ERC-20 / SPL token transfer instead of native coin)
      const wrongAssetRes = verifyCanonicalInvoicePayment(sampleRequest, {
        txHash: '0xtoken',
        chainKey: 'monad',
        networkId: '10143',
        toAddress: sampleRequest.receiveAddress,
        amountBaseUnits: sampleRequest.amountBaseUnits,
        assetType: 'token',
        isNativeAsset: false,
        status: 'confirmed',
      })
      expect(wrongAssetRes.status).toBe('exception_manual_review')
      expect(wrongAssetRes.exceptionReason).toBe('wrong_asset')

      // Failed transaction
      const failedRes = verifyCanonicalInvoicePayment(sampleRequest, {
        txHash: '0xfailed',
        chainKey: 'monad',
        networkId: '10143',
        toAddress: sampleRequest.receiveAddress,
        amountBaseUnits: sampleRequest.amountBaseUnits,
        status: 'failed',
      })
      expect(failedRes.status).toBe('exception_manual_review')
      expect(failedRes.exceptionReason).toBe('transaction_failed')
    })

    it('transitions from paid_confirmed to exception_manual_review on chain reorg', () => {
      const attemptStore = new InvoiceAttemptStore({ storage: null })

      const initial = verifyCanonicalInvoicePayment(
        sampleRequest,
        {
          txHash: '0xreorg_tx',
          chainKey: 'monad',
          networkId: '10143',
          toAddress: sampleRequest.receiveAddress,
          amountBaseUnits: sampleRequest.amountBaseUnits,
          status: 'confirmed',
        },
        { attemptStore },
      )
      expect(initial.status).toBe('paid_confirmed')
      expect(attemptStore.get(sampleRequest.invoiceId)?.status).toBe(
        'paid_confirmed',
      )

      // Subsequent observation reports transaction was reorged out
      const afterReorg = verifyCanonicalInvoicePayment(
        sampleRequest,
        {
          txHash: '0xreorg_tx',
          chainKey: 'monad',
          networkId: '10143',
          toAddress: sampleRequest.receiveAddress,
          amountBaseUnits: sampleRequest.amountBaseUnits,
          status: 'reorged',
        },
        { attemptStore },
      )
      expect(afterReorg.status).toBe('exception_manual_review')
      expect(afterReorg.exceptionReason).toBe('transaction_reorged')
      expect(attemptStore.get(sampleRequest.invoiceId)?.status).toBe(
        'exception_manual_review',
      )
    })

    it('detects expired invoices and active wallet network mismatches', () => {
      const expiredRes = verifyCanonicalInvoicePayment(sampleRequest, null, {
        nowMs: Date.parse('2031-01-01T00:00:00.000Z'),
      })
      expect(expiredRes.status).toBe('expired')
      expect(expiredRes.paymentBlocked).toBe(true)

      const mismatchRes = verifyCanonicalInvoicePayment(sampleRequest, null, {
        nowMs: Date.parse('2026-10-17T00:00:00.000Z'),
        activeChainKey: 'solana',
        activeNetworkId: 'mainnet-beta',
      })
      expect(mismatchRes.status).toBe('open')
      expect(mismatchRes.paymentBlocked).toBe(true)
      expect(mismatchRes.paymentBlockedReason).toContain('monad')
    })
  })
})
