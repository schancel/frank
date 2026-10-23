import { computeAddress, getAddress, SigningKey, Transaction } from 'ethers'
import { computeGeometricRadixChangeSplits } from './evm-change-distribution'
import type {
  CoinPart,
  EvmListCoin,
  EvmCoinAccountProjection,
} from './evm-coin-list'
import type {
  EvmNativeMemberPlan,
  EvmNativeOperation,
  EvmNativeObservation,
  EvmNativeAccountObservation,
} from './storage/evm-native-operation-journal'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from './evm-transaction-set-types'
import { nativeMemberSuperseded } from './storage/evm-native-operation-journal'
import type {
  ConstructEvmTransactionSetRequest,
  EvmTransactionSetPreparerOptions,
  EvmTransactionSetPolicy,
  PreparedEvmTransaction,
  PreparedEvmTransactionSet,
} from './evm-transaction-set-types'
export type {
  ConstructEvmTransactionSetRequest,
  EvmTransactionSetPreparerOptions,
  EvmTransactionSetPolicy,
  PreparedEvmTransaction,
  PreparedEvmTransactionSet,
} from './evm-transaction-set-types'

const prefix = 'evm-transaction-set:'
interface PaymentContext {
  destination: string
  gas: bigint
  feeIsExact: boolean
}
interface LocalMember {
  plan: EvmNativeMemberPlan
  raw: string
}

export class EvmTransactionSetSourceHeldError extends Error {
  constructor() {
    super('Account is reserved by a shared EVM transaction set')
    this.name = 'EvmTransactionSetSourceHeldError'
  }
}

/** One family adapter: inventory owns reservations; the journal owns signed attempt bytes.
 * No provider is accepted here. Fee/gas observations and inclusion evidence arrive from outside. */
export class EvmTransactionSetPreparer {
  private readonly recoverySpendRule: EvmTransactionSetPolicy['spendRule']
  constructor(private readonly options: EvmTransactionSetPreparerOptions) {
    const rule = options.recoverySpendRule
    if (
      rule &&
      (rule.belowWei < 0n ||
        !Number.isSafeInteger(rule.waitBlocks) ||
        rule.waitBlocks < 0)
    )
      throw new Error('Invalid static EVM recovery spend rule')
    this.recoverySpendRule =
      rule === undefined ? undefined : Object.freeze({ ...rule })
    this.restoreReservations()
  }

  restoreReservations(): void {
    for (const row of this.options.journal.list())
      if (row.kind === 'transaction-set' && !row.cancelled) this.restoreRow(row)
  }

  getOperation(operationId: string): EvmNativeOperation | undefined {
    return this.options.journal
      .list()
      .find(
        row =>
          row.kind === 'transaction-set' &&
          row.preparationId === prefix + operationId,
      )
  }

  transactionSetPolicy(): EvmTransactionSetPolicy {
    return this.options.policy()
  }

  /** Release a signed set only while no member has been handed to an external broadcaster. */
  async releaseUnexposed(operationId: string): Promise<boolean> {
    const row = this.options.journal.get(operationId)
    if (
      !row ||
      row.kind !== 'transaction-set' ||
      row.cancelled ||
      row.members.some(member => member.exposed)
    )
      return false
    // Cancel the durable journal authority first. If inventory persistence is interrupted,
    // wallet reopen sees the cancelled operation and can safely release its stale projection.
    await this.options.journal.discardUnexposed(operationId)
    await this.options.coins.releaseUnexposed(operationId)
    return true
  }

  /** RPC-free admission view for account-based maintenance. Inventory owns provisional
   * construction/projection; the journal retains every pending signed nonce across reopen. */
  isSourceReserved(account: string): boolean {
    const key = account.toLowerCase()
    return this.options.coins.isAccountReserved(key) || this.options.journal.list().some(row =>
      row.kind === 'transaction-set' && !row.cancelled && row.members.some(member =>
        member.source.address === key &&
        member.observation.state !== 'included-success' &&
        member.observation.state !== 'included-revert' &&
        !nativeMemberSuperseded(member),
      ),
    )
  }

