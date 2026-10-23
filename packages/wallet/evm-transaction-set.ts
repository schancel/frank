import { computeAddress, getAddress, SigningKey, Transaction } from 'ethers'
import { computeGeometricRadixChangeSplits } from './evm-change-distribution'
import type {
  CoinPart,
  EvmListCoin,
  EvmCoinAccountProjection,
} from './evm-coin-list'
import type {
  EvmNativeMemberPlan,
  EvmTransactionSetStage,
  EvmNativeOperation,
  EvmNativeObservation,
  EvmNativeAccountObservation,
} from './storage/evm-native-operation-journal'
import { EVM_TRANSACTION_SET_SOURCE_ORDER, EvmTransactionSetInsufficientFundsError } from './evm-transaction-set-types'
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
      if (row.kind === 'transaction-set') {
        if (row.cancelled) {
          const logicalId = row.preparationId!.slice(prefix.length)
          for (const member of row.members)
            if (member.transactionSet!.role !== 'payment')
              this.options.coins.reserveChangeTarget(logicalId, member.transactionSet!.changeIndex!, Transaction.from(member.unsignedTransaction).to!)
          this.options.coins.restoreTransactionSetCancellation(logicalId, this.cancellationSources(row))
        }
        else this.restoreRow(row)
      }
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

  /** Complete graph snapshot for the wallet submission boundary; never signs or broadcasts. */
  getTransactionSet(operationId: string): PreparedEvmTransactionSet {
    const row = this.getOperation(operationId)
    if (!row || row.cancelled) throw new Error('Unknown active transaction set')
    return this.result(row, null)
  }

  async authorizeSubmission(operationId: string, expectedRawTransactions?: readonly string[]): Promise<void> {
    const row = this.getOperation(operationId)
    if (!row) throw new Error('Unknown transaction-set operation')
    await this.options.journal.authorizeTransactionSet(row.operationId, expectedRawTransactions)
  }

  transactionSetPolicy(): EvmTransactionSetPolicy {
    return this.options.policy()
  }

  /** Uses the same logical ID as construction. Authorization/exposure is never cancelled. */
  releaseUnexposed(operationId: string): Promise<boolean> {
    return this.options.coins.runTransactionSetExclusive(operationId, async () => {
      let row = await this.options.journal.refreshPreparation(prefix + operationId)
      if (!row || row.submissionAuthorized || row.members.some(member => member.exposed || nativeMemberSuperseded(member) || !['unknown', 'missing'].includes(member.observation.state))) return false
      const originals = this.cancellationSources(row)
      if (!row.cancelled) row = await this.options.journal.discardUnexposed(row.operationId)
      this.options.coins.restoreTransactionSetCancellation(operationId, originals)
      await this.options.coins.checkpointTransactionSetCancellation(operationId, originals)
      return true
    })
  }

  private cancellationSources(row: EvmNativeOperation): EvmListCoin[] {
    const privateAccounts = new Set(row.members.filter(member => member.transactionSet?.role !== 'payment').map(member => Transaction.from(member.unsignedTransaction).to!.toLowerCase()))
    const first = new Set<string>(), originals: EvmListCoin[] = []
    for (const member of row.members) {
      const account = member.source.address
      if (first.has(account) || privateAccounts.has(account)) continue
      first.add(account)
      const source = this.options.coins.all().find(coin => coin.account === account)
      if (!source) continue // Already reconciled and pruned; never resurrect a prior nonce.
      originals.push({ ...source, nonce: Transaction.from(member.unsignedTransaction).nonce,
        valueWei: BigInt(member.transactionSet!.balanceBeforeWei), state: 'unspent' })
    }
    return originals
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
    if (member.transactionSet?.fundingWaitBlocks !== undefined && member.dependencies.some(index => {
      const prior = row.members[index]!
      return prior.observation.state !== 'included-success' || this.options.policy().head < prior.observation.blockNumber + member.transactionSet!.fundingWaitBlocks!
    })) throw new Error('Transaction-set funding maturity is not satisfied')
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

  constructTransactionSet(request: ConstructEvmTransactionSetRequest): Promise<PreparedEvmTransactionSet> {
    return this.buildOnce(request)
  }

  appendTransactionSet(request: ConstructEvmTransactionSetRequest & { stageId: string }): Promise<PreparedEvmTransactionSet> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.stageId)) return Promise.reject(new Error('Invalid transaction-set stage ID'))
    return this.buildOnce(request, request.stageId)
  }

  constructLegacyTransactionSet(request: ConstructEvmTransactionSetRequest): Promise<PreparedEvmTransactionSet> {
    return this.buildOnce(request, undefined, true)
  }

  private buildOnce(request: ConstructEvmTransactionSetRequest, stageId?: string, legacy = false): Promise<PreparedEvmTransactionSet> {
    const suppliedKdf = request.kdf, destinations = new Map<number, string>()
    request = { ...request, kdf: index => {
      const known = destinations.get(index)
      if (known !== undefined) return known
      const destination = suppliedKdf(index)
      destinations.set(index, destination)
      return destination
    } }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)) return Promise.reject(new Error('Invalid transaction-set operation ID'))
    return this.options.coins.constructTransactionSetOnce(request.operationId,
      () => this.construct(request, stageId, legacy), stageId).then(result => {
        this.validateReplay(request, this.getOperation(request.operationId)!, stageId, legacy)
        return result
      })
  }

  private validateReplay(request: ConstructEvmTransactionSetRequest, row: EvmNativeOperation, stageId?: string, legacy = false): void {
    const stage = row.transactionSetStages?.find(item => item.stageId === stageId)
    const members = row.members.filter(member => member.transactionSet?.stageId === stageId)
    const payments = members.filter(member => member.transactionSet!.role === 'payment')
    if (row.cancelled || !payments.length ||
        (stage?.intendedValueWei ?? row.intendedValueWei) !== request.amountWei.toString() ||
        (stage?.reserveForContinuationWei ?? '0') !== (request.reserveForContinuationWei ?? 0n).toString() ||
        (stage !== undefined && Boolean(stage.legacy) !== legacy) ||
        (request.maxPaymentParts !== undefined && payments.length > request.maxPaymentParts) ||
        payments.some(member => {
          const tx = Transaction.from(member.unsignedTransaction)
          return tx.data !== (request.calldata ?? '0x').toLowerCase() ||
            tx.to!.toLowerCase() !== getAddress(request.kdf(member.transactionSet!.logicalIndex)).toLowerCase()
        }) || (request.maxFeeWei !== undefined && BigInt(row.maximumFeeWei) > request.maxFeeWei))
      throw new Error('Transaction-set operation ID conflicts with original intent')
  }

  private privateOutputs(row: EvmNativeOperation): EvmListCoin[] {
    const sources = new Set(row.members.map(member => member.source.address))
    return row.members.flatMap(member => {
      const meta = member.transactionSet!, tx = Transaction.from(member.unsignedTransaction)
      if (meta.role !== 'change' || sources.has(tx.to!.toLowerCase())) return []
      const key = this.options.deriveChange(meta.changeIndex!)
      if (key.account.toLowerCase() !== tx.to!.toLowerCase()) throw new Error('Private change ownership mismatch')
      return [{ account: key.account.toLowerCase(), privateKey: key.privateKey, origin: 'change' as const,
        changeIndex: meta.changeIndex!, nonce: 0, valueWei: tx.value, state: 'unspent' as const,
        holder: row.preparationId!.slice(prefix.length), after: { account: member.source.address, nonce: tx.nonce } }]
    })
  }

  private async construct(request: ConstructEvmTransactionSetRequest, stageId?: string, legacy = false): Promise<PreparedEvmTransactionSet> {
    const { journal, coins } = this.options
    const existing = await journal.refreshPreparation(prefix + request.operationId)
    if (existing && (stageId === undefined || existing.transactionSetStages?.some(stage => stage.stageId === stageId))) {
      this.validateReplay(request, existing, stageId, legacy)
      if (existing.members.some(member => !member.signed)) throw new Error('Incomplete transaction-set journal record')
      this.restoreRow(existing)
      return this.result(existing, stageId)
    }
    if (stageId !== undefined && (!existing || !existing.transactionSetStages || existing.cancelled || existing.submissionAuthorized || existing.members.some(member => member.exposed || nativeMemberSuperseded(member) || !['unknown', 'missing'].includes(member.observation.state))))
      throw new Error('Cannot append to an exposed or unavailable operation')
    const data = request.calldata ?? '0x', reserve = request.reserveForContinuationWei ?? 0n
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || request.amountWei < 0n || reserve < 0n ||
        request.amountWei + reserve >= 1n << 256n || (request.amountWei === 0n && data === '0x')) throw new Error('Invalid transaction-set payment')
    const policy = this.options.policy(), contexts = new Map<number, PaymentContext>()
    const context = (index: number): PaymentContext => {
      const known = contexts.get(index)
      if (known) return known
      const destination = getAddress(request.kdf(index)).toLowerCase(), gas = policy.paymentGasLimit(data, destination)
      this.validatePolicy(policy, gas, data)
      const feeIsExact = typeof policy.paymentFeeIsExact === 'function' ? policy.paymentFeeIsExact(destination, data) : policy.paymentFeeIsExact
      if (typeof feeIsExact !== 'boolean') throw new Error('Invalid reviewed fee semantics')
      const value = { destination, gas, feeIsExact }; contexts.set(index, value); return value
    }
    context(0)
    const select = (fanIn: boolean, continuation?: { deficit: bigint; maxCoins: number }) => coins.reserveTransactionSetSources({
      holder: request.operationId, ownedCandidates: existing ? this.privateOutputs(existing) : undefined,
      amountWei: continuation?.deficit ?? (request.amountWei + reserve + (fanIn ? context(0).gas * policy.gasPriceWei : 0n)),
      feeWei: index => (fanIn || continuation ? policy.changeGasLimit : context(index).gas) * policy.gasPriceWei,
      head: policy.head, sourceOrder: policy.sourceOrder, maxCoins: continuation?.maxCoins ?? (legacy && !fanIn ? 1 : request.maxPaymentParts),
      canSelect: coin => journal.canSelect(coin.account, coin.nonce) && (this.options.canSelectCoin?.(coin) ?? true) && this.dependencyReady(coin, policy),
      capacityWei: (coin, fee) => {
        const capacity = coin.valueWei - fee, rule = policy.spendRule
        if (continuation && capacity < policy.dustWei) return 0n
        if (!rule?.waitBlocks || coin.nonce === 0 || (coin.lastSpentInBlock !== undefined && policy.head >= coin.lastSpentInBlock + rule.waitBlocks)) return capacity
        // Fan-in moves the complete source, so partial above-reserve capacity is insufficient.
        if (fanIn) return 0n
        return capacity > rule.belowWei ? capacity - rule.belowWei : 0n
      },
    })
    const beforeSelection = coins.all()
    let parts = select(false), fanIn = false
    if (!parts && legacy) { parts = select(true); fanIn = true }
    if (!parts) throw new EvmTransactionSetInsufficientFundsError()
    let members: LocalMember[]
    try {
      if (fanIn) members = await this.prepareFanIn(request, policy, context(0), parts)
      else {
        let remaining = request.amountWei, paymentIndex = 0
        members = []
        for (const part of parts) {
          const payment = part.paymentValueWei < remaining ? part.paymentValueWei : remaining
          remaining -= payment
          members.push(...await this.prepareSource(request, policy, context(paymentIndex), { ...part, paymentValueWei: payment }, paymentIndex))
          if (payment > 0n || data !== '0x') paymentIndex++
        }
      }
      // Selection budgets the recipient transfer first. Geometric change has its own
      // actual fees, so a nominal continuation balance is not yet a usable reserve.
      // Keep the completed source plans and add change-only sources for any shortfall;
      // never replace their destinations or expose a partly constructed operation.
      const privateValue = () => members.reduce((sum, member) =>
        member.plan.transactionSet!.role === 'change'
          ? sum + Transaction.from(member.raw).value : sum, 0n)
      while (privateValue() < reserve) {
        const remainingMembers = 64 - (existing?.members.length ?? 0) - members.length
        const maxCoins = Math.min(remainingMembers, (request.maxPaymentParts ?? 64) - parts.length)
        if (maxCoins <= 0) throw new Error('Insufficient private change for continuation')
        const additional = select(false, { deficit: reserve - privateValue(), maxCoins })
        if (!additional) throw new Error('Insufficient private change for continuation')
        parts.push(...additional)
        for (const part of additional)
          members.push(...await this.prepareSource(
            { ...request, calldata: undefined }, policy, context(0),
            { ...part, paymentValueWei: 0n }, 0,
          ))
      }
      const offset = existing?.members.length ?? 0
      const all = [...(existing?.members.map(member => ({ plan: member })) ?? []), ...members]
      const previous = new Map<string, number>(), incoming = new Map<string, number[]>()
      all.forEach((member, index) => {
        const meta = member.plan.transactionSet!, tx = Transaction.from(member.plan.unsignedTransaction)
        if (index >= offset) {
          const prior = previous.get(member.plan.source.address), funding = incoming.get(member.plan.source.address)
          member.plan.dependencies = prior !== undefined ? [prior] : funding ?? []
          if (prior === undefined && funding) meta.fundingWaitBlocks = policy.spendRule?.waitBlocks ? policy.spendRule.waitBlocks + 1 : 0
          if (stageId !== undefined) meta.stageId = stageId
        }
        previous.set(member.plan.source.address, index)
        if (meta.role !== 'payment') incoming.set(tx.to!.toLowerCase(), [...(incoming.get(tx.to!.toLowerCase()) ?? []), index])
      })
      const totalFee = all.reduce((sum, member) => { const tx = Transaction.from(member.plan.unsignedTransaction); return sum + tx.gasLimit * (tx.gasPrice ?? tx.maxFeePerGas!) }, 0n)
      if ((request.maxFeeWei !== undefined && totalFee > request.maxFeeWei) || existing?.transactionSetStages?.some(stage => stage.maxFeeWei !== undefined && totalFee > BigInt(stage.maxFeeWei))) throw new Error('Transaction-set fee exceeds authorized bound')
      if (all.length > 64) throw new Error('Transaction-set exceeds member capacity')
      if (members.filter(member => member.plan.transactionSet!.role === 'change').reduce((sum, member) => sum + Transaction.from(member.raw).value, 0n) < reserve) throw new Error('Insufficient private change for continuation')
    } catch (error) {
      coins.abandonTransactionSetSources(request.operationId, parts.map(part => part.coin), beforeSelection)
      throw error
    }
    const payments = members.filter(member => member.plan.transactionSet!.role === 'payment').sort((a,b) => a.plan.transactionSet!.logicalIndex - b.plan.transactionSet!.logicalIndex)
    const stage: EvmTransactionSetStage = {
      ...(stageId === undefined ? {} : { stageId }), startIndex: existing?.members.length ?? 0, memberCount: members.length,
      intendedValueWei: request.amountWei.toString(), calldata: data.toLowerCase(), destinations: payments.map(member => Transaction.from(member.raw).to!.toLowerCase()),
      ...(request.maxFeeWei === undefined ? {} : { maxFeeWei: request.maxFeeWei.toString() }),
      ...(request.reserveForContinuationWei === undefined ? {} : { reserveForContinuationWei: reserve.toString() }),
      ...(legacy ? { legacy: true } : {}),
    }
    let row: EvmNativeOperation
    try {
      row = existing ? await journal.appendTransactionSet(existing.operationId, stage, members.map(member => member.plan), members.map(member => member.raw)) : await journal.prepare({
      kind: 'transaction-set', preparationId: prefix + request.operationId, recipient: stage.destinations[0]!, intendedValueWei: request.amountWei.toString(),
      transactionSetStages: [stage], members: members.map(member => member.plan),
    }, members.map(member => member.raw))
    } catch (error) {
      let authority: EvmNativeOperation | undefined
      try { authority = await journal.refreshPreparation(prefix + request.operationId) }
      catch { throw error } // Uncertain writes keep every reservation fenced until reopen.
      if (authority && (stageId === undefined || authority.transactionSetStages?.some(stage => stage.stageId === stageId)))
        this.restoreRow(authority) // Commit-then-throw: the original durable signed bytes win.
      else
        coins.abandonTransactionSetSources(request.operationId, parts.map(part => part.coin), beforeSelection)
      throw error
    }
    this.restoreRow(row)
    await coins.checkpointTransactionSetReservations(request.operationId)
    return this.result(row, stageId)
  }

  private async prepareFanIn(request: ConstructEvmTransactionSetRequest, policy: EvmTransactionSetPolicy, context: PaymentContext, parts: CoinPart[]): Promise<LocalMember[]> {
    const { coins } = this.options, minimum = coins.nextChangeIndex()
    const target = this.options.reserveChange ? await this.options.reserveChange(request.operationId, minimum) : this.options.deriveChange(minimum)
    if (!Number.isSafeInteger(target.changeIndex) || target.changeIndex < minimum || target.changeIndex >= 0x80000000 || target.account.toLowerCase() === context.destination || computeAddress(target.privateKey).toLowerCase() !== target.account.toLowerCase()) throw new Error('Invalid fan-in destination')
    coins.reserveChangeTarget(request.operationId, target.changeIndex, target.account)
    let balance = 0n
    const members = parts.map((part, index): LocalMember => {
      const value = part.coin.valueWei - policy.changeGasLimit * policy.gasPriceWei
      balance += value
      const tx = Transaction.from({ type: 0, chainId: BigInt(this.options.journal.binding.nativeChainId), nonce: part.coin.nonce,
        to: target.account, value, gasLimit: policy.changeGasLimit, gasPrice: policy.gasPriceWei })
      tx.signature = new SigningKey(part.coin.privateKey).sign(tx.unsignedHash)
      return { raw: tx.serialized, plan: { source: { kind: 'coin', address: part.coin.account }, unsignedTransaction: tx.unsignedSerialized, dependencies: [], transactionSet: {
        role: 'funding', logicalIndex: index, changeIndex: target.changeIndex, balanceBeforeWei: part.coin.valueWei.toString(), balanceAfterWei: '0',
      } } }
    })
    const coin: EvmListCoin = { account: target.account.toLowerCase(), privateKey: target.privateKey, changeIndex: target.changeIndex, origin: 'change', nonce: 0, valueWei: balance, state: 'spend_pending', holder: request.operationId }
    members.push(...await this.prepareSource(request, policy, context, { coin, paymentValueWei: request.amountWei }, 0))
    return members
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
    const hasPayment = payment > 0n || (request.calldata ?? '0x') !== '0x'
    let remainder = part.coin.valueWei - payment - (hasPayment ? paymentFee : 0n)
    const destination = context.destination
    let outputs: bigint[] = []
    // Absorb uneconomic dust only when no change output can carry it. The splitter
    // conserves the entire larger remainder, including residuals, across change outputs.
    if (remainder > 0n && remainder < policy.dustWei + changeFee &&
        (request.reserveForContinuationWei ?? 0n) === 0n) {
      payment += remainder
      remainder = 0n
    }
    // A continuation request must not donate its earmarked residual. If it cannot
    // fund change here, keep it on the source successor and fund the private reserve
    // from another input. Settlement already projects that residual at the next nonce.
    if (remainder >= policy.dustWei + changeFee) {
      outputs = computeGeometricRadixChangeSplits({
        totalAvailableWei: remainder,
        recipientAmountWei: hasPayment ? payment : request.amountWei,
        dustThresholdWei: policy.dustWei,
        minFeePerTxWei: changeFee,
        maxOutputs: policy.maxChangeOutputs,
        radix: policy.radix,
        jitterBps: policy.jitterBps,
        random: () => this.entropy(),
      })
    }
    if (!hasPayment && !outputs.length) throw new Error('Insufficient private change for continuation')
    type Move = {
      role: 'payment' | 'change'
      logicalIndex: number
      to: string
      value: bigint
      gas: bigint
      data: string
      changeIndex?: number
    }
    let moves: Move[] = hasPayment ? [
      {
        role: 'payment',
        logicalIndex: paymentIndex,
        to: destination,
        value: payment,
        gas: paymentGas,
        data: request.calldata ?? '0x',
      },
    ] : []
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
          ...(move.role === 'payment' ? { intendedValueWei: part.paymentValueWei.toString() } : {}),
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
      if (meta.role !== 'payment')
        coins.reserveChangeTarget(
          logicalId,
          meta.changeIndex!,
          tx.to!.toLowerCase(),
        )
      let source = coins
        .all()
        .find(coin => coin.account === member.source.address)
      if (!source) {
        const creator = row.members.find(candidate => candidate.transactionSet?.role !== 'payment' && Transaction.from(candidate.unsignedTransaction).to!.toLowerCase() === member.source.address)
        if (creator) {
          const key = this.options.deriveChange(creator.transactionSet!.changeIndex!)
          if (key.account.toLowerCase() !== member.source.address) throw new Error('Private source key restoration mismatch')
          source = { account: member.source.address, nonce: tx.nonce, privateKey: key.privateKey, origin: 'change', changeIndex: key.changeIndex, valueWei: BigInt(meta.balanceBeforeWei), state: 'unspent' }
        }
      }
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

  private result(row: EvmNativeOperation, stageId?: string | null): PreparedEvmTransactionSet {
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
                account: row.members[member.dependencies[0]!]!.source.address,
                nonce: Transaction.from(row.members[member.dependencies[0]!]!.unsignedTransaction).nonce,
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
          (_, index) => row.members[index]!.transactionSet!.role === 'payment' && (stageId === null || row.members[index]!.transactionSet!.stageId === stageId),
        )
        .sort((a, b) => a.logicalIndex - b.logicalIndex),
      otherTransactions: entries.filter(
        (_, index) => row.members[index]!.transactionSet!.role !== 'payment' && (stageId === null || row.members[index]!.transactionSet!.stageId === stageId),
      ),
    }
  }
}
