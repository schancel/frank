/** Wallet-owned financial preparation. No message encoding, encryption or transport. */
import { runNativeTransactionExclusive } from './chain-wallet'
import { getAddress, getBytes, hexlify, Interface, Transaction } from 'ethers'
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
import type {
  PreparedNativeTransferParams,
  PreparedContractCallParams,
} from './evm-legacy-consolidator'
import { listEvmSwapVenues } from './dex-deployments'

export const EVM_STEALTH_PREPARATION_NAMESPACE = 'evm-stealth-preparations-v1'
const erc20 = new Interface([
  'function transfer(address to,uint256 amount) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
/** Only intent/link/exposure facts. Signed bytes and nonce claims belong to the operation journal. */
export interface EvmStealthPreparation {
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
    sourceAddress: string
    nativeBalanceAtomic: bigint
    assetBalanceAtomic: bigint
    estimatedNativeFeeAtomic: bigint
  }>
  store: RecordStore<EvmStealthPreparation>
  assertActive(): void
  derive(publicKey: Uint8Array): {
    stealthAddress: string
    ephemeralPubKey: Uint8Array
  }
  operations(): EvmNativeOperation[]
  signNative(params: PreparedNativeTransferParams): Promise<EvmNativeOperation>
  signContractCall(
    params: PreparedContractCallParams,
  ): Promise<EvmNativeOperation>
  submit(id: string): Promise<unknown>
  observe(id: string): Promise<void>
  release(id: string): Promise<unknown>
  tokenBalance(contractAddress: string, sourceAddress: string): Promise<bigint>
  selectTokenSource(contractAddress: string, amount: bigint): Promise<string>
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
    !listEvmSwapVenues(chainIdentifier).some(venue =>
      venue.tokens.some(token => token.address?.toLowerCase() === normalized),
    )
  )
    throw new Error('Unsupported configured ERC20 asset')
  return normalized
}
function validateFeeAuthorization(row: EvmStealthPreparation): void {
  const authorization = row.feeAuthorization
  if (
    !authorization ||
    (authorization.status !== 'unapproved' &&
      authorization.status !== 'approved') ||
    (authorization.status === 'approved' &&
      !/^(0|[1-9][0-9]{0,77})$/.test(authorization.maxNativeFeeAtomic))
  )
    throw new Error('Unsupported stealth preparation fee authorization format')
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
  if (
    row.cancelled ||
    preparation.feeAuthorization.status !== 'approved' ||
    row.binding.chainIdentifier !== preparation.chainIdentifier ||
    row.members.length !== 1
  )
    return false
  const member = row.members[0]!
  const tx = Transaction.from(
    member.signed?.rawTransaction ?? member.unsignedTransaction,
  )
  if (
    tx.chainId !== chainId ||
    (member.signed !== null &&
      tx.from?.toLowerCase() !== member.source.address) ||
    (preparation.sourceAddress !== undefined &&
      member.source.address !== preparation.sourceAddress) ||
    nativeMaximumFee(tx) >
      BigInt(preparation.feeAuthorization.maxNativeFeeAtomic)
  )
    return false
  if (preparation.asset.kind === 'native')
    return (
      row.kind === 'native' &&
      tx.data === '0x' &&
      tx.to?.toLowerCase() === preparation.recipientAddress &&
      tx.value === BigInt(preparation.amountAtomic)
    )
  return (
    row.kind === 'contract' &&
    tx.to?.toLowerCase() === preparation.asset.contractAddress &&
    tx.value === 0n &&
    tx.data.toLowerCase() ===
      erc20
        .encodeFunctionData('transfer', [
          preparation.recipientAddress,
          BigInt(preparation.amountAtomic),
        ])
        .toLowerCase()
  )
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
        await driver.refreshJournal(`stealth-payment:${id}`)
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
        candidate =>
          candidate.preparationId === `stealth-payment:${row.operationId}` &&
          matches(candidate, row, driver.nativeChainId),
      )
    if (row.journalOperationId !== undefined) {
      const linked = candidates.find(
        candidate => candidate.operationId === row.journalOperationId,
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
    members: journal.members.map(member => ({
      rawTransaction: member.signed!.rawTransaction,
      txHash: member.signed!.transactionHash,
      recipientAmountAtomic: BigInt(row.amountAtomic),
    })),
  })
  const progress = async (
    row: EvmStealthPreparation,
  ): Promise<StealthPaymentProgress> => {
    const journal = operation(row)
    const amount = BigInt(row.amountAtomic)
    if (!journal) return { status: 'pending', intendedAmountAtomic: amount }
    const member = journal.members[0]!
    const observation = member.observation
    if (
      observation.state === 'included-revert' ||
      nativeMemberSuperseded(member)
    )
      return {
        status: 'failed',
        intendedAmountAtomic: amount,
        verifiedReceivedAmountAtomic: 0n,
        ...(observation.state === 'included-revert'
          ? { nativeFeeAtomic: BigInt(observation.feeWei) }
          : {}),
      }
    if (observation.state !== 'included-success')
      return { status: 'pending', intendedAmountAtomic: amount }
    const received =
      row.asset.kind === 'native'
        ? amount
        : await driver.tokenReceipt(
            member.signed!.rawTransaction,
            row.recipientAddress,
          )
    driver.assertActive()
    return {
      status:
        received === undefined
          ? 'pending'
          : received === amount
          ? 'succeeded'
          : 'partial',
      intendedAmountAtomic: amount,
      ...(received === undefined
        ? {}
        : { verifiedReceivedAmountAtomic: received }),
      nativeFeeAtomic: BigInt(observation.feeWei),
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
      const selected =
        asset.kind === 'erc20' && immutable.sourceAddress === undefined
          ? await driver.selectTokenSource(
              asset.contractAddress,
              intent.amountAtomic,
            )
          : immutable.sourceAddress
      driver.assertActive()
      const created = {
        ...immutable,
        feeAuthorization: { status: 'unapproved' as const },
        ...(selected === undefined ? {} : { sourceAddress: selected }),
        recipientAddress: getAddress(derived.stealthAddress).toLowerCase(),
        ephemeralPublicKey: hexlify(derived.ephemeralPubKey),
      }
      await driver.store.compareAndPut(intent.operationId, undefined, created)
      driver.assertActive()
      row = read(intent.operationId)
    }
    for (const key of Object.keys(immutable) as (keyof typeof immutable)[])
      if (JSON.stringify(row[key]) !== JSON.stringify(immutable[key]))
        throw new Error('Stealth operation intent conflict')
    validateFeeAuthorization(row)
    if (row.released) throw new Error('Stealth preparation released')
    return row
  }
  return {
    quote: input => {
      const intent = {
        ...input,
        asset: { ...input.asset },
        recipientSpendPublicKey: new Uint8Array(input.recipientSpendPublicKey),
      }
      return exclusive(intent.operationId, async () => {
        const row = await ensureIntent(intent)
        const facts = await driver.quote({
          asset: row.asset,
          recipientAddress: row.recipientAddress,
          amountAtomic: BigInt(row.amountAtomic),
          sourceAddress: row.sourceAddress,
        })
        driver.assertActive()
        if (row.sourceAddress === undefined) {
          const selected = { ...row, sourceAddress: facts.sourceAddress }
          if (
            !(await driver.store.compareAndPut(row.operationId, row, selected))
          )
            throw new Error('Stealth quote source changed')
        } else if (row.sourceAddress !== facts.sourceAddress)
          throw new Error('Stealth quote source conflict')
        return {
          operationId: row.operationId,
          chainIdentifier: row.chainIdentifier,
          asset: { ...row.asset },
          amountAtomic: BigInt(row.amountAtomic),
          recipientAddress: row.recipientAddress,
          recipientDestination: getBytes(row.recipientAddress),
          recipientSpendPublicKey: getBytes(row.recipientSpendPublicKey),
          ephemeralPublicKey: getBytes(row.ephemeralPublicKey),
          ...facts,
        } satisfies StealthPaymentQuote
      })
    },
    prepare: input => {
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
        let row = await ensureIntent(intent)
        if (row.feeAuthorization.status === 'approved') {
          if (
            BigInt(row.feeAuthorization.maxNativeFeeAtomic) !==
            intent.maxNativeFeeAtomic
          )
            throw new Error('Stealth operation fee authorization conflict')
        } else {
          const approved = {
            ...row,
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
        if (!journal || journal.members.some(member => !member.signed)) {
          if (row.payloadDigest !== undefined)
            throw new Error('Exposed preparation lost its signed operation')
          const common = {
            preparationId: `stealth-payment:${intent.operationId}`,
            value: intent.asset.kind === 'native' ? intent.amountAtomic : 0n,
            maxNativeFeeWei: intent.maxNativeFeeAtomic,
            sourceAddress: row.sourceAddress,
          }
          if (asset.kind === 'native')
            journal = await driver.signNative({
              ...common,
              recipient: { raw: row.recipientAddress },
            })
          else {
            if (!row.sourceAddress)
              throw new Error('An owned ERC20 source must be selected')
            const balance = await driver.tokenBalance(
              asset.contractAddress,
              row.sourceAddress,
            )
            driver.assertActive()
            if (balance < intent.amountAtomic)
              throw new RangeError('Insufficient ERC20 funds')
            journal = await driver.signContractCall({
              ...common,
              to: { raw: asset.contractAddress },
              data: erc20.encodeFunctionData('transfer', [
                row.recipientAddress,
                intent.amountAtomic,
              ]),
            })
          }
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
    expose: input => {
      const binding = { ...input }
      return exclusive(binding.operationId, async () => {
        if (!/^[0-9a-fA-F]{64}$/.test(binding.payloadDigest))
          throw new Error('Invalid sealed payload digest')
        const row = read(binding.operationId)
        const journal = operation(row)
        if (
          row.released ||
          !journal ||
          journal.members.some(member => !member.signed)
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
    submit: id =>
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
    reconcile: id =>
      exclusive(id, async () => {
        const row = read(id)
        const journal = operation(row)
        if (journal && row.payloadDigest !== undefined)
          await driver.observe(journal.operationId)
        return progress(read(id))
      }),
    release: id =>
      exclusive(id, async () => {
        const row = read(id)
        if (row.payloadDigest !== undefined) return false
        const journal = operation(row)
        if (journal?.members.some(member => member.exposed)) return false
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
        .filter(row => !row.released)
        .map(row => ({
          operationId: row.operationId,
          ...(row.payloadDigest === undefined
            ? {}
            : { payloadDigest: row.payloadDigest }),
        }))
    },
    async recoverReleases() {
      driver.assertActive()
      for (const row of driver.store.all()) {
        if (!row.released) continue
        const journal = operation(row)
        if (journal) await driver.release(journal.operationId)
      }
    },
    get: id =>
      exclusive(id, async () => {
        const row = driver.store.get(id)
        if (!row || row.released) return undefined
        const journal = operation(row)
        return journal === undefined ||
          journal.members.some(member => !member.signed)
          ? undefined
          : manifest(row, journal)
      }),
    heldSources() {
      const held = new Set<string>()
      for (const row of driver.store.all()) {
        if (row.released) continue
        const journal = operation(row)
        if (
          journal &&
          journal.members[0]!.observation.state !== 'included-success' &&
          journal.members[0]!.observation.state !== 'included-revert' &&
          !nativeMemberSuperseded(journal.members[0]!)
        )
          held.add(journal.members[0]!.source.address)
      }
      return held
    },
    holdsForHost(id) {
      return driver.store
        .all()
        .some(
          row =>
            !row.released &&
            row.payloadDigest === undefined &&
            operation(row)?.operationId === id,
        )
    },
  }
}
