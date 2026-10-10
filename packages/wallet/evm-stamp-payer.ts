/**
 * Pays the stamp of one message from coins an EVM wallet already has: its funded single-use
 * sub-accounts, its main account, its identity account.
 *
 * The shape is the old Stamp wallet's: filter what is unspent, select, and mark the chosen coins
 * in the same synchronous step, so a second payment being built at the same moment cannot see
 * them; then sign. No queue and no lock is held around a payment: the claim
 * (`MonadSubAccountPool.claim`) is the only thing two payments share.
 *
 * A claimed account leaves the claim in exactly two ways:
 * - nothing signed ever left the wallet (`release`): it is free again at once;
 * - the chain shows what happened to it (`recordSpent`, `recordFailed`): never a timeout, a relay
 *   answer or a restart.
 */
import { Transaction, type Provider } from 'ethers'
import {
  InsufficientStampFundsError,
  type MonadSubAccountPool,
} from './monad-account-pool'
import { MonadAccountTxSigner, type MonadTxSubmitter } from './monad-account-tx'
import {
  ChainUnreachableError,
  ChainWaitCancelledError,
  EvmBlockWatcher,
} from './evm-block-watcher'

export { ChainUnreachableError, ChainWaitCancelledError }

/**
 * The coin of an account that has sent before (the main account, the identity account):
 * `(account, nonce)`, spendable from `notBeforeBlock` on. When the transaction spending
 * `(account, n)` is seen mined at block b, the coin `(account, n)` is gone and its successor is
 * `(account, n + 1)` with `notBeforeBlock = b + spacing`. While that transaction is unmined
 * there is no coin: the account stays claimed by its spender. Process memory: the durable facts
 * are the spending transaction on its own record and the chain, from which the coin is read
 * again when it is not known (`coinOf`).
 */
export interface AccountCoin {
  readonly nonce: number
  readonly notBeforeBlock: number
}

export { InsufficientStampFundsError }

/** Where a paying coin comes from: a funded single-use sub-account of the pool, the wallet's
 * main account, or its identity account. A caller may filter by it; nothing is excluded. */
export type StampCoinSource = 'pool' | 'main' | 'identity' | 'coin'

/** One signed payment of a stamp: the account it spends and the exact bytes. */
export interface StampPayment {
  readonly source: StampCoinSource
  /** The pool index, for a `pool` coin. */
  readonly index?: number
  readonly address: string
  readonly rawTx: string
}

export interface StampFee {
  /** What the chain charges per gas right now (`eth_gasPrice`: base fee plus tip). */
  readonly chargedPerGas: bigint
  readonly maxFeePerGas?: bigint
  readonly maxPriorityFeePerGas?: bigint
  readonly gasPrice?: bigint
}

/** What the chain says about one signed payment. */
export type StampPaymentObservation =
  /** In a block. A reverted transaction consumed its nonce all the same. */
  | {
      readonly state: 'included'
      readonly reverted: boolean
      readonly block?: number
    }
  /** The account's nonce was consumed by a different transaction: this one can never land. */
  | { readonly state: 'replaced' }
  /** Not in a block: the node holds it (`mempool`), or does not know it at all. */
  | {
      readonly state: 'pending'
      readonly where?: 'mempool' | 'unknown-to-node'
    }

/** One coin claimed for a payment: the account, the nonce it is at, and what it pays. */
export interface ClaimedStampCoin {
  readonly source: StampCoinSource
  readonly index?: number
  readonly address: string
  readonly nonce: number
  readonly paymentValueWei: bigint
}

/** The coins one message's stamp is paid from, claimed and not yet signed for. */
export interface StampClaim {
  readonly holder: string
  readonly accounts: readonly ClaimedStampCoin[]
  readonly fee: StampFee
}

const STAMP_GAS_LIMIT = 21_000n
const FEE_TTL_MS = 6_000
/** While a payment waits for the main or identity account, the chain is asked about the payment
 * that holds it at most this often. */
export const BUSY_LOOK_MS = 1_000

