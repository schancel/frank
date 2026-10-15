/** Stable public incarnation encodings. Inputs are admitted host metadata, never roots. */
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
export interface AppIncarnationReceipt {
  readonly schema: number
  readonly policy: string
  readonly context: {
    readonly accountId: string
    readonly creationId: string
    readonly recoveryFormat: string
    readonly registry: string
    readonly purposes: readonly string[]
    readonly custodyEpoch: number
    readonly recoveryFingerprint: string
    readonly retirementContext: string
  }
  readonly previousRevision: number
  readonly revision: number
  readonly operationId: string
}
const hash = (tuple: readonly unknown[]) =>
  bytesToHex(sha256(utf8ToBytes(JSON.stringify(tuple))))
const string = (value: string) => {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    throw new TypeError('Invalid admitted public identity')
  return value
}
const revision = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Invalid admitted revision')
  return value
}
export function appNegotiationIncarnation(
  custodyRevision: number,
  receipt: AppIncarnationReceipt,
): string {
  if (
    receipt.schema !== 1 ||
    receipt.policy !== 'browser-preview-aes-gcm-v1' ||
    receipt.revision !== receipt.previousRevision + 1 ||
    !Array.isArray(receipt.context.purposes)
  )
    throw new TypeError('Admitted custody receipt required')
  const context = receipt.context
  return (
    'app-v1-' +
    hash([
      'frank/swap/app-incarnation/v1',
      revision(custodyRevision),
      revision(receipt.schema),
      string(receipt.policy),
      [
        string(context.accountId),
        string(context.creationId),
        string(context.recoveryFormat),
        string(context.registry),
        context.purposes.map(string),
        revision(context.custodyEpoch),
        string(context.recoveryFingerprint),
        string(context.retirementContext),
      ],
      revision(receipt.previousRevision),
      revision(receipt.revision),
      string(receipt.operationId),
    ])
  )
}
export function botNegotiationIncarnation(owner: {
  readonly botId: string
  readonly chainIdentifier: string
  readonly subject: string
  readonly address: string
}): string {
  return (
    'bot-v1-' +
    hash([
      'frank/swap/bot-incarnation/v1',
      string(owner.botId),
      string(owner.chainIdentifier),
      string(owner.subject),
      string(owner.address),
    ])
  )
}
