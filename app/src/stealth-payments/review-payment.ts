import { recipientAssetPaymentFromPrepared } from '@frank/wallet/message-item-plugins/stealth-asset/from-prepared'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import type {
  PreparedStealthPayment,
  StealthPaymentCapability,
  StealthPaymentIntent,
  StealthPaymentQuote,
} from '@frank/wallet/stealth-payment'
import { accountSession } from '../accounts/session'
import { createNativeTransferContext } from '../accounts/native-transfer'
import type { StealthDialogRequest } from './options'
import { sameStealthAsset } from './options'

export interface CapturedStealthReview {
  readonly quote: StealthPaymentQuote
  readonly stampValue: bigint
  readonly stampFeeAtomic: bigint
  readonly maxNativeFeeAtomic: bigint
  readonly messagingWallet: WalletHandle
  assertCurrent(): Promise<void>
  prepare(): Promise<PreparedStealthPayment>
  /** Only before adoption by the outgoing owner; the financial owner proves non-exposure. */
  releaseUnexposed(): Promise<boolean>
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

/** Captures the financial wallet separately from the wallet paying the message stamp.
 * The returned closure never follows a subsequently selected network or account. */
export async function reviewStealthPayment({
  request,
  stampValue,
  isCurrent,
}: {
  request: StealthDialogRequest
  stampValue: bigint
  isCurrent: () => boolean
}): Promise<CapturedStealthReview> {
  if (stampValue < 0n || request.amountAtomic <= 0n)
    throw new Error('Invalid payment amount or message stamp')
  const network = getChainRegistryEntry(request.chainIdentifier)
  if (!network?.wallet) throw new Error('Unsupported payment network')
  const messagingChain = { ...activeChain }
  const { account, revision } = accountSession.state
  const messagingWallet = await accountSession.getWallet()
  const assertCurrent = async () => {
    const state = accountSession.state
    if (
      !isCurrent() ||
      state.status !== 'ready' ||
      state.account !== account ||
      state.revision !== revision ||
      activeChain.chainIdentifier !== messagingChain.chainIdentifier ||
      activeChain.directMessages !== messagingChain.directMessages
    )
      throw new Error('Payment context changed; review the payment again')
    if ((await accountSession.getWallet()) !== messagingWallet)
      throw new Error('Payment account changed; review the payment again')
    if (!isCurrent() || accountSession.state.revision !== revision)
      throw new Error('Payment context changed; review the payment again')
  }
  await assertCurrent()
  const address = messagingChain.parseAddress(request.address)
  if (!address) throw new Error('Invalid recipient address')
  const profile = await messagingChain.fetchProfile(address)
  await assertCurrent()
  const registeredKey =
    profile?.curveKeys?.[network.curve] ??
    (network.curve === 'secp256k1' ? profile?.pubKey : undefined) ??
    request.recipientSpendPublicKey
  if (!registeredKey) throw new Error('Recipient spend identity is unavailable')
  const recipientSpendPublicKey = registeredKey.slice()
  const context = await createNativeTransferContext(request.chainIdentifier)
  await assertCurrent()
  const binding = await context.captureWallet()
  await binding.assertCurrent()
  await assertCurrent()
  const payments: StealthPaymentCapability | undefined =
    binding.wallet.stealthPayments
  if (!payments?.quote)
    throw new Error('Stealth payment quoting is unavailable for this wallet')
  const intent = {
    operationId: globalThis.crypto.randomUUID(),
    chainIdentifier: request.chainIdentifier,
    asset: { ...request.asset },
    recipientSpendPublicKey,
    amountAtomic: request.amountAtomic,
  }
  const quote = await payments.quote(intent)
  await binding.assertCurrent()
  await assertCurrent()
  if (
    quote.operationId !== intent.operationId ||
    quote.chainIdentifier !== intent.chainIdentifier ||
    !sameStealthAsset(quote.asset, intent.asset) ||
    quote.amountAtomic !== intent.amountAtomic ||
    !equalBytes(quote.recipientSpendPublicKey, recipientSpendPublicKey) ||
    quote.estimatedNativeFeeAtomic < 0n ||
    quote.nativeBalanceAtomic < quote.estimatedNativeFeeAtomic ||
    quote.assetBalanceAtomic <
      quote.amountAtomic +
        (quote.asset.kind === 'native' ? quote.estimatedNativeFeeAtomic : 0n)
  )
    throw new Error(
      'Payment quote does not match the requested amount or available funds',
    )
  const sources = quote.sources
  if (sources !== undefined) {
    const sum = (
      field: keyof Omit<
        NonNullable<StealthPaymentQuote['sources']>[number],
        'sourceAddress'
      >,
    ) => sources.reduce((total, source) => total + source[field], 0n)
    if (
      sources.length === 0 ||
      sources.some(
        source =>
          !source.sourceAddress ||
          source.recipientAmountAtomic <= 0n ||
          source.estimatedNativeFeeAtomic < 0n ||
          source.nativeBalanceAtomic < source.estimatedNativeFeeAtomic ||
          source.assetBalanceAtomic <
            source.recipientAmountAtomic +
              (quote.asset.kind === 'native'
                ? source.estimatedNativeFeeAtomic
                : 0n),
      ) ||
      sum('recipientAmountAtomic') !== quote.amountAtomic ||
      sum('nativeBalanceAtomic') !== quote.nativeBalanceAtomic ||
      sum('assetBalanceAtomic') !== quote.assetBalanceAtomic ||
      sum('estimatedNativeFeeAtomic') !== quote.estimatedNativeFeeAtomic ||
      (quote.sourceAddress !== undefined &&
        (sources.length !== 1 ||
          sources[0]?.sourceAddress !== quote.sourceAddress))
    )
      throw new Error(
        'Payment source allocations do not match the reviewed quote',
      )
  }
  const paymentSources =
    quote.sources?.map(source => source.sourceAddress) ??
    (quote.sourceAddress === undefined ? [] : [quote.sourceAddress])
  const excludedAddresses =
    stampValue > 0n && quote.chainIdentifier === messagingChain.chainIdentifier
      ? [...new Set(paymentSources)]
      : undefined
  if (excludedAddresses?.length === 0)
    throw new Error(
      'Payment sources must be known before reviewing message stamp funding',
    )
  const quoteStamp = async () => {
    await binding.assertCurrent()
    await assertCurrent()
    const stamp = messagingChain.directMessages.quoteStamp
      ? await messagingChain.directMessages.quoteStamp({
          wallet: messagingWallet,
          stampValue,
          excludedAddresses,
        })
      : stampValue === 0n
      ? {
          status: 'available' as const,
          chainIdentifier: messagingChain.chainIdentifier,
          stampValueAtomic: 0n,
          spendableCapacityAtomic: 0n,
          maximumNativeFeeAtomic: 0n,
        }
      : undefined
    await binding.assertCurrent()
    await assertCurrent()
    if (
      !stamp ||
      stamp.chainIdentifier !== messagingChain.chainIdentifier ||
      stamp.stampValueAtomic !== stampValue ||
      stamp.status !== 'available' ||
      stamp.maximumNativeFeeAtomic < 0n
    )
      throw new Error(
        'Messaging wallet cannot fund this message stamp and its fees',
      )
    return stamp
  }
  const stampQuote = await quoteStamp()
  const approved: StealthPaymentIntent = {
    ...intent,
    maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
    ...(quote.sourceAddress === undefined
      ? {}
      : { sourceAddress: quote.sourceAddress }),
  }
  return {
    quote: {
      ...quote,
      asset: { ...quote.asset },
      ...(quote.sources === undefined
        ? {}
        : {
            sources: quote.sources.map(source => ({ ...source })),
          }),
      recipientDestination: quote.recipientDestination.slice(),
      recipientSpendPublicKey: quote.recipientSpendPublicKey.slice(),
      ephemeralPublicKey: quote.ephemeralPublicKey.slice(),
    },
    stampValue,
    stampFeeAtomic: stampQuote.maximumNativeFeeAtomic,
    maxNativeFeeAtomic: approved.maxNativeFeeAtomic,
    messagingWallet,
    assertCurrent,
    async releaseUnexposed() {
      await binding.assertCurrent()
      await assertCurrent()
      return payments.release(approved.operationId)
    },
    async prepare() {
      await binding.assertCurrent()
      await assertCurrent()
      const prepared = await payments.prepare(approved)
      await binding.assertCurrent()
      await assertCurrent()
      if (
        prepared.operationId !== quote.operationId ||
        prepared.chainIdentifier !== quote.chainIdentifier ||
        !sameStealthAsset(prepared.asset, quote.asset) ||
        prepared.amountAtomic !== quote.amountAtomic ||
        prepared.recipientAddress !== quote.recipientAddress ||
        !equalBytes(
          prepared.recipientDestination,
          quote.recipientDestination,
        ) ||
        !equalBytes(
          prepared.recipientSpendPublicKey,
          quote.recipientSpendPublicKey,
        ) ||
        !equalBytes(prepared.ephemeralPublicKey, quote.ephemeralPublicKey)
      )
        throw new Error('Prepared payment differs from the reviewed payment')
      const stamp = await quoteStamp()
      if (stamp.maximumNativeFeeAtomic > stampQuote.maximumNativeFeeAtomic)
        throw new Error('Message stamp fee changed; review the payment again')
      return prepared
    },
  }
}

/** Before adoption, only the financial owner can prove an operation is releasable.
 * After adoption, even a rejected send may have durably stored the original operation. */
export async function sendReviewedStealthPayment<T>(
  review: CapturedStealthReview,
  memo: string | undefined,
  send: (
    prepared: PreparedStealthPayment,
    item: ReturnType<typeof recipientAssetPaymentFromPrepared>,
  ) => Promise<T>,
): Promise<T> {
  let adopted = false
  try {
    await review.assertCurrent()
    const prepared = await review.prepare()
    const item = recipientAssetPaymentFromPrepared(prepared, memo)
    await review.assertCurrent()
    adopted = true
    return await send(prepared, item)
  } catch (error) {
    if (!adopted) {
      try {
        await review.releaseUnexposed()
      } catch (cleanupError) {
        throw new Error(
          `Payment was not handed to messaging: ${String(
            error,
          )}. Unexposed operation cleanup failed: ${String(cleanupError)}`,
        )
      }
    }
    throw error
  }
}