/**
 * Resolves once `address` has sent no transaction in the last `blocks` blocks AND has none the
 * node still holds unmined, so a value transfer signed now is not one the chain's spacing rule
 * reverts (Monad's reserve balance: see `EvmChainConfig.spendSpacingBlocks`). A transaction in
 * the mempool counts: it will be mined inside the window (a funding transfer whose receipt
 * wait ran out, a transfer some other code signed with the same key), and signing behind it
 * would also stack a nonce. The caller holds the account's claim, so nothing of this wallet
 * signs from it meanwhile, and reads the nonce AFTER this returns. Three reads a look, a look
 * every 400 ms; rejects, having signed nothing, when the chain cannot be read for 20 s.
 * `blocks` 0 or absent: no wait and no request.
 */
export async function waitForSpendSpacing(
  provider: Provider,
  address: string,
  blocks: number | undefined,
): Promise<void> {
  if (!blocks || blocks <= 0) return
  let failingSince: number | undefined
  for (;;) {
    try {
      const head = await provider.getBlockNumber()
      const [now, before, pending] = await Promise.all([
        provider.getTransactionCount(address, head),
        head < blocks
          ? Promise.resolve(undefined)
          : provider.getTransactionCount(address, head - blocks),
        provider.getTransactionCount(address, 'pending'),
      ])
      if ((before === undefined || now === before) && pending <= now) return
      failingSince = undefined
    } catch (error) {
      failingSince ??= Date.now()
      if (Date.now() - failingSince > 20_000) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

export interface EvmStampPayerConfig {
  pool: MonadSubAccountPool
  provider: Provider
  httpClient: MonadTxSubmitter
  /** See `EvmChainConfig.spendSpacingBlocks`. Applies to the main and identity accounts; a
   * single-use sub-account sends one transaction ever. */
  spendSpacingBlocks?: number
  /** See `EvmChainConfig.reserveBalanceWei`: a payment that leaves its account at or above
   * this is not held to the spacing. */
  reserveBalanceWei?: bigint
  /** The wallet's one block watcher for this chain. Every wait of a payment goes through it.
   * Absent (a test of the payer alone): one is made over `provider`. */
  watcher?: EvmBlockWatcher
  /** The wallet's own accounts a stamp is paid from when no funded sub-account covers it, in
   * the order they are tried. Each is one coin at its current nonce. */
  accounts: readonly {
    source: 'main' | 'identity'
    address: string
    privateKey: () => string
  }[]
  /** Called when a payment takes funded sub-accounts (there are now fewer ready). */
  onPoolCoinsClaimed?: () => void
  /**
   * Received coins (money that arrived at one-time addresses this wallet can spend from) that
   * may pay a stamp, tried after the wallet's own accounts. Read at each claim. A coin is one
   * account at its current nonce and pays the whole stamp in one transfer, like the main
   * account.
   */
  coins?: () => readonly { address: string; privateKey: () => string }[]
  /** Called when a payment takes a received coin (its balance is about to change). */
  onCoinClaimed?: (address: string) => void
  /**
   * True while `address` is held outside this claim by something whose signed transfer is not
   * to be broadcast yet (a payment to a contact waiting for its message). Its next nonce is
   * that transfer's, so no stamp is paid from it, and a payment that could only have been paid
   * from it is refused AT ONCE with `heldRefusal` rather than waiting: the holder may be
   * waiting for this very message.
   */
  accountHeld?: (address: string) => boolean
  heldRefusal?: () => Error
}

export class EvmStampPayer {
  /** Lower-case address -> the highest nonce of a payment of this wallet seen in a block. A
   * node that lags right after that block still answers the old count; the next payment is
   * never signed at or below this. */
  private readonly settledNonce = new Map<string, number>()
  /** Lower-case address -> the account's coin, when this wallet knows it. */
  private readonly coins = new Map<string, AccountCoin>()
  readonly watcher: EvmBlockWatcher
  private fee: { value: StampFee; atMs: number } | undefined
  private feeRead: Promise<StampFee> | undefined
  constructor(private readonly config: EvmStampPayerConfig) {
    this.watcher =
      config.watcher ?? new EvmBlockWatcher({ provider: config.provider })
  }

  /** A read of the chain on behalf of a payment: its failure marks the chain unreachable and
   * is reported as such; nothing was signed. */
  private async read<T>(task: () => Promise<T>): Promise<T> {
    try {
      const value = await task()
      this.watcher.noteSuccess()
      return value
    } catch (error) {
      if (error instanceof ChainWaitCancelledError) throw error
      this.watcher.noteFailure(error)
      throw new ChainUnreachableError(error)
    }
  }

  /** The transaction spending `(address, nonce)` was seen mined at `block`: its successor coin
   * exists from `block + spacing`. */
  noteMined(address: string, nonce: number, block: number): void {
    const key = address.toLowerCase()
    const known = this.coins.get(key)
    if (known !== undefined && known.nonce > nonce) return
    this.coins.set(key, {
      nonce: nonce + 1,
      notBeforeBlock: block + (this.config.spendSpacingBlocks ?? 0),
    })
    if ((this.settledNonce.get(key) ?? -1) < nonce)
      this.settledNonce.set(key, nonce)
  }

  /**
   * The coin of `address`, for the claimant that holds the account: the one this wallet knows,
   * or read from the chain. Read from the chain: the head, the account's count there, its count
   * `spacing` blocks earlier, and its pending count, in one look. While the node still holds an
   * unmined transaction of the account there is no coin, and the next look is waited for. An
   * account that sent inside the last `spacing` blocks (which block is not known) has its coin
   * `spacing` blocks from the head.
   */
  private async coinOf(
    address: string,
    signal?: AbortSignal,
  ): Promise<AccountCoin> {
    const key = address.toLowerCase()
    const spacing = this.config.spendSpacingBlocks ?? 0
    for (;;) {
      const known = this.coins.get(key)
      const head = await this.watcher.current(signal)
      const [now, before, pending] = await this.read(() =>
        Promise.all([
          this.config.provider.getTransactionCount(address, head),
          spacing > 0 && head >= spacing
            ? this.config.provider.getTransactionCount(address, head - spacing)
            : Promise.resolve(undefined),
          this.config.provider.getTransactionCount(address, 'pending'),
        ]),
      )
      // Something of this account is in the mempool: no coin until it is mined.
      if (pending > now) {
        await this.watcher.next(signal)
        continue
      }
      const settled = this.settledNonce.get(key)
      const nonce = Math.max(now, settled === undefined ? 0 : settled + 1)
      if (known !== undefined && known.nonce >= nonce) return known
      const coin = {
        nonce,
        notBeforeBlock: before !== undefined && before !== now ? head + spacing : head,
      }
      this.coins.set(key, coin)
      return coin
    }
  }

  /**
   * Resolves once the node will let `address` spend `neededWei`. Monad admits a transaction
   * against the sender's balance as it was a few blocks back: measured on a local Monad chain
   * (docs/protocol/chains/monad-reserve-balance.md), a transfer offered 2 blocks after its
   * account was funded was refused ("Signer had insufficient balance"), at 3 blocks sometimes,
   * from 4 blocks never; and the node goes on refusing those same bytes long afterwards. So the
   * balance that counts is the one `spacing + 1` blocks back. While the account's funds are newer
   * than that, the blocks are waited for on the watcher. A chain with no spacing rule, or a node
   * that cannot answer for an earlier block, is not waited on.
   */
  private async untilFundsSettled(
    address: string,
    neededWei: bigint,
    signal?: AbortSignal,
    onWaiting?: (blocksRemaining?: number) => void,
  ): Promise<void> {
    const lag = (this.config.spendSpacingBlocks ?? 0) + 1
    if (lag <= 1) return
    for (let told = false; ; ) {
      const head = await this.watcher.current(signal)
      if (head < lag) return
      let settled: bigint
      try {
        settled = await this.config.provider.getBalance(address, head - lag)
      } catch {
        return
      }
      if (settled >= neededWei) return
      // Not covered now either: nothing to wait for; the caller's own balance check decides.
      if ((await this.read(() => this.config.provider.getBalance(address))) < neededWei)
        return
      if (!told) {
        told = true
        onWaiting?.(lag)
      }
      await this.watcher.until(head + 1, signal)
    }
  }

  /**
   * Signs the SAME payment again: the same account at the same nonce, the same destination and
   * value. Only the fee fields differ (the current fee, never more than the account can pay),
   * so the bytes and the hash differ. For a payment the node refuses to take: a node that has
   * refused a transaction goes on refusing those bytes. At most one transaction of an account
   * at a nonce is ever mined, so the two can never both pay. No request but the fee and the
   * balance; nothing is broadcast here.
   */
  async resign(payment: StampPayment, chainId: bigint): Promise<StampPayment> {
    const old = Transaction.from(payment.rawTx)
    const [fee, balance] = await this.read(() =>
      Promise.all([
        this.currentFee(),
        this.config.provider.getBalance(payment.address),
      ]),
    )
    const affordable =
      balance > old.value ? (balance - old.value) / STAMP_GAS_LIMIT : 0n
    let cap = (fee.maxFeePerGas ?? fee.gasPrice)!
    if (affordable < cap) cap = affordable
    if (cap === (old.maxFeePerGas ?? old.gasPrice)) cap -= 1n
    if (cap < fee.chargedPerGas)
      throw new Error(
        `${payment.address} cannot pay the fee of its payment again (it holds ${balance} wei)`,
      )
    const tip = fee.maxPriorityFeePerGas ?? cap
    const [signed] = await this.sign(
      {
        holder: '',
        fee:
          fee.maxFeePerGas !== undefined
            ? {
                chargedPerGas: fee.chargedPerGas,
                maxFeePerGas: cap,
                maxPriorityFeePerGas: tip < cap ? tip : cap,
              }
            : { chargedPerGas: fee.chargedPerGas, gasPrice: cap },
        accounts: [
          {
            source: payment.source,
            ...(payment.index === undefined ? {} : { index: payment.index }),
            address: payment.address,
            nonce: old.nonce,
            paymentValueWei: old.value,
          },
        ],
      },
      chainId,
      () => old.to!,
    )
    if (!signed || Transaction.from(signed.rawTx).hash === old.hash)
      throw new Error('The payment could not be signed again')
    return signed
  }

  private currentFee(): Promise<StampFee> {
    if (this.fee && Date.now() - this.fee.atMs < FEE_TTL_MS)
      return Promise.resolve(this.fee.value)
    // One read serves every payment that asks while it is in flight.
    this.feeRead ??= this.config.provider
      .getFeeData()
      .then(data => {
        let value: StampFee
        const chargedPerGas =
          data.gasPrice ?? data.maxFeePerGas ?? undefined
        if (chargedPerGas === undefined)
          throw new Error('The chain returned no fee to pay a stamp with')
        if (data.maxFeePerGas != null)
          value = {
            chargedPerGas,
            maxFeePerGas: data.maxFeePerGas,
            maxPriorityFeePerGas:
              data.maxPriorityFeePerGas ?? data.maxFeePerGas,
          }
        else value = { chargedPerGas, gasPrice: chargedPerGas }
        this.fee = { value, atMs: Date.now() }
        return value
      })
      .finally(() => {
        this.feeRead = undefined
      })
    return this.feeRead
  }

  /**
   * The smallest value worth paying in one stamp payment: what the chain charges to move it.
   * One plain transfer as this wallet builds it, 21,000 gas, at the node's current gas price
   * (a chain that charges the gas limit, as Monad does, charges exactly this). Read from the
   * node with a short cache; never a constant.
   */
  async minimumPaymentWei(): Promise<bigint> {
    return STAMP_GAS_LIMIT * (await this.read(() => this.currentFee())).chargedPerGas
  }

  /**
   * Claims, for `holder`, coins the wallet already has that pay `stampValueWei`. Nothing is
   * funded and no transaction is made to create an account to pay from: the cost of a stamp is
   * the gas of its own payments.
   *
   * 1. Funded single-use sub-accounts that are free, when they cover the value (one or several).
   * 2. Otherwise the main account, then the identity account: one payment of the whole value.
   *    Each is one coin at its current nonce, so while another payment of this wallet spends it
   *    this one waits for the chain to show that payment (`whileBusy` is called on each look so
   *    the caller can ask the chain), never signs a second transaction at the same nonce.
   *
   * Rejects with {@link InsufficientStampFundsError} when nothing the wallet has covers the
   * value; then, and on any other rejection, nothing stays claimed. Nothing is signed here.
   */
  async claim(input: {
    holder: string
    stampValueWei: bigint
    /** Limit the coins considered. Default: every source. */
    sources?: readonly StampCoinSource[]
    /** The account that would pay is held by `holder`: look at the chain for that one
     * operation's payment (nothing else, and no relay request). At most once a second. */
    whileBusy?: (holder: string) => Promise<void>
    /** Called once when this payment starts waiting for an earlier one to confirm, and again
     * with the blocks still to pass when what it waits for is the chain's spacing. */
    onWaiting?: (blocksRemaining?: number) => void
    /** Ends the wait: the claim rejects with {@link ChainWaitCancelledError}, nothing claimed,
     * nothing signed. */
    signal?: AbortSignal
    /** The value is owed, not chosen: a payment smaller than its own transfer's fee is made
     * all the same (a settlement, or the repeat of a reverted payment). */
    allowBelowFee?: boolean
  }): Promise<StampClaim> {
    const { pool, provider } = this.config
    const allowed = (source: StampCoinSource) =>
      input.sources === undefined || input.sources.includes(source)
    try {
      if (input.signal?.aborted) throw new ChainWaitCancelledError()
      const fee = await this.read(() => this.currentFee())
      const feeReserveWei =
        STAMP_GAS_LIMIT * (fee.maxFeePerGas ?? fee.gasPrice)!
      let waiting = false
      for (;;) {
        if (allowed('pool')) {
          // Balances this process has not read yet are read here, outside the claim.
          await pool.fundedCapacities(provider, feeReserveWei, {
            fromBalance: true,
            maxCacheAgeMs: Infinity,
          })
          const selected = pool.claimStampAccounts(
            input.holder,
            input.stampValueWei,
            feeReserveWei,
          )
          // No payment smaller than its own transfer's fee: a split that would make one is
          // not used, and the stamp is paid in one piece instead.
          const dust =
            input.allowBelowFee !== true &&
            selected?.some(
              account =>
                account.paymentValueWei <
                STAMP_GAS_LIMIT * fee.chargedPerGas,
            ) === true
          if (dust) pool.releaseClaim(input.holder)
          else if (selected !== undefined) {
            // An account funded in the last few blocks is not spendable yet.
            for (const account of selected)
              await this.untilFundsSettled(
                account.address,
                account.paymentValueWei + feeReserveWei,
                input.signal,
                blocks => {
                  waiting = true
                  input.onWaiting?.(blocks)
                },
              )
            this.config.onPoolCoinsClaimed?.()
            return {
              holder: input.holder,
              fee,
              accounts: selected.map(account => ({
                source: 'pool' as const,
                index: account.index,
                address: account.address.toLowerCase(),
                nonce: 0,
                paymentValueWei: account.paymentValueWei,
              })),
            }
          }
        }
        // The account an earlier operation holds that could pay this stamp, if any.
        let busy: string | undefined
        let heldElsewhere = false
        const candidates = [
          ...this.config.accounts,
          ...(this.config.coins?.() ?? []).map(coin => ({
            source: 'coin' as const,
            ...coin,
          })),
        ]
        for (const account of candidates) {
          if (!allowed(account.source)) continue
          if (this.config.accountHeld?.(account.address)) {
            heldElsewhere = true
            continue
          }
          if (pool.accountClaimedBy(account.address) !== undefined) {
            busy ??= account.address
            continue
          }
          const generation = pool.accountGeneration(account.address)
          const balanceWei = await this.read(() =>
            provider.getBalance(account.address),
          )
          if (balanceWei < input.stampValueWei + feeReserveWei) continue
          // Synchronous: free, and not spent by anyone since the nonce above was read.
          if (pool.claimAccount(input.holder, account.address, generation)) {
            // Claimed: nothing else signs from it. Its coin says the nonce to sign at and the
            // block from which it may be spent (the chain's spacing after the account's last
            // transaction): that block is waited for on the wallet's one block watcher.
            const coin = await this.coinOf(account.address, input.signal)
            const head = this.watcher.latest() ?? coin.notBeforeBlock
            // The chain's rule only bites a transfer that takes the account below its reserve.
            const aboveReserve =
              this.config.reserveBalanceWei !== undefined &&
              balanceWei - input.stampValueWei - feeReserveWei >=
                this.config.reserveBalanceWei
            if (coin.notBeforeBlock > head && !aboveReserve) {
              waiting = true
              input.onWaiting?.(coin.notBeforeBlock - head)
              await this.watcher.until(coin.notBeforeBlock, input.signal)
            }
            // Funds that arrived in the last few blocks are not spendable yet.
            await this.untilFundsSettled(
              account.address,
              input.stampValueWei + feeReserveWei,
              input.signal,
              blocks => {
                waiting = true
                input.onWaiting?.(blocks)
              },
            )
            // The balance and (after a wait) the fee, read now that the coin is this payment's.
            const [balanceNow, feeNow] = await this.read(() =>
              Promise.all([
                provider.getBalance(account.address),
                waiting ? this.currentFee() : Promise.resolve(fee),
              ]),
            )
            const counted = coin.nonce
            const settled = undefined as number | undefined
            const reserveNow =
              STAMP_GAS_LIMIT * (feeNow.maxFeePerGas ?? feeNow.gasPrice)!
            if (
              balanceNow < input.stampValueWei + reserveNow ||
              this.config.accountHeld?.(account.address)
            ) {
              pool.releaseAccountClaim(input.holder, account.address)
              continue
            }
            if (account.source === 'coin')
              this.config.onCoinClaimed?.(account.address)
            return {
              holder: input.holder,
              fee: feeNow,
              accounts: [
                {
                  source: account.source,
                  address: account.address.toLowerCase(),
                  nonce:
                    settled !== undefined && settled + 1 > counted
                      ? settled + 1
                      : counted,
                  paymentValueWei: input.stampValueWei,
                },
              ],
            }
          }
          busy ??= account.address
        }
        if (busy === undefined && heldElsewhere && this.config.heldRefusal)
          throw this.config.heldRefusal()
        if (busy === undefined)
          throw new InsufficientStampFundsError(
            `No funds cover a stamp of ${input.stampValueWei} wei plus its fee of up to ${feeReserveWei} wei`,
          )
        // The account that pays is one coin and an earlier payment is spending it: this one
        // waits its turn. It is woken when that account is released; meanwhile the chain is
        // asked about the holder's payment, that one only, at most once a second.
        if (!waiting) {
          waiting = true
          input.onWaiting?.()
        }
        const holder = pool.accountClaimedBy(busy)
        if (holder !== undefined) {
          await input.whileBusy?.(holder)
          // Woken when the account is released, or at the watcher's next look: one look of
          // the chain per interval for every waiter of the wallet together, no timer of its own.
          if (pool.accountClaimedBy(busy) !== undefined) {
            const abort = new AbortController()
            const stop = () => abort.abort()
            input.signal?.addEventListener('abort', stop, { once: true })
            try {
              const look = this.watcher.next(abort.signal)
              look.catch(() => undefined)
              await Promise.race([pool.accountReleased(busy), look])
            } catch (error) {
              if (input.signal?.aborted) throw new ChainWaitCancelledError()
              // The look was ended only because the account was released first.
              if (!(error instanceof ChainWaitCancelledError)) throw error
            } finally {
              input.signal?.removeEventListener('abort', stop)
              abort.abort()
            }
          }
        }
      }
    } catch (error) {
      pool.releaseClaim(input.holder)
      throw error
    }
  }

  /** Signs one transfer from each claimed coin to `destination(i)`. No request is made. */
  async sign(
    claim: StampClaim,
    chainId: bigint,
    destination: (childIndex: number) => string,
  ): Promise<StampPayment[]> {
    const payments: StampPayment[] = []
    for (const [childIndex, coin] of claim.accounts.entries()) {
      const signer =
        coin.source === 'pool'
          ? this.config.pool.getSigner(coin.index!, this.config)
          : new MonadAccountTxSigner({
              privateKey: (coin.source === 'coin'
                ? (this.config.coins?.() ?? []).find(
                    candidate => candidate.address.toLowerCase() === coin.address,
                  )
                : this.config.accounts.find(
                    account => account.source === coin.source,
                  ))!.privateKey(),
              provider: this.config.provider,
              httpClient: this.config.httpClient,
            })
      if (signer.address.toLowerCase() !== coin.address)
        throw new Error('Stamp account does not match its key')
      // A plain value transfer to the one-off child address: nothing on chain marks it as a
      // message payment.
      const unsigned = Transaction.from({
        type: claim.fee.maxFeePerGas !== undefined ? 2 : 0,
        chainId,
        nonce: coin.nonce,
        to: destination(childIndex),
        value: coin.paymentValueWei,
        gasLimit: STAMP_GAS_LIMIT,
        ...(claim.fee.maxFeePerGas !== undefined
          ? {
              maxFeePerGas: claim.fee.maxFeePerGas,
              maxPriorityFeePerGas: claim.fee.maxPriorityFeePerGas,
            }
          : { gasPrice: claim.fee.gasPrice }),
      })
      const signed = await signer.signFrozenUnsigned({
        from: coin.address,
        unsignedSerialized: unsigned.unsignedSerialized,
      })
      payments.push({
        source: coin.source,
        ...(coin.index === undefined ? {} : { index: coin.index }),
        address: coin.address,
        rawTx: signed.rawTx,
      })
    }
    return payments
  }

  /** Frees the accounts of a payment whose signed bytes never left the wallet. */
  release(holder: string): void {
    this.config.pool.releaseClaim(holder)
  }

  /** At open: the coins a stored, unsettled message of `holder` pays from. Returns the coins
   * another stored message already holds (two records naming one coin): the wallet still opens,
   * the first holder keeps the claim, and the chain decides both payments. */
  restore(
    holder: string,
    payments: readonly Pick<StampPayment, 'source' | 'index' | 'address'>[],
  ): string[] {
    const { pool } = this.config
    const contested: string[] = []
    for (const payment of payments) {
      try {
        if (payment.index !== undefined)
          pool.restoreClaim(holder, [payment.index])
        else pool.restoreAccountClaim(holder, payment.address)
      } catch {
        contested.push(payment.address)
      }
    }
    return contested
  }

  /** Hands one signed transaction to the chain. A node that already has it is not an error.
   * Callers outside this class use `submitPaymentSet`. */
  private async broadcast(rawTx: string): Promise<void> {
    try {
      await this.config.provider.broadcastTransaction(rawTx)
    } catch (error) {
      // "Already known" and "nonce too low" are what a second broadcaster of the same bytes is
      // told. Whether the payment landed is read from the chain (`observe`), never from here.
      if (
        !/already known|known transaction|already imported|nonce too low|nonce has already been used/i.test(
          String((error as { message?: unknown })?.message ?? error),
        )
      )
        throw error
    }
  }

  /**
   * One look at the chain for one signed payment: what the node says of it now, read directly
   * (the receipt, the transaction by its hash, the account's nonce). With a node that answers
   * there is no "unknown": the payment is mined (succeeded or reverted), in the mempool, not
   * known to the node (never arrived, or dropped: the same bytes may be offered again), or can
   * never land because another transaction consumed its nonce. Rejects with
   * {@link ChainUnreachableError} when the node does not answer.
   */
  async observe(rawTx: string): Promise<StampPaymentObservation> {
    const { provider } = this.config
    const tx = Transaction.from(rawTx)
    const [receipt, known, used] = await this.read(() =>
      Promise.all([
        provider.getTransactionReceipt(tx.hash!),
        provider.getTransaction(tx.hash!),
        provider.getTransactionCount(tx.from!, 'latest'),
      ]),
    )
    if (receipt !== null) {
      if (tx.nonce > 0 || used > 1) this.noteMined(tx.from!, tx.nonce, receipt.blockNumber)
      else {
        // A single-use account's one transaction: no successor coin to keep.
        const from = tx.from!.toLowerCase()
        if ((this.settledNonce.get(from) ?? -1) < tx.nonce)
          this.settledNonce.set(from, tx.nonce)
      }
      return {
        state: 'included',
        reverted: receipt.status === 0,
        block: receipt.blockNumber,
      }
    }
    if (known !== null) return { state: 'pending', where: 'mempool' }
    // The node knows neither the transaction nor a receipt for it.
    if (used > tx.nonce) return { state: 'replaced' }
    return { state: 'pending', where: 'unknown-to-node' }
  }

  /**
   * THE place a message's signed payment set is handed to the chain: the whole set, in order,
   * with what became of each hand-over. Today one broadcast per transaction (a node that
   * already has the bytes is not an error); a chain whose node takes a set atomically replaces
   * the loop here and nowhere else. Whether a payment landed is read from the chain
   * (`observe`), never from this.
   */
  async submitPaymentSet(
    rawTransactions: readonly string[],
  ): Promise<{ rawTx: string; error?: unknown }[]> {
    return Promise.all(
      rawTransactions.map(async rawTx => {
        try {
          await this.broadcast(rawTx)
          return { rawTx }
        } catch (error) {
          return { rawTx, error }
        }
      }),
    )
  }

  /** The chain shows the payment included: a sub-account's row is marked spent, durably. The
   * claim is NOT ended here (see `releasePayment`). */
  async recordSpent(holder: string, payment: StampPayment): Promise<void> {
    const { pool } = this.config
    if (payment.index === undefined) return
    const index = payment.index
    try {
      pool.commitSpend(index, payment.rawTx)
    } catch (error) {
      // The chain shows this account spent, and its row cannot take the record (it disagrees
      // with something else stored about this one account). The account goes out of use,
      // visibly; nothing else in the wallet is affected.
      console.warn(
        `[evm-stamp-payer] sub-account ${index} is spent on chain but its row refused the record; retiring it:`,
        error,
      )
      const row = pool.getRecord(index)
      if (row && row.status !== 'spent' && row.status !== 'retired')
        pool.setStatus(index, 'retired')
    }
    await pool.flush()
  }

  /** The chain shows the nonce consumed otherwise: this payment can never land and its claim
   * ends. A sub-account is retired; the main or identity account is simply at its next nonce. */
  async recordFailed(holder: string, payment: StampPayment): Promise<void> {
    const { pool } = this.config
    if (payment.index === undefined) return
    const row = pool.getRecord(payment.index)
    if (row && row.status !== 'spent' && row.status !== 'retired')
      pool.setStatus(payment.index, 'retired')
    await pool.flush()
  }

  /** Ends the claim on one payment's coin. Call it only AFTER the message's own record of what
   * became of the payment is on disk: until then the claim is what keeps the coin from a second
   * spender, across a crash too. */
  releasePayment(
    holder: string,
    payment: Pick<StampPayment, 'index' | 'address'>,
  ): void {
    const { pool } = this.config
    if (payment.index === undefined)
      pool.releaseAccountClaim(holder, payment.address)
    else pool.releaseClaim(holder, [payment.index])
  }
}