  async markExposed(operationId: string, memberIndex: number): Promise<void> {
    const row = this.getOperation(operationId)
    if (!row) throw new Error('Unknown transaction-set operation')
    const member = row.members[memberIndex]
    if (!member) throw new Error('Unknown transaction-set member')
    const wait = member.transactionSet?.predecessorWaitBlocks
    if (wait !== undefined) {
      const predecessor = row.members[member.dependencies[0]!]!.observation
      if (
        !('blockNumber' in predecessor) ||
        this.options.policy().head < predecessor.blockNumber + wait
      )
        throw new Error(
          'Transaction-set predecessor quiet window is not satisfied',
        )
    }
    await this.options.journal.markExposed(row.operationId, memberIndex)
  }

  async recordObservation(
    operationId: string,
    memberIndex: number,
    observation: EvmNativeObservation,
    account: EvmNativeAccountObservation | null,
  ): Promise<boolean> {
    const row = this.getOperation(operationId)
    const member = row?.members[memberIndex]
    if (!member) throw new Error('Unknown transaction-set member')
    const frozenObservation = { ...observation }
    const frozenAccount = account === null ? null : { ...account }
    return this.options.coins.projectTransactionSetAccount(
      member.source.address,
      `${row!.operationId}:${memberIndex}`,
      writer =>
        this.applyObservation(
          operationId,
          memberIndex,
          frozenObservation,
          frozenAccount,
          writer,
        ),
    )
  }

  private async applyObservation(
    operationId: string,
    memberIndex: number,
    observation: EvmNativeObservation,
    account: EvmNativeAccountObservation | null,
    writer: EvmCoinAccountProjection,
  ): Promise<boolean> {
    const { journal, coins } = this.options
    const row = this.getOperation(operationId)
    if (!row) throw new Error('Unknown transaction-set operation')
    const capture = await journal.beginCapture(row.operationId, memberIndex)
    const recorded = await journal.recordObservation(
      capture,
      observation,
      account,
    )
    if (!recorded) return false
    const current = journal.get(row.operationId),
      member = current.members[memberIndex]!
    const tx = Transaction.from(member.unsignedTransaction),
      meta = member.transactionSet!
    if (meta.inventoryApplied === true) {
      coins.completeTransactionSetProjection(
        member.source.address,
        `${row.operationId}:${memberIndex}`,
      )
      return true
    }
    if (
      observation.state === 'included-success' ||
      observation.state === 'included-revert' ||
      (observation.state === 'missing' &&
        account !== null &&
        account.nonce > tx.nonce)
    )
      coins.requireTransactionSetProjection(
        member.source.address,
        `${row.operationId}:${memberIndex}`,
      )
    const source = coins
      .all()
      .find(coin => coin.account === member.source.address)
    if (!source)
      throw new Error('Transaction-set source key restoration required')
    const superseded =
      observation.state === 'missing' &&
      account !== null &&
      account.nonce > tx.nonce
    if (
      observation.state === 'included-success' ||
      observation.state === 'included-revert' ||
      superseded
    ) {
      const block =
        'blockNumber' in observation
          ? observation.blockNumber
          : account!.blockNumber
      await writer.recordMined(
        { account: member.source.address, nonce: tx.nonce },
        { block },
      )
      if (observation.state === 'included-success' && meta.role === 'change') {
        const target = this.options.deriveChange(meta.changeIndex!)
        if (
          target.account.toLowerCase() !== tx.to!.toLowerCase() ||
          computeAddress(target.privateKey).toLowerCase() !==
            target.account.toLowerCase()
        )
          throw new Error('Change derivation does not match signed transaction')
        if (!coins.latestOf(target.account)) {
          const rule = this.recoverySpendRule
          await coins.put({
            account: target.account,
            nonce: 0,
            privateKey: target.privateKey,
            valueWei: tx.value,
            origin: 'change',
            changeIndex: meta.changeIndex,
            ...(rule && tx.value < rule.belowWei
              ? {
                  spendableFromBlock: observation.blockNumber + rule.waitBlocks,
                }
              : {}),
          })
        }
      }
      const lastOfSource = current.members
        .filter(candidate => candidate.source.address === member.source.address)
        .at(-1)!
      const finalNonce = Transaction.from(
        lastOfSource.unsignedTransaction,
      ).nonce
      if (
        account &&
        account.nonce > finalNonce &&
        (coins.latestOf(source.account)?.nonce ?? 0) <= account.nonce
      ) {
        const existing = coins.get(member.source.address, account.nonce)
        if (!existing || existing.state === 'unspent') {
          const rule = this.recoverySpendRule
          await writer.put({
            account: source.account,
            nonce: account.nonce,
            lastSpentInBlock: existing?.lastSpentInBlock ?? account.blockNumber,
            privateKey: source.privateKey,
            valueWei: BigInt(account.balanceWei),
            origin: source.origin,
            ...(source.changeIndex === undefined
              ? {}
              : { changeIndex: source.changeIndex }),
            ...(rule && BigInt(account.balanceWei) < rule.belowWei
              ? { spendableFromBlock: account.blockNumber + rule.waitBlocks }
              : {}),
          })
        }
      }
      if (observation.state === 'included-success')
        await journal.markSyncApplied(row.operationId, memberIndex)
      if (account && account.nonce > tx.nonce) {
        await journal.markTransactionSetInventoryApplied(
          row.operationId,
          memberIndex,
        )
        coins.settleTransactionSetKeyReference(member.source.address, tx.nonce)
        coins.completeTransactionSetProjection(
          member.source.address,
          `${row.operationId}:${memberIndex}`,
        )
      }
    }
    return true
  }

