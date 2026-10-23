/** Wallet-owned financial preparation. No message encoding, encryption or transport. */
import { runNativeTransactionExclusive } from './chain-wallet'
import {
  getAddress,
  getBytes,
  hexlify,
  Interface,
  Transaction,
  keccak256,
  toUtf8Bytes,
} from 'ethers'
import type {
  StealthPaymentAsset,
  StealthPaymentCapability,
  PreparedStealthPayment,
  StealthPaymentProgress,
  StealthPaymentIntent,
  StealthPaymentQuote,
} from '../stealth-payment'
import type { RecordStore } from '../storage/evm-coin-store'
import {
  nativeMaximumFee,
  nativeMemberSuperseded,
  type EvmNativeOperation,
} from '../storage/evm-native-operation-journal'
import { EvmNativeOperationPendingError } from './evm-legacy-consolidator'
import type { PreparedIndependentPaymentParams } from './evm-legacy-consolidator'
import { listEvmSwapVenues } from './dex-deployments'
import type { ConstructEvmTransactionSetRequest } from '../evm-transaction-set-types'

export const EVM_STEALTH_PREPARATION_NAMESPACE = 'evm-stealth-preparations-v1'
export const evmStealthTransactionSetOperationId = (id: string): string =>
  `stealth-${keccak256(toUtf8Bytes(id)).slice(2)}`
