import { Transaction } from 'ethers'

/**
 * Each account's transactions reach the node in nonce order, one coin at a time: broadcasting
 * the transaction that spends [account, n] first waits for [account, n-1] to be SENT, that is
 * handed to the node by this wallet, seen in its mempool, or mined (a gap filler at n-1 counts
 * as n-1's transaction). The wait is per coin and chained (n+2 waits on n+1); it holds nothing
 * else, so other accounts go in parallel. It never times out: only an ownership event (n's
 * operation released as provably unexposed, its nonce taken by a filler) moves a stuck n.
 *
 * In memory only. After a restart it is rebuilt from the coin list: `settled(account, nonce)`
 * says what the list already knows is past (mined, or not a coin this wallet spends), and the
 * reopen pass marks what the node shows in its mempool or takes again.
 */
export class EvmBroadcastGate {
  private readonly sent = new Map<string, { promise: Promise<void>; resolve: () => void; done: boolean }>()

  private readonly waiting = new Set<string>()

  constructor(
    /** True when [account, nonce] needs no wait: mined, or no transaction of the wallet's. */
    private readonly settled: (account: string, nonce: number) => boolean,
  ) {}

  private entry(account: string, nonce: number) {
    const key = `${account.toLowerCase()}:${nonce}`
    let entry = this.sent.get(key)
    if (entry === undefined) {
      let resolve!: () => void
      const promise = new Promise<void>(r => (resolve = r))
      entry = { promise, resolve, done: false }
      this.sent.set(key, entry)
    }
    return entry
  }

  isSent(account: string, nonce: number): boolean {
    if (nonce < 0 || this.settled(account.toLowerCase(), nonce)) return true
    return this.sent.get(`${account.toLowerCase()}:${nonce}`)?.done === true
  }

  /** Resolves once [account, nonce]'s transaction is sent. */
  whenSent(account: string, nonce: number): Promise<void> {
    if (this.isSent(account, nonce)) return Promise.resolve()
    return this.entry(account, nonce).promise
  }

  /** [account, nonce]'s transaction is out: by this wallet, in the node's mempool, or mined. */
  markSent(account: string, nonce: number): void {
    const entry = this.entry(account, nonce)
    entry.done = true
    entry.resolve()
  }

  /** Mined or dropped from the list: nothing is kept for it. */
  forget(account: string, nonce: number): void {
    const key = `${account.toLowerCase()}:${nonce}`
    const entry = this.sent.get(key)
    if (entry !== undefined && entry.done) this.sent.delete(key)
  }

  /**
   * Hands `rawTransactions` to `send`, each once its account's previous nonce is sent. Within
   * the set, a transaction whose predecessor's hand-over failed is not offered (a later pass
   * offers both again). One whose predecessor belongs to an operation still in progress waits
   * for it detached: the result says `waiting`, and the transaction is handed over when the
   * predecessor goes out, so no caller is held by another operation's progress.
   */
  async submit(
    rawTransactions: readonly string[],
    send: (rawTx: string) => Promise<void>,
  ): Promise<{ rawTx: string; error?: unknown; waiting?: true }[]> {
    const txs = [...new Set(rawTransactions)].map(rawTx => {
      const tx = Transaction.from(rawTx)
      return { rawTx, account: tx.from!.toLowerCase(), nonce: tx.nonce }
    })
    const inSet = new Map<string, Promise<'sent' | 'failed' | 'waiting'>>()
    // Wired lowest nonce first, so each finds its predecessor's hand-over in the set.
    const wiring = [...txs].sort((a, b) => a.nonce - b.nonce)
    const outcomes = new Map<string, Promise<{ rawTx: string; error?: unknown; waiting?: true }>>()
    for (const tx of wiring) {
      const below = inSet.get(`${tx.account}:${tx.nonce - 1}`)
      const handOver = async () => {
        await send(tx.rawTx)
        this.markSent(tx.account, tx.nonce)
      }
      const outcome = (async () => {
        // The predecessor in this set is offered first; one it could not hand over stops this one.
        if (below !== undefined && (await below) === 'failed')
          return { rawTx: tx.rawTx, error: new PredecessorNotSentError(tx.account, tx.nonce - 1) }
        if (!this.isSent(tx.account, tx.nonce - 1)) {
          // One detached wait per transaction, however many passes offer it meanwhile.
          if (!this.waiting.has(tx.rawTx)) {
            this.waiting.add(tx.rawTx)
            void this.whenSent(tx.account, tx.nonce - 1)
              .then(handOver)
              .catch(() => undefined)
              .finally(() => this.waiting.delete(tx.rawTx))
          }
          return { rawTx: tx.rawTx, waiting: true as const }
        }
        try {
          await handOver()
          return { rawTx: tx.rawTx }
        } catch (error) {
          return { rawTx: tx.rawTx, error }
        }
      })()
      inSet.set(
        `${tx.account}:${tx.nonce}`,
        outcome.then(result =>
          result.error !== undefined ? 'failed' : result.waiting ? 'waiting' : 'sent',
        ),
      )
      outcomes.set(tx.rawTx, outcome)
    }
    return Promise.all(txs.map(tx => outcomes.get(tx.rawTx)!))
  }
}

/** The transaction below this one in its account was not handed over in the same set. */
export class PredecessorNotSentError extends Error {
  constructor(account: string, nonce: number) {
    super(`The transaction of ${account} at nonce ${nonce} was not sent`)
    this.name = 'PredecessorNotSentError'
  }
}
