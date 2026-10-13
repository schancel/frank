import type {
  StealthPaymentAsset,
  StealthPaymentQuote,
} from '@frank/wallet/stealth-payment'

export interface StealthAssetOption {
  readonly key: string
  readonly chainIdentifier: string
  readonly asset: StealthPaymentAsset
  readonly label: string
  readonly unit: string
  readonly decimals: number
  readonly nativeUnit: string
  readonly nativeDecimals: number
  readonly balanceAtomic?: bigint
}
export interface StealthDialogRequest {
  readonly address: string
  readonly assetKey: string
  readonly chainIdentifier: string
  readonly asset: StealthPaymentAsset
  readonly amountAtomic: bigint
  readonly memo: string
  readonly recipientSpendPublicKey?: Uint8Array
}
export type StealthDialogQuoteState =
  | { readonly status: 'idle' | 'pending' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready'
      readonly request: StealthDialogRequest
      readonly payment: StealthPaymentQuote
      readonly maxNativeFeeAtomic: bigint
      readonly stampValueAtomic: bigint
      /** Estimated sender network fee, separate from the recipient stamp amount. */
      readonly stampFeeAtomic: bigint
      readonly stampUnit: string
      readonly stampDecimals: number
    }
export interface ReviewedStealthDialogIntent extends StealthDialogRequest {
  readonly quote: StealthPaymentQuote
  readonly maxNativeFeeAtomic: bigint
  readonly stampValue: bigint
}
export function stealthAssetKey(
  chainIdentifier: string,
  asset: StealthPaymentAsset,
): string {
  return `${chainIdentifier}:${
    asset.kind === 'native'
      ? 'native'
      : `erc20:${asset.contractAddress.toLowerCase()}`
  }`
}
export function sameStealthAsset(
  a: StealthPaymentAsset,
  b: StealthPaymentAsset,
): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === 'native' ||
      (b.kind === 'erc20' &&
        a.contractAddress.toLowerCase() === b.contractAddress.toLowerCase()))
  )
}
/** Decimal input stays textual until converted directly to atomic bigint. */
export function parseStealthAmount(
  text: string,
  decimals: number,
): bigint | undefined {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255)
    return undefined
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!match || (match[2]?.length ?? 0) > decimals || text.length > 1000)
    return undefined
  const value = BigInt(match[1] + (match[2] ?? '').padEnd(decimals, '0'))
  return value > 0n && value < 2n ** 256n ? value : undefined
}
export function formatStealthAmount(value: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255)
    throw new Error('Invalid asset decimals')
  const sign = value < 0n ? '-' : ''
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(decimals + 1, '0')
  if (!decimals) return sign + digits
  const fraction = digits.slice(-decimals).replace(/0+$/, '')
  return sign + digits.slice(0, -decimals) + (fraction ? '.' + fraction : '')
}
export function sameStealthRequest(
  a: StealthDialogRequest,
  b: StealthDialogRequest,
): boolean {
  return (
    a.address === b.address &&
    a.assetKey === b.assetKey &&
    a.chainIdentifier === b.chainIdentifier &&
    sameStealthAsset(a.asset, b.asset) &&
    a.amountAtomic === b.amountAtomic &&
    a.memo === b.memo
  )
}