const erc20 = new Interface([
  'function transfer(address to,uint256 amount) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
/** Only intent/link/exposure facts. Signed bytes and nonce claims belong to the operation journal. */
export interface EvmStealthSourceAllocation {
  sourceAddress: string
  recipientAmountAtomic: string
  nativeBalanceAtomic: string
  assetBalanceAtomic: string
  estimatedNativeFeeAtomic: string
}
export interface EvmStealthPreparation {
  version: 3
  allocation?: { sources: EvmStealthSourceAllocation[] }

  operationId: string
  chainIdentifier: string
  asset: StealthPaymentAsset
  recipientSpendPublicKey: string
  amountAtomic: string
  feeAuthorization:
    | { status: 'unapproved' }
    | { status: 'approved'; maxNativeFeeAtomic: string }
  sourceAddress?: string
  recipientAddress: string
  ephemeralPublicKey: string
  journalOperationId?: string
  payloadDigest?: string
  messageStamp?: { amountAtomic: string; maxNativeFeeAtomic: string }
  released?: true
}
export interface EvmStealthPaymentDriver {
  chainIdentifier: string
  nativeChainId: bigint
  coordinationKey: string
  refreshJournal(preparationId: string): Promise<void>
  quote(input: {
    asset: StealthPaymentAsset
    recipientAddress: string
    amountAtomic: bigint
    sourceAddress?: string
  }): Promise<{
    sources: readonly {
      sourceAddress: string
      recipientAmountAtomic: bigint
      nativeBalanceAtomic: bigint
      assetBalanceAtomic: bigint
      estimatedNativeFeeAtomic: bigint
    }[]
  }>
  store: RecordStore<EvmStealthPreparation>
  assertActive(): void
  derive(publicKey: Uint8Array): {
    stealthAddress: string
    ephemeralPubKey: Uint8Array
  }
  quoteNative(amountWei: bigint): Promise<{
    nativeBalanceAtomic: bigint
    assetBalanceAtomic: bigint
    estimatedNativeFeeAtomic: bigint
  }>
  constructNativePayment(
    params: ConstructEvmTransactionSetRequest,
  ): Promise<EvmNativeOperation>
  operations(): EvmNativeOperation[]
  signIndependentPayment(
    params: PreparedIndependentPaymentParams,
  ): Promise<EvmNativeOperation>
  submit(id: string): Promise<unknown>
  observe(id: string): Promise<void>
  release(id: string): Promise<unknown>
  tokenBalance(contractAddress: string, sourceAddress: string): Promise<bigint>
  tokenReceipt(
    raw: string,
    recipientAddress: string,
  ): Promise<bigint | undefined>
}
export function configuredEvmStealthToken(
  chainIdentifier: string,
  address: string,
): string {
  const normalized = getAddress(address).toLowerCase()
  if (
    !listEvmSwapVenues(chainIdentifier).some((venue) =>
      venue.tokens.some((token) => token.address?.toLowerCase() === normalized),
    )
  )
    throw new Error('Unsupported configured ERC20 asset')
  return normalized
}
function validateFeeAuthorization(row: EvmStealthPreparation): void {
  if (row.version !== 3)
    throw new Error(
      'Unsupported EVM stealth preparation format; development financial preparation reset requires explicit review, never key or wallet deletion',
    )
  if (row.messageStamp && (row.asset.kind !== 'native' ||
      !/^[1-9][0-9]{0,77}$/.test(row.messageStamp.amountAtomic) ||
      !/^(0|[1-9][0-9]{0,77})$/.test(row.messageStamp.maxNativeFeeAtomic) ||
      BigInt(row.messageStamp.amountAtomic) >= 1n << 256n ||
      BigInt(row.messageStamp.maxNativeFeeAtomic) >= 1n << 256n))
    throw new Error('Invalid combined message stamp authorization')
  if (row.allocation) validateAllocation(row)
  const authorization = row.feeAuthorization
  if (
    !authorization ||
    (authorization.status !== 'unapproved' &&
      authorization.status !== 'approved') ||
    (authorization.status === 'approved' &&
      (!/^(0|[1-9][0-9]{0,77})$/.test(authorization.maxNativeFeeAtomic) ||
        BigInt(authorization.maxNativeFeeAtomic) >= 1n << 256n))
  )
    throw new Error('Unsupported stealth preparation fee authorization format')
  if (
    authorization.status === 'approved' &&
    row.asset.kind !== 'native' &&
    !row.allocation
  )
    throw new Error('Approved EVM preparation has no frozen source allocation')
}
function validateAllocation(row: EvmStealthPreparation): void {
  const sources = row.allocation?.sources
  if (!sources || !sources.length || sources.length > 16)
    throw new Error('Invalid EVM source allocation')
  const seen = new Set<string>()
  let amount = 0n
  for (const source of sources) {
    if (
      getAddress(source.sourceAddress).toLowerCase() !== source.sourceAddress ||
      seen.has(source.sourceAddress)
    )
      throw new Error('Invalid EVM source allocation address')
    seen.add(source.sourceAddress)
    for (const field of [
      'recipientAmountAtomic',
      'nativeBalanceAtomic',
      'assetBalanceAtomic',
      'estimatedNativeFeeAtomic',
    ] as const)
      if (
        !/^(0|[1-9][0-9]{0,77})$/.test(source[field]) ||
        BigInt(source[field]) >= 1n << 256n
      )
        throw new Error('Invalid EVM source allocation amount')
    const value = BigInt(source.recipientAmountAtomic),
      fee = BigInt(source.estimatedNativeFeeAtomic)
    if (
      value <= 0n ||
      BigInt(source.assetBalanceAtomic) < value ||
      BigInt(source.nativeBalanceAtomic) <
        fee + (row.asset.kind === 'native' ? value : 0n)
    )
      throw new Error('EVM source allocation is not spendable')
    if (
      row.asset.kind === 'native' &&
      source.assetBalanceAtomic !== source.nativeBalanceAtomic
    )
      throw new Error('Native allocation balance mismatch')
    amount += value
  }
  if (
    amount !== BigInt(row.amountAtomic) ||
    (row.sourceAddress !== undefined &&
      (sources.length !== 1 || sources[0]!.sourceAddress !== row.sourceAddress))
  )
    throw new Error('EVM source allocation differs from intended payment')
}
function assetOf(
  chainIdentifier: string,
  asset: StealthPaymentAsset,
): StealthPaymentAsset {
  if (asset.kind === 'native') return { kind: 'native' }
  if (asset.kind !== 'erc20')
    throw new Error('Unsupported stealth payment asset')
  return {
    kind: 'erc20',
    contractAddress: configuredEvmStealthToken(
      chainIdentifier,
      asset.contractAddress,
    ),
  }
}
/** Strict exact signed-transfer match also repairs a crash between signing and linking the journal. */
function matches(
  row: EvmNativeOperation,
  preparation: EvmStealthPreparation,
  chainId: bigint,
): boolean {
  validateFeeAuthorization(preparation)
  if (preparation.asset.kind === 'native') {
    if (
      row.cancelled ||
      row.kind !== 'transaction-set' ||
      preparation.feeAuthorization.status !== 'approved' ||
      row.binding.chainIdentifier !== preparation.chainIdentifier ||
      row.intendedValueWei !== preparation.amountAtomic.toString()
    )
      return false
    const payments = row.members.filter(
      (member) => (member.transactionSet?.role === 'payment' && member.transactionSet.stageId === undefined),
    )
    if (!payments.length || row.members.some((member) => !member.signed))
      return false
    const totalFee = row.members.reduce(
      (sum, member) =>
        sum + nativeMaximumFee(Transaction.from(member.signed!.rawTransaction)),
      0n,
    )
    return (
      totalFee <= BigInt(preparation.feeAuthorization.maxNativeFeeAtomic) + BigInt(preparation.messageStamp?.maxNativeFeeAtomic ?? 0) &&
      payments.every((member) => {
        const tx = Transaction.from(member.signed!.rawTransaction)
        return (
          tx.chainId === chainId &&
          tx.data === '0x' &&
          tx.to?.toLowerCase() === preparation.recipientAddress &&
          tx.from?.toLowerCase() === member.source.address
        )
      }) &&
      payments.reduce(
        (sum, member) =>
          sum + Transaction.from(member.signed!.rawTransaction).value,
        0n,
      ) >= BigInt(preparation.amountAtomic)
    )
  }
  if (
    row.cancelled ||
    preparation.feeAuthorization.status !== 'approved' ||
    row.binding.chainIdentifier !== preparation.chainIdentifier ||
    row.members.length !== preparation.allocation?.sources.length
  )
    return false
  let fee = 0n
  for (let i = 0; i < row.members.length; i++) {
    const member = row.members[i]!,
      allocation = preparation.allocation!.sources[i]!
    const tx = Transaction.from(
      member.signed?.rawTransaction ?? member.unsignedTransaction,
    )
    fee += nativeMaximumFee(tx)
    if (
      tx.chainId !== chainId ||
      member.dependencies.length ||
      member.source.address !== allocation.sourceAddress ||
      (member.signed !== null &&
        tx.from?.toLowerCase() !== member.source.address)
    )
      return false
    if (
      row.kind !== 'contract' ||
      row.submissionPolicy !== 'explicit' ||
      tx.to?.toLowerCase() !== preparation.asset.contractAddress ||
      tx.value !== 0n ||
      tx.data.toLowerCase() !==
        erc20
          .encodeFunctionData('transfer', [
            preparation.recipientAddress,
            BigInt(allocation.recipientAmountAtomic),
          ])
          .toLowerCase()
    )
      return false
  }
  return fee <= BigInt(preparation.feeAuthorization.maxNativeFeeAtomic)
}
export function createEvmStealthPayments(
  driver: EvmStealthPaymentDriver,
): StealthPaymentCapability & {
  heldSources(): Set<string>
  holdsForHost(id: string): boolean
  recoverReleases(): Promise<void>
} {
  // The lock spans this business operation's lookup/sign/link, never another payment's RPC.
  const exclusive = <T>(id: string, work: () => Promise<T>): Promise<T> =>
    runNativeTransactionExclusive(
      `evm-stealth-preparation:${driver.coordinationKey}:${id}`,
      'single-realm',
      async () => {
        driver.assertActive()
        await driver.store.refresh()
        const retained = driver.store.get(id)
        if (retained)
          await driver.refreshJournal(
            retained.asset.kind === 'native'
              ? `evm-transaction-set:${evmStealthTransactionSetOperationId(id)}`
              : `stealth-payment:${id}`,
          )
        driver.assertActive()
        return work()
      },
    )
  const read = (id: string): EvmStealthPreparation => {
    driver.assertActive()
    const row = driver.store.get(id)
    if (
      !row ||
      row.chainIdentifier !== driver.chainIdentifier ||
      row.operationId !== id
    )
      throw new Error('Unknown stealth preparation')
    validateFeeAuthorization(row)
    return row
  }
  const operation = (
    row: EvmStealthPreparation,
  ): EvmNativeOperation | undefined => {
    const candidates = driver
      .operations()
      .filter(
        (candidate) =>
          candidate.preparationId ===
            (row.asset.kind === 'native'
              ? `evm-transaction-set:${evmStealthTransactionSetOperationId(
                  row.operationId,
                )}`
              : `stealth-payment:${row.operationId}`) &&
          matches(candidate, row, driver.nativeChainId),
      )
    if (row.journalOperationId !== undefined) {
      const linked = candidates.find(
        (candidate) => candidate.operationId === row.journalOperationId,
      )
      if (!linked && !row.released)
        throw new Error('Stealth preparation journal mismatch')
      return linked
    }
    if (candidates.length > 1)
      throw new Error('Ambiguous stealth preparation journal link')
    return candidates[0]
  }
  const manifest = (
    row: EvmStealthPreparation,
    journal: EvmNativeOperation,
  ): PreparedStealthPayment => ({
    operationId: row.operationId,
    chainIdentifier: row.chainIdentifier,
    asset: { ...row.asset },
    amountAtomic: BigInt(row.amountAtomic),
    recipientAddress: row.recipientAddress,
    recipientDestination: getBytes(row.recipientAddress),
    recipientSpendPublicKey: getBytes(row.recipientSpendPublicKey),
    ephemeralPublicKey: getBytes(row.ephemeralPublicKey),
    members: journal.members
      .filter(
        (member) =>
          row.asset.kind !== 'native' ||
          (member.transactionSet?.role === 'payment' && member.transactionSet.stageId === undefined),
      )
      .map((member, index) => ({
        rawTransaction: member.signed!.rawTransaction,
        txHash: member.signed!.transactionHash,
        recipientAmountAtomic: BigInt(
          row.asset.kind === 'native'
            ? BigInt(member.transactionSet!.intendedValueWei ?? Transaction.from(member.signed!.rawTransaction).value)
            : row.allocation!.sources[index]!.recipientAmountAtomic,
        ),
      })),
  })
  const progress = async (
    row: EvmStealthPreparation,
  ): Promise<StealthPaymentProgress> => {
    const journal = operation(row)
    const amount = BigInt(row.amountAtomic)
    if (!journal) return { status: 'pending', intendedAmountAtomic: amount }
    let received = 0n,
      fee = 0n,
      known = 0,
      failed = 0
    let feeKnown = false
    for (const member of journal.members)
      if ('feeWei' in member.observation && member.transactionSet?.stageId === undefined) {
        feeKnown = true
        fee += BigInt(member.observation.feeWei)
      }
    const paymentMembers = journal.members.filter(
      (member) =>
        row.asset.kind !== 'native' ||
        (member.transactionSet?.role === 'payment' && member.transactionSet.stageId === undefined),
    )
    for (let i = 0; i < paymentMembers.length; i++) {
      const member = paymentMembers[i]!,
        observation = member.observation
      if (
        observation.state === 'included-revert' ||
        nativeMemberSuperseded(member)
      ) {
        known++
        failed++
        continue
      }
      if (observation.state !== 'included-success') continue
      const value =
        row.asset.kind === 'native'
          ? Transaction.from(member.signed!.rawTransaction).value
          : await driver.tokenReceipt(
              member.signed!.rawTransaction,
              row.recipientAddress,
            )
      driver.assertActive()
      if (value !== undefined) {
        known++
        received += value
      }
    }
    return {
      status:
        received >= amount && known === paymentMembers.length
          ? 'succeeded'
          : received > 0n ||
            (known === paymentMembers.length && failed < paymentMembers.length)
          ? 'partial'
          : failed === paymentMembers.length
          ? 'failed'
          : 'pending',
      intendedAmountAtomic: amount,
      ...(known ? { verifiedReceivedAmountAtomic: received } : {}),
      ...(feeKnown ? { nativeFeeAtomic: fee } : {}),
    }
  }

  const ensureIntent = async (
    intent: Omit<StealthPaymentIntent, 'maxNativeFeeAtomic'>,
  ): Promise<EvmStealthPreparation> => {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(intent.operationId) ||
      intent.chainIdentifier !== driver.chainIdentifier ||
      intent.amountAtomic <= 0n ||
      intent.amountAtomic >= 1n << 256n
    )
      throw new Error('Invalid stealth payment intent')
    const asset = assetOf(driver.chainIdentifier, intent.asset)
    if (asset.kind === 'native' && intent.sourceAddress !== undefined)
      throw new Error(
        'Shared native payments do not support a caller-selected source',
      )
    const immutable = {
      operationId: intent.operationId,
      chainIdentifier: intent.chainIdentifier,
      asset,
      recipientSpendPublicKey: hexlify(intent.recipientSpendPublicKey),
      amountAtomic: intent.amountAtomic.toString(),
      ...(intent.sourceAddress === undefined
        ? {}
        : {
            sourceAddress: getAddress(intent.sourceAddress).toLowerCase(),
          }),
    }
    let row = driver.store.get(intent.operationId)
    if (row === undefined) {
      const derived = driver.derive(intent.recipientSpendPublicKey)
      driver.assertActive()
      const created = {
        ...immutable,
        version: 3 as const,
        feeAuthorization: { status: 'unapproved' as const },
        recipientAddress: getAddress(derived.stealthAddress).toLowerCase(),
        ephemeralPublicKey: hexlify(derived.ephemeralPubKey),
      }
      await driver.store.compareAndPut(intent.operationId, undefined, created)
      driver.assertActive()
      row = read(intent.operationId)
    }
    for (const key of Object.keys(immutable) as (keyof typeof immutable)[]) {
      // An explicit restriction may confirm the sole already-quoted source, never redirect it.
      if (
        key === 'sourceAddress' &&
        row.sourceAddress === undefined &&
        row.allocation?.sources.length === 1 &&
        row.allocation.sources[0]!.sourceAddress === immutable.sourceAddress
      )
        continue
      if (JSON.stringify(row[key]) !== JSON.stringify(immutable[key]))
        throw new Error('Stealth operation intent conflict')
    }
    validateFeeAuthorization(row)
    if (row.released) throw new Error('Stealth preparation released')
    return row
  }
  const ensureAllocation = async (
    row: EvmStealthPreparation,
  ): Promise<EvmStealthPreparation> => {
    if (row.asset.kind === 'native' || row.allocation) return row
    const facts = await driver.quote({
      asset: row.asset,
      recipientAddress: row.recipientAddress,
      amountAtomic: BigInt(row.amountAtomic),
      sourceAddress: row.sourceAddress,
    })
    driver.assertActive()
    const allocated: EvmStealthPreparation = {
      ...row,
      allocation: {
        sources: facts.sources.map((source) => ({
          sourceAddress: getAddress(source.sourceAddress).toLowerCase(),
          recipientAmountAtomic: source.recipientAmountAtomic.toString(),
          nativeBalanceAtomic: source.nativeBalanceAtomic.toString(),
          assetBalanceAtomic: source.assetBalanceAtomic.toString(),
          estimatedNativeFeeAtomic: source.estimatedNativeFeeAtomic.toString(),
        })),
      },
    }
    validateAllocation(allocated)
    if (!(await driver.store.compareAndPut(row.operationId, row, allocated)))
      throw new Error('Stealth allocation changed; retry original operation')
    return allocated
  }
  return {
    supportsCombinedStamp: true,
    quote: (input) => {
      const intent = {
        ...input,
        asset: { ...input.asset },
        recipientSpendPublicKey: new Uint8Array(input.recipientSpendPublicKey),
      }
      return exclusive(intent.operationId, async () => {
        const intentRow = await ensureIntent(intent)
        const row =
          intentRow.asset.kind === 'native'
            ? intentRow
            : await ensureAllocation(intentRow)
        if (row.asset.kind === 'native')
          return {
            operationId: row.operationId,
            chainIdentifier: row.chainIdentifier,
            asset: row.asset,
            amountAtomic: BigInt(row.amountAtomic),
            recipientAddress: row.recipientAddress,
            recipientDestination: getBytes(row.recipientAddress),
            recipientSpendPublicKey: getBytes(row.recipientSpendPublicKey),
            ephemeralPublicKey: getBytes(row.ephemeralPublicKey),
            sources: [],
            ...await driver.quoteNative(BigInt(row.amountAtomic)),
          } satisfies StealthPaymentQuote
        const sources = row.allocation!.sources.map((source) => ({
          sourceAddress: source.sourceAddress,
          recipientAmountAtomic: BigInt(source.recipientAmountAtomic),
          nativeBalanceAtomic: BigInt(source.nativeBalanceAtomic),
          assetBalanceAtomic: BigInt(source.assetBalanceAtomic),
          estimatedNativeFeeAtomic: BigInt(source.estimatedNativeFeeAtomic),
        }))
        return {
          operationId: row.operationId,
          chainIdentifier: row.chainIdentifier,
          asset: { ...row.asset },
          amountAtomic: BigInt(row.amountAtomic),
          recipientAddress: row.recipientAddress,
          recipientDestination: getBytes(row.recipientAddress),
          recipientSpendPublicKey: getBytes(row.recipientSpendPublicKey),
          ephemeralPublicKey: getBytes(row.ephemeralPublicKey),
          sources,
          ...(sources.length === 1
            ? { sourceAddress: sources[0]!.sourceAddress }
            : {}),
          nativeBalanceAtomic: sources.reduce(
            (sum, source) => sum + source.nativeBalanceAtomic,
            0n,
          ),
          assetBalanceAtomic: sources.reduce(
            (sum, source) => sum + source.assetBalanceAtomic,
            0n,
          ),
          estimatedNativeFeeAtomic: sources.reduce(
            (sum, source) => sum + source.estimatedNativeFeeAtomic,
            0n,
          ),
        } satisfies StealthPaymentQuote
      })
    },
    prepare: (input) => {
      const intent = {
        ...input,
        asset: { ...input.asset },
        recipientSpendPublicKey: new Uint8Array(input.recipientSpendPublicKey),
      }
      return exclusive(intent.operationId, async () => {
        driver.assertActive()
        if (
          intent.maxNativeFeeAtomic < 0n ||
          intent.maxNativeFeeAtomic >= 1n << 256n
        )
          throw new Error('Invalid stealth fee ceiling')
        let row = await ensureAllocation(await ensureIntent(intent))
        const messageStamp = intent.messageStamp === undefined ? undefined : {
          amountAtomic: intent.messageStamp.amountAtomic.toString(),
          maxNativeFeeAtomic: intent.messageStamp.maxNativeFeeAtomic.toString(),
        }
        if (messageStamp && (row.asset.kind !== 'native' || intent.messageStamp!.amountAtomic <= 0n ||
            intent.messageStamp!.amountAtomic >= 1n << 256n || intent.messageStamp!.maxNativeFeeAtomic < 0n ||
            intent.messageStamp!.maxNativeFeeAtomic >= 1n << 256n))
          throw new Error('Invalid combined message stamp authorization')
        if (row.feeAuthorization.status === 'approved') {
          if (JSON.stringify(row.messageStamp) !== JSON.stringify(messageStamp))
            throw new Error('Stealth message stamp authorization conflict')
          if (
            BigInt(row.feeAuthorization.maxNativeFeeAtomic) !==
            intent.maxNativeFeeAtomic
          )
            throw new Error('Stealth operation fee authorization conflict')
        } else {
          const approved = {
            ...row,
            ...(messageStamp ? { messageStamp } : {}),
            feeAuthorization: {
              status: 'approved' as const,
              maxNativeFeeAtomic: intent.maxNativeFeeAtomic.toString(),
            },
          }
          if (
            !(await driver.store.compareAndPut(row.operationId, row, approved))
          )
            throw new Error('Stealth fee authorization changed')
          row = approved
        }
        const asset = row.asset
        let journal = operation(row)
        if (!journal || journal.members.some((member) => !member.signed)) {
          if (row.payloadDigest !== undefined)
            throw new Error('Exposed preparation lost its signed operation')
          if (asset.kind === 'erc20')
            for (const source of row.allocation!.sources) {
              const balance = await driver.tokenBalance(
                asset.contractAddress,
                source.sourceAddress,
              )
              driver.assertActive()
              if (balance < BigInt(source.recipientAmountAtomic))
                throw new RangeError(
                  'Insufficient ERC20 funds at quoted source',
                )
            }
          journal =
            asset.kind === 'native'
              ? await driver.constructNativePayment({
                  operationId: evmStealthTransactionSetOperationId(
                    intent.operationId,
                  ),
                  amountWei: BigInt(row.amountAtomic),
                  kdf: () => row.recipientAddress,
                  maxFeeWei: intent.maxNativeFeeAtomic + (intent.messageStamp?.maxNativeFeeAtomic ?? 0n),
                  ...(intent.messageStamp ? { reserveForContinuationWei:
                    intent.messageStamp.amountAtomic + intent.messageStamp.maxNativeFeeAtomic } : {}),
                })
              : await driver.signIndependentPayment({
                  preparationId: `stealth-payment:${intent.operationId}`,
                  kind: 'contract',
                  recipient: { raw: asset.contractAddress },
                  maxNativeFeeWei: intent.maxNativeFeeAtomic,
                  members: row.allocation!.sources.map((source) => ({
                    sourceAddress: source.sourceAddress,
                    value: 0n,
                    data: erc20.encodeFunctionData('transfer', [
                      row.recipientAddress,
                      BigInt(source.recipientAmountAtomic),
                    ]),
                  })),
                })
          driver.assertActive()
          if (!matches(journal, row, driver.nativeChainId))
            throw new Error('Prepared transaction differs from intent')
        }
        if (row.journalOperationId === undefined) {
          const linked = { ...row, journalOperationId: journal.operationId }
          if (!(await driver.store.compareAndPut(row.operationId, row, linked)))
            throw new Error(
              'Stealth preparation changed; retry original operation',
            )
          row = linked
        }
        return manifest(row, journal)
      })
    },
    expose: (input) => {
      const binding = { ...input }
      return exclusive(binding.operationId, async () => {
        if (!/^[0-9a-fA-F]{64}$/.test(binding.payloadDigest))
          throw new Error('Invalid sealed payload digest')
        const row = read(binding.operationId)
        const journal = operation(row)
        if (
          row.released ||
          !journal ||
          journal.members.some((member) => !member.signed)
        )
          throw new Error('Stealth preparation unavailable')
        const digest = binding.payloadDigest.toLowerCase()
        if (row.payloadDigest !== undefined) {
          if (row.payloadDigest !== digest)
            throw new Error('Stealth exposure digest conflict')
          return
        }
        if (
          !(await driver.store.compareAndPut(row.operationId, row, {
            ...row,
            payloadDigest: digest,
          }))
        )
          throw new Error('Stealth exposure changed; retry original binding')
        driver.assertActive()
      })
    },
    submit: (id) =>
      exclusive(id, async () => {
        const row = read(id)
        if (row.released || row.payloadDigest === undefined)
          throw new Error(
            'Stealth payment has no durable host exposure binding',
          )
        const journal = operation(row)
        if (!journal) throw new Error('Stealth signed operation unavailable')
        // Transport uncertainty is reconciled through the original journal. No replacement payment.
        try {
          await driver.submit(journal.operationId)
        } catch (error) {
          if (!(error instanceof EvmNativeOperationPendingError)) throw error
        }
        driver.assertActive()
        return progress(read(id))
      }),
    reconcile: (id) =>
      exclusive(id, async () => {
        const row = read(id)
        const journal = operation(row)
        if (journal && row.payloadDigest !== undefined)
          await driver.observe(journal.operationId)
        return progress(read(id))
      }),
    release: (id) =>
      exclusive(id, async () => {
        const row = read(id)
        if (row.payloadDigest !== undefined) return false
        const journal = operation(row)
        if (journal?.members.some((member) => member.exposed)) return false
        if (
          !row.released &&
          !(await driver.store.compareAndPut(id, row, {
            ...row,
            released: true,
          }))
        )
          return false
        if (journal) await driver.release(journal.operationId)
        return true
      }),
    async list() {
      driver.assertActive()
      await driver.store.refresh()
      driver.assertActive()
      return driver.store
        .all()
        .filter((row) => {
          validateFeeAuthorization(row)
          return !row.released
        })
        .map((row) => ({
          operationId: row.operationId,
          ...(row.payloadDigest === undefined
            ? {}
            : { payloadDigest: row.payloadDigest }),
        }))
    },
    async recoverReleases() {
      driver.assertActive()
      for (const row of driver.store.all()) {
        validateFeeAuthorization(row)
        if (!row.released) continue
        const journal = operation(row)
        if (journal) await driver.release(journal.operationId)
      }
    },
    get: (id) =>
      exclusive(id, async () => {
        const row = driver.store.get(id)
        if (!row || row.released) return undefined
        const journal = operation(row)
        return journal === undefined ||
          journal.members.some((member) => !member.signed)
          ? undefined
          : manifest(row, journal)
      }),
    heldSources() {
      const held = new Set<string>()
      for (const row of driver.store.all()) {
        if (row.released) continue
        const journal = operation(row)
        if (journal)
          for (const member of journal.members)
            if (
              member.observation.state !== 'included-success' &&
              member.observation.state !== 'included-revert' &&
              !nativeMemberSuperseded(member)
            )
              held.add(member.source.address)
      }
      return held
    },
    holdsForHost(id) {
      return driver.store
        .all()
        .some(
          (row) =>
            !row.released &&
            row.payloadDigest === undefined &&
            operation(row)?.operationId === id,
        )
    },
  }
}