  constructTransactionSet(
    request: ConstructEvmTransactionSetRequest,
  ): Promise<PreparedEvmTransactionSet> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId))
      return Promise.reject(new Error('Invalid transaction-set operation ID'))
    return this.options.coins
      .constructTransactionSetOnce(request.operationId, () =>
        this.construct(request),
      )
      .then(result => {
        this.validateReplay(request, this.getOperation(request.operationId)!)
        return result
      })
  }

  private validateReplay(
    request: ConstructEvmTransactionSetRequest,
    row: EvmNativeOperation,
  ): void {
    if (
      row.cancelled ||
      row.intendedValueWei !== request.amountWei.toString() ||
      row.members.some(
        member =>
          member.transactionSet?.role === 'payment' &&
          Transaction.from(member.unsignedTransaction).data !==
            (request.calldata ?? '0x').toLowerCase(),
      ) ||
      (request.maxFeeWei !== undefined &&
        BigInt(row.maximumFeeWei) > request.maxFeeWei)
    )
      throw new Error(
        'Transaction-set operation ID conflicts with original intent',
      )
  }

  private async construct(
    request: ConstructEvmTransactionSetRequest,
  ): Promise<PreparedEvmTransactionSet> {
    const { journal, coins } = this.options
    const existing = await journal.refreshPreparation(
      prefix + request.operationId,
    )
    if (existing) {
      this.validateReplay(request, existing)
      if (existing.members.some(member => !member.signed))
        throw new Error('Incomplete transaction-set journal record')
      this.restoreRow(existing)
      return this.result(existing)
    }
    const data = request.calldata ?? '0x'
    if (
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(data) ||
      request.amountWei < 0n ||
      request.amountWei >= 1n << 256n ||
      (request.amountWei === 0n && data === '0x')
    )
      throw new Error('Invalid transaction-set payment')
    const policy = this.options.policy()
    const contexts = new Map<number, PaymentContext>()
    const context = (index: number): PaymentContext => {
      const known = contexts.get(index)
      if (known) return known
      const destination = getAddress(request.kdf(index)).toLowerCase()
      const gas = policy.paymentGasLimit(data, destination)
      this.validatePolicy(policy, gas, data)
      const feeIsExact =
        typeof policy.paymentFeeIsExact === 'function'
          ? policy.paymentFeeIsExact(destination, data)
          : policy.paymentFeeIsExact
      if (typeof feeIsExact !== 'boolean')
        throw new Error('Invalid reviewed fee semantics')
      const value = { destination, gas, feeIsExact }
      contexts.set(index, value)
      return value
    }
    context(0)
    const parts = coins.reserveTransactionSetSources({
      holder: request.operationId,
      amountWei: request.amountWei,
      feeWei: index => context(index).gas * policy.gasPriceWei,
      head: policy.head,
      sourceOrder: policy.sourceOrder,
      maxCoins: request.maxPaymentParts,
      canSelect: coin =>
        journal.canSelect(coin.account, coin.nonce) &&
        (this.options.canSelectCoin?.(coin) ?? true) &&
        this.dependencyReady(coin, policy),
      capacityWei: (coin, fee) => {
        const capacity = coin.valueWei - fee,
          rule = policy.spendRule
        if (
          !rule?.waitBlocks ||
          coin.nonce === 0 ||
          (coin.lastSpentInBlock !== undefined &&
            policy.head >= coin.lastSpentInBlock + rule.waitBlocks)
        )
          return capacity
        return capacity > rule.belowWei ? capacity - rule.belowWei : 0n
      },
    })
    if (!parts) throw new Error('Insufficient available EVM coins')
    let members: LocalMember[]
    try {
      members = (
        await Promise.all(
          parts.map((part, index) =>
            this.prepareSource(request, policy, context(index), part, index),
          ),
        )
      ).flat()
      const previous = new Map<string, number>()
      let changeIndex = 0
      members.forEach((member, index) => {
        const prior = previous.get(member.plan.source.address)
        member.plan.dependencies = prior === undefined ? [] : [prior]
        previous.set(member.plan.source.address, index)
        if (member.plan.transactionSet!.role === 'change')
          member.plan.transactionSet!.logicalIndex = changeIndex++
      })
      const totalFee = members.reduce(
        (sum, member) =>
          sum +
          Transaction.from(member.plan.unsignedTransaction).gasLimit *
            policy.gasPriceWei,
        0n,
      )
      if (request.maxFeeWei !== undefined && totalFee > request.maxFeeWei)
        throw new Error('Transaction-set fee exceeds authorized bound')
      if (members.length > 64)
        throw new Error('Transaction-set exceeds member capacity')
    } catch (error) {
      coins.abandon(request.operationId)
      throw error
    }
    // Once this write starts, a rejected promise is not evidence the signed set was not stored.
    // Keep reservations held on uncertainty; reopen restores the authoritative journal row.
    const row = await journal.prepare(
      {
        kind: 'transaction-set',
        preparationId: prefix + request.operationId,
        recipient: Transaction.from(
          members.find(
            member => member.plan.transactionSet!.role === 'payment',
          )!.plan.unsignedTransaction,
        ).to!.toLowerCase(),
        intendedValueWei: request.amountWei.toString(),
        members: members.map(member => member.plan),
      },
      members.map(member => member.raw),
    )
    this.restoreRow(row)
    await coins.checkpointTransactionSetReservations(request.operationId)
    return this.result(row)
  }

  private validatePolicy(
    policy: EvmTransactionSetPolicy,
    gas: bigint,
    data: string,
  ): void {
    const staticRule = this.recoverySpendRule,
      economicRule = policy.spendRule
    if (
      (staticRule === undefined) !== (economicRule === undefined) ||
      (staticRule &&
        economicRule &&
        (staticRule.belowWei !== economicRule.belowWei ||
          staticRule.waitBlocks !== economicRule.waitBlocks))
    )
      throw new Error(
        'Construction spend rule must match the static network recovery rule',
      )
    let intrinsic = 21000n
    for (let index = 2; index < data.length; index += 2)
      intrinsic += data.slice(index, index + 2) === '00' ? 4n : 16n
    if (
      typeof gas !== 'bigint' ||
      gas < intrinsic ||
      policy.gasPriceWei <= 0n ||
      policy.changeGasLimit !== 21000n ||
      policy.dustWei <= 0n ||
      !Number.isSafeInteger(policy.head) ||
      policy.head < 0 ||
      !Number.isSafeInteger(policy.radix) ||
      policy.radix < 2 ||
      !Number.isSafeInteger(policy.maxChangeOutputs) ||
      policy.maxChangeOutputs < 1 ||
      policy.maxChangeOutputs > 63 ||
      !Number.isSafeInteger(policy.jitterBps) ||
      policy.jitterBps < 0 ||
      policy.jitterBps > 9999 ||
      JSON.stringify(policy.sourceOrder) !==
        JSON.stringify(EVM_TRANSACTION_SET_SOURCE_ORDER) ||
      (policy.spendRule &&
        (policy.spendRule.belowWei < 0n ||
          !Number.isSafeInteger(policy.spendRule.waitBlocks) ||
          policy.spendRule.waitBlocks < 0))
    )
      throw new Error('Invalid reviewed EVM transaction-set policy')
  }

  private dependencyReady(
    coin: EvmListCoin,
    policy: EvmTransactionSetPolicy,
  ): boolean {
    if (!coin.after) return true
    for (const row of this.options.journal.list())
      for (const member of row.members) {
        const tx = Transaction.from(member.unsignedTransaction)
        if (
          member.source.address === coin.after.account &&
          tx.nonce === coin.after.nonce &&
          member.observation.state === 'included-success'
        )
          return (
            policy.head >=
            member.observation.blockNumber + (policy.spendRule?.waitBlocks ?? 0)
          )
      }
    return false
  }

  private async prepareSource(
    request: ConstructEvmTransactionSetRequest,
    policy: EvmTransactionSetPolicy,
    context: PaymentContext,
    part: CoinPart,
    paymentIndex: number,
  ): Promise<LocalMember[]> {
    const { coins, deriveChange } = this.options
    const paymentGas = context.gas
    const paymentFee = paymentGas * policy.gasPriceWei,
      changeFee = policy.changeGasLimit * policy.gasPriceWei
    let payment = part.paymentValueWei
    let remainder = part.coin.valueWei - payment - paymentFee
    const destination = context.destination
    let outputs: bigint[] = []
    // Absorb uneconomic dust only when no change output can carry it. The splitter
    // conserves the entire larger remainder, including residuals, across change outputs.
    if (remainder > 0n && remainder < policy.dustWei + changeFee) {
      payment += remainder
      remainder = 0n
    }
    if (remainder >= policy.dustWei + changeFee) {
      outputs = computeGeometricRadixChangeSplits({
        totalAvailableWei: remainder,
        recipientAmountWei: payment,
        dustThresholdWei: policy.dustWei,
        minFeePerTxWei: changeFee,
        maxOutputs: policy.maxChangeOutputs,
        radix: policy.radix,
        jitterBps: policy.jitterBps,
        random: () => this.entropy(),
      })
    }
    type Move = {
      role: 'payment' | 'change'
      logicalIndex: number
      to: string
      value: bigint
      gas: bigint
      data: string
      changeIndex?: number
    }
    let moves: Move[] = [
      {
        role: 'payment',
        logicalIndex: paymentIndex,
        to: destination,
        value: payment,
        gas: paymentGas,
        data: request.calldata ?? '0x',
      },
    ]
    const planned = outputs.map(value => ({
      role: 'change' as const,
      logicalIndex: 0,
      to: '',
      value,
      gas: policy.changeGasLimit,
      data: '0x',
    }))
    moves.push(...planned)
    for (let index = moves.length - 1; index > 0; index--) {
      const other = Math.floor(this.entropy() * (index + 1))
      ;[moves[index], moves[other]] = [moves[other]!, moves[index]!]
    }
    // The relay/recipient can rebroadcast payment bytes. A below-reserve final drain
    // requiring a quiet window must therefore remain a private, wallet-scheduled change.
    if (policy.spendRule?.waitBlocks && moves.length > 1) {
      let largest = -1
      for (const [index, move] of moves.entries())
        if (
          move.role === 'change' &&
          (largest < 0 || move.value > moves[largest]!.value)
        )
          largest = index
      if (largest >= 0) moves.push(moves.splice(largest, 1)[0]!)
    }
    // Recipient bytes can be broadcast independently. If shuffling would make their
    // execution require a quiet window after our own change, put the payment first.
    // Keep every change movement; its durable predecessor controls delayed execution.
    if (policy.spendRule?.waitBlocks && moves.length > 1) {
      let balance = part.coin.valueWei
      const delayedPayment = moves.some((move, index) => {
        balance -= move.value + move.gas * policy.gasPriceWei
        return move.role === 'payment' && index > 0 && balance < policy.spendRule!.belowWei
      })
      if (delayedPayment) {
        const paymentIndex = moves.findIndex(move => move.role === 'payment')
        moves.unshift(moves.splice(paymentIndex, 1)[0]!)
      }
    }
    let changeLogicalIndex = 0
    for (const move of moves)
      if (move.role === 'change') {
        const minimumIndex = coins.nextChangeIndex()
        const target = this.options.reserveChange
          ? await this.options.reserveChange(request.operationId, minimumIndex)
          : deriveChange(minimumIndex)
        const index = target.changeIndex
        if (
          !Number.isSafeInteger(index) ||
          index < minimumIndex ||
          index >= 0x80000000 ||
          computeAddress(target.privateKey).toLowerCase() !==
            target.account.toLowerCase() ||
          target.account.toLowerCase() === destination
        )
          throw new Error('Invalid fresh change destination')
        coins.reserveChangeTarget(request.operationId, index, target.account)
        move.to = target.account.toLowerCase()
        move.changeIndex = index
        move.logicalIndex = changeLogicalIndex++
      }
    let balance = part.coin.valueWei
    return moves.map((move, index) => {
      const before = balance
      balance -= move.value + move.gas * policy.gasPriceWei
      const tx = Transaction.from({
        type: 0,
        chainId: BigInt(this.options.journal.binding.nativeChainId),
        nonce: part.coin.nonce + index,
        to: move.to,
        value: move.value,
        data: move.data,
        gasLimit: move.gas,
        gasPrice: policy.gasPriceWei,
      })
      const plan: EvmNativeMemberPlan = {
        source: { kind: 'coin', address: part.coin.account },
        unsignedTransaction: tx.unsignedSerialized,
        dependencies: [],
        transactionSet: {
          role: move.role,
          logicalIndex: move.logicalIndex,
          ...(move.changeIndex === undefined
            ? {}
            : { changeIndex: move.changeIndex }),
          balanceBeforeWei: before.toString(),
          balanceAfterWei: balance.toString(),
          ...(index > 0 &&
          policy.spendRule?.waitBlocks &&
          balance < policy.spendRule.belowWei
            ? { predecessorWaitBlocks: policy.spendRule.waitBlocks }
            : {}),
          ...(index === moves.length - 1 && !context.feeIsExact
            ? { refundPending: true }
            : {}),
        },
      }
      tx.signature = new SigningKey(part.coin.privateKey).sign(tx.unsignedHash)
      return { plan, raw: tx.serialized }
    })
  }

  private entropy(): number {
    const value = (this.options.random ?? Math.random)()
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new Error('Invalid transaction-set entropy')
    return value
  }

  private restoreRow(row: EvmNativeOperation): void {
    const logicalId = row.preparationId!.slice(prefix.length)
    const { coins } = this.options
    for (const [index, member] of row.members.entries()) {
      if (!member.signed) continue
      const tx = Transaction.from(member.signed.rawTransaction),
        meta = member.transactionSet!
      if (meta.role === 'change')
        coins.reserveChangeTarget(
          logicalId,
          meta.changeIndex!,
          tx.to!.toLowerCase(),
        )
      const source = coins
        .all()
        .find(coin => coin.account === member.source.address)
      const reconciled = meta.inventoryApplied === true
      if (
        !reconciled &&
        (member.observation.state === 'included-success' ||
          member.observation.state === 'included-revert' ||
          (member.observation.state === 'missing' &&
            member.account !== null &&
            member.account.nonce > tx.nonce))
      )
        coins.requireTransactionSetProjection(
          member.source.address,
          `${row.operationId}:${index}`,
        )
      if (!source && reconciled) continue
      if (!source)
        throw new Error('Transaction-set source key restoration required')
      coins.restoreTransactionSetCoin(
        logicalId,
        {
          account: member.source.address,
          nonce: tx.nonce,
          privateKey: source.privateKey,
          origin: source.origin,
          ...(source.lastSpentInBlock === undefined
            ? {}
            : { lastSpentInBlock: source.lastSpentInBlock }),
          ...(source.changeIndex === undefined
            ? {}
            : { changeIndex: source.changeIndex }),
          valueWei: BigInt(meta.balanceBeforeWei),
          state:
            member.observation.state === 'included-success' ||
            member.observation.state === 'included-revert'
              ? 'spent'
              : 'pending_receipt',
          spendingTx: member.signed.rawTransaction,
          ...('blockNumber' in member.observation
            ? { spentInBlock: member.observation.blockNumber }
            : {}),
        },
        !reconciled,
      )
      const next = row.members[index + 1]
      if (
        (!next || next.source.address !== member.source.address) &&
        BigInt(meta.balanceAfterWei) > 0n &&
        !meta.refundPending &&
        !reconciled &&
        member.observation.state !== 'included-success' &&
        member.observation.state !== 'included-revert' &&
        (coins.latestOf(source.account)?.nonce ?? 0) <= tx.nonce + 1 &&
        (!coins.get(source.account, tx.nonce + 1) ||
          coins.get(source.account, tx.nonce + 1)?.after !== undefined)
      ) {
        coins.restoreTransactionSetCoin(
          logicalId,
          {
            account: source.account,
            nonce: tx.nonce + 1,
            privateKey: source.privateKey,
            origin: source.origin,
            valueWei: BigInt(meta.balanceAfterWei),
            state: 'unspent',
            after: { account: source.account, nonce: tx.nonce },
            ...(source.changeIndex === undefined
              ? {}
              : { changeIndex: source.changeIndex }),
            ...(meta.remainderSpendableFromBlock === undefined
              ? {}
              : { spendableFromBlock: meta.remainderSpendableFromBlock }),
          },
          false,
        )
      }
    }
  }

  private result(row: EvmNativeOperation): PreparedEvmTransactionSet {
    const entries = row.members.map((member): PreparedEvmTransaction => {
      if (!member.signed) throw new Error('Incomplete signed transaction set')
      const tx = Transaction.from(member.signed.rawTransaction)
      return {
        logicalIndex: member.transactionSet!.logicalIndex,
        sourceAccount: member.source.address,
        nonce: tx.nonce,
        destination: tx.to!.toLowerCase(),
        valueWei: tx.value,
        gasLimit: tx.gasLimit,
        rawTransaction: member.signed.rawTransaction,
        txHash: member.signed.transactionHash,
        ...(member.dependencies.length
          ? {
              predecessor: {
                account: member.source.address,
                nonce: tx.nonce - 1,
              },
            }
          : {}),
      }
    })
    return {
      operationId: row.preparationId!.slice(prefix.length),
      chainIdentifier: row.binding.chainIdentifier,
      bundle: entries
        .filter(
          (_, index) => row.members[index]!.transactionSet!.role === 'payment',
        )
        .sort((a, b) => a.logicalIndex - b.logicalIndex),
      otherTransactions: entries.filter(
        (_, index) => row.members[index]!.transactionSet!.role === 'change',
      ),
    }
  }
}
