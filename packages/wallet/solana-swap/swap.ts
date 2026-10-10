/**
 * Quote a Solana swap for an exact input and prepare the transaction that performs it.
 *
 * The venue comes from configuration (venues.ts): Orca Whirlpools on devnet, Jupiter on
 * mainnet. Either way the result is one unsigned transaction that enforces the minimum output,
 * and that transaction has been simulated on the cluster for this wallet:
 * - Orca: the expected output IS the simulated output of the pool's swap instruction.
 * - Jupiter: the expected output is Jupiter's quote; the simulation checks that Jupiter's
 *   transaction really delivers at least the minimum to this wallet.
 * No rate is computed from constants anywhere.
 */
import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type MessageV0,
  type TransactionInstruction,
  type TransactionMessageArgs,
  type VersionedMessage,
} from '@solana/web3.js'

import {
  fetchJupiterQuote,
  fetchJupiterSwapTransaction,
  jupiterPriceImpactBps,
  JupiterApiError,
} from './jupiter'
import {
  buildWhirlpoolSwapInstruction,
  decodeWhirlpool,
  whirlpoolOutputAtSpotPrice,
  whirlpoolTradeFee,
  type Whirlpool,
} from './orca'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  decodeMint,
  decodeTokenAccount,
  findAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  transferCheckedInstruction,
  unwrapSolInstruction,
  temporaryWrappedSolAccount,
  type AccountData,
  type TokenAccountState,
} from './spl'
import {
  NATIVE_SOL_MINT,
  validateSolanaSwapVenue,
  type JupiterVenue,
  type OrcaWhirlpoolsVenue,
  type SolanaSwapVenue,
} from './venues'

export const MAX_SLIPPAGE_BPS = 5000

export type SolanaSwapErrorCode =
  | 'invalid-request'
  | 'no-route'
  | 'insufficient-balance'
  | 'insufficient-sol'
  | 'slippage'
  | 'simulation-failed'
  | 'venue-unavailable'
  | 'unsafe-transaction'

/** A swap problem the user can act on. `detail` is the venue's or chain's own wording. */
export class SolanaSwapError extends Error {
  constructor(readonly code: SolanaSwapErrorCode, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'SolanaSwapError'
  }
}

export interface SimulatedAccount {
  readonly lamports: bigint | number
  readonly owner: string
  readonly data: readonly string[]
}

export interface SimulatedTokenBalance {
  readonly accountIndex: number
  readonly mint: string
  readonly owner?: string
  readonly uiTokenAmount: { readonly amount: string }
}

export interface SimulationResult {
  readonly err: unknown
  readonly logs: string[] | null
  readonly accounts?: (SimulatedAccount | null)[] | null
  readonly fee?: bigint | number | null
  readonly preBalances?: readonly (bigint | number)[] | null
  readonly postBalances?: readonly (bigint | number)[] | null
  readonly preTokenBalances?: readonly SimulatedTokenBalance[] | null
  readonly postTokenBalances?: readonly SimulatedTokenBalance[] | null
}

/** The RPC calls a swap makes. A web3.js `Connection` satisfies it. */
export interface SolanaSwapConnection {
  getBalance(address: PublicKey): Promise<bigint | number>
  getMultipleAccountsInfo(
    addresses: PublicKey[],
  ): Promise<(AccountData | null)[]>
  getLatestBlockhash(commitment?: 'confirmed'): Promise<{
    blockhash: TransactionMessageArgs['recentBlockhash']
    lastValidBlockHeight: bigint | number
  }>
  getFeeForMessage(
    message: VersionedMessage,
  ): Promise<{ value: bigint | number | null }>
  getBlockHeight(commitment: 'processed'): Promise<bigint | number>
  getMinimumBalanceForRentExemption(size: number): Promise<bigint | number>
  getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { programId: PublicKey },
  ): Promise<{
    value: readonly { pubkey: PublicKey; account: AccountData }[]
  }>
  simulateTransaction(
    transaction: VersionedTransaction,
    config: {
      sigVerify: boolean
      commitment: 'confirmed'
      accounts: { encoding: 'base64'; addresses: string[] }
    },
  ): Promise<{ value: SimulationResult }>
}

export interface SolanaSwapRequest {
  readonly chainIdentifier: string
  readonly owner: PublicKey
  readonly inputMint: string
  readonly outputMint: string
  /** Exact amount the wallet pays, in base units of the input mint (any platform fee included). */
  readonly amount: bigint
  readonly slippageBps: number
}

export interface SolanaSwapRouteHop {
  readonly label: string
  readonly inputMint: string
  readonly outputMint: string
}

export interface SolanaSwapQuote {
  readonly chainIdentifier: string
  readonly venueId: string
  readonly venueName: string
  readonly owner: string
  readonly inputMint: string
  readonly outputMint: string
  readonly inputAmount: bigint
  readonly expectedOutputAmount: bigint
  /** Enforced by the transaction: it fails rather than deliver less. */
  readonly minOutputAmount: bigint
  readonly slippageBps: number
  readonly priceImpactBps: number | null
  readonly route: readonly SolanaSwapRouteHop[]
  /** The pool's trade fee, already reflected in the output, when the venue reports one. */
  readonly tradeFee?: { readonly amount: bigint; readonly mint: string }
  /** Frank's own fee, only when the venue has one configured. */
  readonly platformFee?: {
    readonly amount: bigint
    readonly mint: string
    readonly bps: number
  }
  readonly networkFeeLamports: bigint
  /** Rent the wallet pays to open token accounts this swap needs; it stays in those accounts. */
  readonly accountRentLamports: bigint
  /**
   * Rent for a temporary account that the same transaction closes again: the wallet must
   * hold it, and gets it back when the swap completes.
   */
  readonly temporaryRentLamports: bigint
  /** Milliseconds since epoch when this quote was read from the venue. */
  readonly fetchedAt: number
  /** Unsigned transaction for exactly this quote. */
  readonly transaction: VersionedTransaction
  readonly lastValidBlockHeight: bigint
  /** Present when the quote is real but this wallet cannot execute it as is. */
  readonly blocker?: SolanaSwapError
  /**
   * Simulates the transaction again and re-applies the venue's checks. Called immediately
   * before signing; throws a SolanaSwapError when the swap must not be signed.
   */
  readonly recheck: () => Promise<void>
}

export interface SolanaSwapDeps {
  readonly connection: SolanaSwapConnection
  readonly venue: SolanaSwapVenue
  readonly fetchImpl?: typeof fetch
  readonly jupiterApiKey?: string
  readonly now?: () => number
}

export interface MintState {
  readonly mint: PublicKey
  readonly native: boolean
  readonly decimals: number
  readonly tokenProgram: PublicKey
  readonly tokenAccount: PublicKey
  readonly tokenAccountLamports: bigint
  /** The wallet's token account for this mint as it is now; undefined when it does not exist. */
  readonly account: TokenAccountState | undefined
}

export interface WalletState {
  readonly lamports: bigint
  readonly input: MintState
  readonly output: MintState
}

export function minimumOutput(expected: bigint, slippageBps: number): bigint {
  return (expected * BigInt(10_000 - slippageBps)) / 10_000n
}

/** Frank's fee on an amount paid, rounded down. */
export function platformFeeAmount(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

function validate(request: SolanaSwapRequest): void {
  if (request.amount <= 0n) {
    throw new SolanaSwapError(
      'invalid-request',
      'amount must be greater than zero',
    )
  }
  if (request.inputMint === request.outputMint) {
    throw new SolanaSwapError('invalid-request', 'choose two different tokens')
  }
  if (
    !Number.isInteger(request.slippageBps) ||
    request.slippageBps < 0 ||
    request.slippageBps > MAX_SLIPPAGE_BPS
  ) {
    throw new SolanaSwapError('invalid-request', 'slippage out of range')
  }
}

async function readWalletState(
  connection: SolanaSwapConnection,
  request: SolanaSwapRequest,
): Promise<WalletState> {
  const mints = [request.inputMint, request.outputMint].map(
    mint => new PublicKey(mint),
  )
  const mintAccounts = await connection.getMultipleAccountsInfo(mints)
  const decoded = mints.map((mint, i) =>
    decodeMint(mint.toBase58(), mintAccounts[i]),
  )
  const tokenAccounts = await Promise.all(
    mints.map((mint, i) =>
      findAssociatedTokenAddress(request.owner, mint, decoded[i].tokenProgram),
    ),
  )
  const [accounts, lamports] = await Promise.all([
    connection.getMultipleAccountsInfo(tokenAccounts),
    connection.getBalance(request.owner),
  ])
  const state = (i: number): MintState => ({
    mint: mints[i],
    native: mints[i].toBase58() === NATIVE_SOL_MINT,
    decimals: decoded[i].decimals,
    tokenProgram: decoded[i].tokenProgram,
    tokenAccount: tokenAccounts[i],
    tokenAccountLamports: BigInt(accounts[i]?.lamports ?? 0),
    account: decodeTokenAccount(accounts[i]),
  })
  return { lamports: BigInt(lamports), input: state(0), output: state(1) }
}

export function classifySwapFailure(
  err: unknown,
  logs: readonly string[],
): SolanaSwapError {
  const text = `${JSON.stringify(err)}\n${logs.join('\n')}`
  const lastLog = [...logs].reverse().find(line => !line.includes(' consumed '))
  if (
    /insufficient lamports|InsufficientFundsFor(Fee|Rent)|AccountNotFound/.test(
      text,
    )
  ) {
    return new SolanaSwapError('insufficient-sol', lastLog)
  }
  if (/insufficient funds/i.test(text)) {
    return new SolanaSwapError('insufficient-balance', lastLog)
  }
  if (/AmountOutBelowMinimum|SlippageToleranceExceeded|0x1771\b/.test(text)) {
    return new SolanaSwapError('slippage', lastLog)
  }
  return new SolanaSwapError(
    'simulation-failed',
    lastLog ?? JSON.stringify(err),
  )
}

function decodeSimulatedTokenAccount(
  account: SimulatedAccount | null | undefined,
): TokenAccountState | undefined {
  return account
    ? decodeTokenAccount({
        owner: new PublicKey(account.owner),
        lamports: account.lamports,
        data: decodeBase64(account.data[0]),
      })
    : undefined
}

interface SimulatedOutcome {
  readonly outputAmount: bigint
  readonly accountRentLamports: bigint
}

/** One of the wallet's token accounts as it is before the swap. */
export interface WalletTokenAccount {
  readonly address: PublicKey
  readonly state: TokenAccountState
}

/** The wallet as read from the chain just before quoting. */
export interface SolanaWalletSnapshot {
  readonly state: WalletState
  readonly walletAccounts: readonly WalletTokenAccount[]
}

export interface SwapCheck {
  readonly owner: PublicKey
  readonly state: WalletState
  /** Exact amount of the input the wallet agreed to pay. */
  readonly inputAmount: bigint
  /** Least output the wallet accepts; zero only while probing for the expected output. */
  readonly minOutputAmount: bigint
  readonly networkFeeLamports: bigint
  /** Every token account the wallet has, so none can be touched unnoticed. */
  readonly walletAccounts: readonly WalletTokenAccount[]
  /** Platform-fee token account, and whether this swap is what opens it (and pays its rent). */
  readonly feeAccount?: PublicKey
  readonly feeAccountIsNew?: boolean
}

const SYSTEM_PROGRAM = SystemProgram.programId.toBase58()

async function readWalletTokenAccounts(
  connection: SolanaSwapConnection,
  owner: PublicKey,
): Promise<WalletTokenAccount[]> {
  const lists = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(programId =>
      connection.getTokenAccountsByOwner(owner, { programId }),
    ),
  )
  return lists.flatMap(list =>
    list.value.map(entry => ({
      address: entry.pubkey,
      state: decodeTokenAccount(entry.account)!,
    })),
  )
}

/**
 * Runs the transaction on the cluster without sending it, checks everything it would do to
 * this wallet against the swap that was agreed, and returns what the wallet would receive.
 *
 * Refused (`unsafe-transaction`) unless, from the simulation's own before/after state:
 * - the input is debited by no more than the agreed amount;
 * - the output is credited by at least the minimum;
 * - no other SOL leaves, beyond rent for token accounts opened by this swap;
 * - no other token of the wallet moves, and no token account of the wallet changes owner,
 *   gains a delegate or a close authority, or disappears;
 * - the wallet remains an ordinary account.
 * A transaction that would fail throws the program's own reason instead.
 */
export async function simulateAndCheckSwap(
  connection: SolanaSwapConnection,
  transaction: VersionedTransaction,
  check: SwapCheck,
): Promise<SimulatedOutcome> {
  const { owner, state } = check
  const { input, output } = state
  const ownerAddress = owner.toBase58()
  const watched = [
    owner,
    output.tokenAccount,
    ...(check.feeAccount ? [check.feeAccount] : []),
    ...check.walletAccounts.map(account => account.address),
  ]
  const { value } = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    commitment: 'confirmed',
    accounts: {
      encoding: 'base64',
      addresses: watched.map(address => address.toBase58()),
    },
  })
  if (value.err) throw classifySwapFailure(value.err, value.logs ?? [])
  const refuse = (why: string): never => {
    throw new SolanaSwapError('unsafe-transaction', why)
  }
  const after = value.accounts ?? []
  const afterOf = (address: PublicKey) =>
    after[watched.findIndex(entry => entry.equals(address))]
  const ownerAfter = after[0]
  if (!ownerAfter || after.length !== watched.length) {
    return refuse('the network did not report the balances to check')
  }
  if (ownerAfter.owner !== SYSTEM_PROGRAM) {
    refuse('changes who controls the wallet account')
  }

  // Every token account the wallet already has: only the swap's own two may change amount,
  // and none may change hands.
  const inputMint = input.mint.toBase58()
  const outputMint = output.mint.toBase58()
  let inputDebited = 0n
  let wrappedBefore = 0n
  let wrappedAfter = 0n
  for (const account of check.walletAccounts) {
    const before = account.state
    const mint = before.mint.toBase58()
    const simulated = afterOf(account.address)
    const now = decodeSimulatedTokenAccount(simulated)
    if (mint === NATIVE_SOL_MINT) {
      // Wrapped SOL is SOL: an aggregator may unwrap the wallet's own account into the wallet.
      wrappedBefore += before.amount
      wrappedAfter += now?.amount ?? 0n
      if (!now) continue
    }
    if (!now) return refuse("closes one of the wallet's token accounts")
    if (
      now.owner.toBase58() !== ownerAddress ||
      now.delegate !== before.delegate ||
      now.closeAuthority !== before.closeAuthority
    ) {
      refuse('changes who may spend from or close a token account')
    }
    if (mint === inputMint) inputDebited += before.amount - now.amount
    else if (mint !== outputMint && mint !== NATIVE_SOL_MINT) {
      if (now.amount < before.amount) {
        refuse('moves a token that is not part of the swap')
      }
    }
  }
  if (!input.native && inputDebited > check.inputAmount) {
    refuse('debits more of the input token than agreed')
  }

  // Simulation charges the network fee to the payer like a real run (checked on devnet and
  // mainnet RPCs); add it back so the amounts below are the swap's own.
  const lamportsAfter =
    BigInt(ownerAfter.lamports) + BigInt(value.fee ?? check.networkFeeLamports)
  const feeAccountAfter = check.feeAccount && afterOf(check.feeAccount)
  const feeAccountRent =
    feeAccountAfter && check.feeAccountIsNew
      ? BigInt(feeAccountAfter.lamports)
      : 0n
  // SOL held by the wallet, wrapped or not, before and after.
  const solBefore = state.lamports + wrappedBefore
  const solAfter = lamportsAfter + wrappedAfter

  if (output.native) {
    const received =
      solAfter -
      solBefore +
      (input.native ? check.inputAmount : 0n) +
      feeAccountRent
    if (received < check.minOutputAmount) {
      refuse('returns less SOL than the agreed minimum')
    }
    return {
      outputAmount: received > 0n ? received : 0n,
      accountRentLamports: feeAccountRent,
    }
  }
  const outputAfter = afterOf(output.tokenAccount)
  const tokenAfter = decodeSimulatedTokenAccount(outputAfter)
  if (
    !outputAfter ||
    !tokenAfter ||
    tokenAfter.owner.toBase58() !== ownerAddress
  ) {
    return refuse("output account is not the wallet's")
  }
  if (
    tokenAfter.delegate !== (output.account?.delegate ?? null) ||
    tokenAfter.closeAuthority !== (output.account?.closeAuthority ?? null)
  ) {
    refuse('changes who may spend from or close a token account')
  }
  const credited = tokenAfter.amount - (output.account?.amount ?? 0n)
  if (credited < check.minOutputAmount) {
    refuse('credits less than the agreed minimum')
  }
  const outputRent = output.account ? 0n : BigInt(outputAfter.lamports)
  const solSpent = solBefore - solAfter
  const solAllowed =
    (input.native ? check.inputAmount : 0n) + outputRent + feeAccountRent
  if (solSpent > solAllowed) refuse('spends more SOL than the swap needs')
  return {
    outputAmount: credited,
    accountRentLamports: outputRent + feeAccountRent,
  }
}

function compile(
  owner: PublicKey,
  blockhash: TransactionMessageArgs['recentBlockhash'],
  instructions: TransactionInstruction[],
): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  )
}

/** The configured pool that trades the pair. A pool that fails verification is skipped. */
async function findWhirlpool(
  deps: SolanaSwapDeps,
  venue: OrcaWhirlpoolsVenue,
  request: SolanaSwapRequest,
): Promise<{ pool: Whirlpool; aToB: boolean }> {
  const programId = new PublicKey(venue.programId)
  const addresses = venue.pools.map(pool => new PublicKey(pool))
  const accounts = await deps.connection.getMultipleAccountsInfo(addresses)
  for (let i = 0; i < addresses.length; i++) {
    let pool: Whirlpool
    try {
      pool = decodeWhirlpool(addresses[i], programId, accounts[i])
    } catch {
      continue // disables only this pool's pair
    }
    const a = pool.tokenMintA.toBase58()
    const b = pool.tokenMintB.toBase58()
    if (a === request.inputMint && b === request.outputMint) {
      return { pool, aToB: true }
    }
    if (b === request.inputMint && a === request.outputMint) {
      return { pool, aToB: false }
    }
  }
  throw new SolanaSwapError('no-route')
}

/** A swap whose minimum rounds to nothing would accept receiving nothing. */
function requireMinimum(minOutputAmount: bigint): bigint {
  if (minOutputAmount <= 0n) {
    throw new SolanaSwapError('invalid-request', 'amount is too small to swap')
  }
  return minOutputAmount
}

/**
 * What a venue hands back for one swap: the quote, the transaction built for it, and what that
 * transaction may and may not do to the wallet. The driver (`quoteSolanaSwap`) runs the same
 * safety check on every exchange's transaction, whoever built it. See dex.ts.
 */
export type PreparedSolanaSwap = Omit<
  SolanaSwapQuote,
  | 'chainIdentifier'
  | 'venueId'
  | 'venueName'
  | 'accountRentLamports'
  | 'fetchedAt'
  | 'blocker'
  | 'recheck'
> & { readonly check: SwapCheck }

export async function prepareOrcaSwap(
  deps: SolanaSwapDeps,
  venue: OrcaWhirlpoolsVenue,
  request: SolanaSwapRequest,
  { state: wallet, walletAccounts }: SolanaWalletSnapshot,
): Promise<PreparedSolanaSwap> {
  const { connection } = deps
  const { owner, amount } = request
  // The expected output comes from simulating with this wallet, so it must hold the input.
  if (
    (wallet.input.native
      ? wallet.lamports
      : wallet.input.account?.amount ?? 0n) < amount
  ) {
    throw new SolanaSwapError('insufficient-balance')
  }
  const { pool, aToB } = await findWhirlpool(deps, venue, request)
  const latest = await connection.getLatestBlockhash('confirmed')

  // Frank's fee, when configured, is its own explicit transfer of the input token; the pool
  // has no slot for it. The rest is what gets swapped.
  const feeAmount = venue.interfaceFee
    ? platformFeeAmount(amount, venue.interfaceFee.bps)
    : 0n
  const swapAmount = amount - feeAmount
  const feeRecipient =
    feeAmount > 0n ? new PublicKey(venue.interfaceFee!.recipient) : undefined
  const feeAccount =
    feeRecipient && !wallet.input.native
      ? await findAssociatedTokenAddress(
          feeRecipient,
          wallet.input.mint,
          wallet.input.tokenProgram,
        )
      : undefined
  const feeAccountIsNew =
    feeAccount !== undefined &&
    (await connection.getMultipleAccountsInfo([feeAccount]))[0] === null

  // SOL is wrapped in a temporary account made for this swap and closed after it.
  const hasNativeSide = wallet.input.native || wallet.output.native
  const temporaryRent = hasNativeSide
    ? BigInt(
        await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
      )
    : 0n
  const temporary = hasNativeSide
    ? await temporaryWrappedSolAccount({
        owner,
        // Derived, not random: the same swap built anywhere gets the same account.
        seed: latest.blockhash.slice(0, 32),
        rentLamports: temporaryRent,
        lamports: wallet.input.native ? swapAmount : 0n,
      })
    : undefined
  const side = (mint: MintState): MintState =>
    mint.native && temporary
      ? {
          ...mint,
          tokenAccount: temporary.address,
          tokenAccountLamports: 0n,
          account: undefined,
        }
      : mint
  const input = side(wallet.input)
  const output = side(wallet.output)
  const state: WalletState = { lamports: wallet.lamports, input, output }
  const [a, b] = aToB ? [input, output] : [output, input]

  const build = async (minOutputAmount: bigint) => {
    const instructions: TransactionInstruction[] = []
    if (!output.native) {
      // Opened once and kept.
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction({
          payer: owner,
          associatedToken: output.tokenAccount,
          owner,
          mint: output.mint,
          tokenProgram: output.tokenProgram,
        }),
      )
    }
    if (temporary) instructions.push(...temporary.instructions)
    if (feeRecipient && feeAccount) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction({
          payer: owner,
          associatedToken: feeAccount,
          owner: feeRecipient,
          mint: input.mint,
          tokenProgram: input.tokenProgram,
        }),
        transferCheckedInstruction({
          source: input.tokenAccount,
          mint: input.mint,
          destination: feeAccount,
          owner,
          amount: feeAmount,
          decimals: input.decimals,
          tokenProgram: input.tokenProgram,
        }),
      )
    } else if (feeRecipient) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: feeRecipient,
          lamports: feeAmount,
        }),
      )
    }
    instructions.push(
      await buildWhirlpoolSwapInstruction({
        programId: new PublicKey(venue.programId),
        pool,
        owner,
        ownerTokenAccountA: a.tokenAccount,
        ownerTokenAccountB: b.tokenAccount,
        tokenProgramA: a.tokenProgram,
        tokenProgramB: b.tokenProgram,
        aToB,
        inputAmount: swapAmount,
        minOutputAmount,
      }),
    )
    if (temporary) {
      instructions.push(
        unwrapSolInstruction({ owner, wrappedSolAccount: temporary.address }),
      )
    }
    return compile(owner, latest.blockhash, instructions)
  }

  const probe = await build(0n)
  const fee = BigInt(
    (await connection.getFeeForMessage(probe.message)).value ?? 0,
  )
  const check = (minimum: bigint): SwapCheck => ({
    owner,
    state,
    inputAmount: amount,
    minOutputAmount: minimum,
    networkFeeLamports: fee,
    walletAccounts,
    feeAccount,
    feeAccountIsNew,
  })
  // The expected output IS what the pool's swap delivers in simulation.
  const expected = (await simulateAndCheckSwap(connection, probe, check(0n)))
    .outputAmount
  const minOutputAmount = requireMinimum(
    minimumOutput(expected, request.slippageBps),
  )
  const transaction = await build(minOutputAmount)
  const atSpot = whirlpoolOutputAtSpotPrice(pool, swapAmount, aToB)
  return {
    owner: owner.toBase58(),
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmount: amount,
    expectedOutputAmount: expected,
    minOutputAmount,
    slippageBps: request.slippageBps,
    priceImpactBps:
      atSpot > 0n && atSpot > expected
        ? Number(((atSpot - expected) * 1_000_000n) / atSpot) / 100
        : 0,
    route: [
      {
        label: 'Orca Whirlpool',
        inputMint: request.inputMint,
        outputMint: request.outputMint,
      },
    ],
    tradeFee: {
      amount: whirlpoolTradeFee(pool, swapAmount),
      mint: request.inputMint,
    },
    ...(feeAmount > 0n
      ? {
          platformFee: {
            amount: feeAmount,
            mint: request.inputMint,
            bps: venue.interfaceFee!.bps,
          },
        }
      : {}),
    networkFeeLamports: fee,
    temporaryRentLamports: temporaryRent,
    transaction,
    lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
    check: check(minOutputAmount),
  }
}

/** Blocks a blockhash stays valid for. */
const BLOCKHASH_LIFETIME_BLOCKS = 150n

function readU64(data: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i])
  return value
}

/**
 * Reads a transaction Jupiter built, instruction by instruction, and refuses anything that is
 * not part of the quoted swap. Lookup tables are resolved from the chain here, not taken on
 * trust. Allowed, and nothing else:
 * - compute-budget instructions;
 * - creating a token account that this wallet owns;
 * - wrapping SOL into the wallet's own wrapped-SOL account (no more than the input), and
 *   closing that account back into the wallet;
 * - exactly one call to Jupiter's program whose own arguments are the quoted input, the
 *   quoted output and the reviewed slippage, so the minimum is enforced on chain.
 * In particular a transfer to anyone else, an Approve or a SetAuthority is refused.
 */
export async function assertJupiterTransactionIsTheQuotedSwap(
  connection: Pick<SolanaSwapConnection, 'getMultipleAccountsInfo'>,
  transaction: VersionedTransaction,
  expected: {
    owner: PublicKey
    jupiterProgramId: string
    wrappedSolAccount: PublicKey
    inputIsSol: boolean
    inputAmount: bigint
    quotedOutputAmount: bigint
    slippageBps: number
    platformFeeBps: number
  },
): Promise<void> {
  const refuse = (why: string): never => {
    throw new SolanaSwapError('unsafe-transaction', why)
  }
  if (transaction.message.version !== 0) {
    return refuse('transaction is not a version 0 transaction')
  }
  const message = transaction.message as MessageV0
  if (
    message.header.numRequiredSignatures !== 1 ||
    !message.staticAccountKeys[0]?.equals(expected.owner)
  ) {
    refuse('transaction is not paid and signed by this wallet alone')
  }
  const tableKeys = message.addressTableLookups.map(lookup => lookup.accountKey)
  const tableAccounts = tableKeys.length
    ? await connection.getMultipleAccountsInfo(tableKeys)
    : []
  const tables = tableKeys.map((key, i) => {
    const account = tableAccounts[i]
    if (!account)
      return refuse('uses an address lookup table that does not exist')
    return new AddressLookupTableAccount({
      key,
      state: AddressLookupTableAccount.deserialize(account.data),
    })
  })
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables })
  const key = (index: number): string => keys.get(index)?.toBase58() ?? ''
  const owner = expected.owner.toBase58()
  const wrapped = expected.wrappedSolAccount.toBase58()
  const tokenPrograms: string[] = [
    TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
  ]
  let jupiterCalls = 0
  for (const instruction of message.compiledInstructions) {
    const program = key(instruction.programIdIndex)
    const account = (i: number) => key(instruction.accountKeyIndexes[i])
    const data = instruction.data
    if (program === 'ComputeBudget111111111111111111111111111111') continue
    if (program === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
      if (account(0) !== owner || account(2) !== owner) {
        refuse('creates a token account for someone else')
      }
    } else if (program === SYSTEM_PROGRAM) {
      const isTransfer = data.length === 12 && data[0] === 2 && data[1] === 0
      if (
        !isTransfer ||
        !expected.inputIsSol ||
        account(0) !== owner ||
        account(1) !== wrapped ||
        readU64(data, 4) > expected.inputAmount
      ) {
        refuse('moves SOL somewhere other than into the swap')
      }
    } else if (tokenPrograms.includes(program)) {
      const syncNative = data[0] === 17 && account(0) === wrapped
      const closeWrapped =
        data[0] === 9 &&
        account(0) === wrapped &&
        account(1) === owner &&
        account(2) === owner
      if (!syncNative && !closeWrapped) {
        refuse('carries a token instruction that is not part of the swap')
      }
    } else if (program === expected.jupiterProgramId) {
      jupiterCalls++
      // Every Jupiter route instruction ends: input u64, quoted output u64, slippage u16,
      // platform fee u8.
      const tail = data.length - 19
      if (
        tail < 8 ||
        readU64(data, tail) !== expected.inputAmount ||
        readU64(data, tail + 8) !== expected.quotedOutputAmount ||
        (data[tail + 16] | (data[tail + 17] << 8)) !== expected.slippageBps ||
        data[tail + 18] !== expected.platformFeeBps
      ) {
        refuse(
          'swap instruction does not carry the quoted amounts and slippage',
        )
      }
    } else {
      refuse(`calls a program that is not part of the swap (${program})`)
    }
  }
  if (jupiterCalls !== 1) refuse('does not contain exactly one swap')
}

export async function prepareJupiterSwap(
  deps: SolanaSwapDeps,
  venue: JupiterVenue,
  request: SolanaSwapRequest,
  { state, walletAccounts }: SolanaWalletSnapshot,
): Promise<PreparedSolanaSwap> {
  const { connection } = deps
  const client = {
    apiBaseUrl: venue.apiBaseUrl,
    apiKey: deps.jupiterApiKey,
    fetchImpl: deps.fetchImpl,
  }
  // Frank's fee, when configured, goes through Jupiter's own platform-fee parameters and is
  // taken from the output into the collector's token account for that mint.
  const feeAccount = venue.interfaceFee
    ? await findAssociatedTokenAddress(
        new PublicKey(venue.interfaceFee.recipient),
        state.output.mint,
        state.output.tokenProgram,
      )
    : undefined
  let quote, swap
  try {
    quote = await fetchJupiterQuote(client, {
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
      slippageBps: request.slippageBps,
      platformFeeBps: venue.interfaceFee?.bps,
    })
    swap = await fetchJupiterSwapTransaction(client, {
      quote,
      userPublicKey: request.owner.toBase58(),
      feeAccount: feeAccount?.toBase58(),
    })
  } catch (error) {
    if (error instanceof JupiterApiError) {
      throw new SolanaSwapError(
        error.status === 400 || error.status === 404
          ? 'no-route'
          : 'venue-unavailable',
        error.message,
      )
    }
    throw new SolanaSwapError('venue-unavailable', String(error))
  }
  const expected = BigInt(quote.outAmount)
  const minOutputAmount = requireMinimum(BigInt(quote.otherAmountThreshold))
  // The minimum must be at least what the reviewed slippage allows; "0" or a looser bound
  // would let the swap deliver far less than was shown.
  if (
    quote.slippageBps !== request.slippageBps ||
    minOutputAmount < minimumOutput(expected, request.slippageBps)
  ) {
    throw new SolanaSwapError(
      'unsafe-transaction',
      'quoted minimum is looser than the chosen slippage',
    )
  }
  const transaction = VersionedTransaction.deserialize(
    decodeBase64(swap.swapTransaction),
  )
  // Jupiter built this transaction, so nothing about it is taken on trust: first what it
  // says (every instruction), then what it does (every balance, in simulation).
  await assertJupiterTransactionIsTheQuotedSwap(connection, transaction, {
    owner: request.owner,
    jupiterProgramId: venue.programId,
    wrappedSolAccount: await findAssociatedTokenAddress(
      request.owner,
      new PublicKey(NATIVE_SOL_MINT),
    ),
    inputIsSol: state.input.native,
    inputAmount: request.amount,
    quotedOutputAmount: expected,
    slippageBps: request.slippageBps,
    platformFeeBps: venue.interfaceFee?.bps ?? 0,
  })

  // Includes the priority fee Jupiter set on the transaction.
  const fee = BigInt(
    (await connection.getFeeForMessage(transaction.message)).value ?? 0,
  )
  // When this transaction can no longer land is decided from the chain, never from the API:
  // its blockhash cannot be newer than the chain's tip, so it expires no later than one
  // blockhash lifetime after the tip seen now (doubled, in case the API's node was ahead).
  const tip = BigInt(await connection.getBlockHeight('processed'))
  const lastValidBlockHeight = tip + 2n * BLOCKHASH_LIFETIME_BLOCKS
  const platformFee = quote.platformFee as { amount: string } | null
  return {
    owner: request.owner.toBase58(),
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmount: request.amount,
    expectedOutputAmount: expected,
    minOutputAmount,
    slippageBps: request.slippageBps,
    priceImpactBps: jupiterPriceImpactBps(quote),
    route: quote.routePlan.map(hop => ({
      label: hop.swapInfo.label ?? hop.swapInfo.ammKey,
      inputMint: hop.swapInfo.inputMint,
      outputMint: hop.swapInfo.outputMint,
    })),
    ...(venue.interfaceFee && platformFee
      ? {
          platformFee: {
            amount: BigInt(platformFee.amount),
            mint: request.outputMint,
            bps: venue.interfaceFee.bps,
          },
        }
      : {}),
    networkFeeLamports: fee,
    temporaryRentLamports: 0n,
    transaction,
    lastValidBlockHeight,
    check: {
      owner: request.owner,
      state,
      inputAmount: request.amount,
      minOutputAmount,
      networkFeeLamports: fee,
      walletAccounts,
    },
  }
}

/** An exchange's own part of a swap: quote the exact input and build its transaction. */
export type PrepareSolanaSwap<V extends SolanaSwapVenue> = (
  deps: SolanaSwapDeps & { venue: V },
  venue: V,
  request: SolanaSwapRequest,
  wallet: SolanaWalletSnapshot,
) => Promise<PreparedSolanaSwap>

/**
 * A fresh quote, with its ready-to-sign transaction, for swapping an exact input amount on
 * one exchange. Reads everything from the exchange and the chain at call time. The exchange
 * supplies `prepare`; everything else here is the same for every exchange (see dex.ts).
 */
export async function quoteSolanaSwap<V extends SolanaSwapVenue>(
  deps: SolanaSwapDeps & { venue: V },
  request: SolanaSwapRequest,
  prepare: PrepareSolanaSwap<V>,
): Promise<SolanaSwapQuote> {
  validate(request)
  const venue = validateSolanaSwapVenue(deps.venue)
  const [state, walletAccounts] = await Promise.all([
    readWalletState(deps.connection, request),
    readWalletTokenAccounts(deps.connection, request.owner),
  ])
  const prepared = await prepare(deps, venue, request, {
    state,
    walletAccounts,
  })
  // The one safety check every venue's transaction passes, whoever built it: simulate, and
  // compare what it would do to the wallet with the swap that was quoted.
  const { check, ...body } = prepared
  const verify = () =>
    simulateAndCheckSwap(deps.connection, prepared.transaction, check)
  let blocker: SolanaSwapError | undefined
  let accountRentLamports = 0n
  try {
    accountRentLamports = (await verify()).accountRentLamports
  } catch (error) {
    // The quote itself is real; this wallet just cannot execute it (usually: not funded).
    if (!(error instanceof SolanaSwapError)) throw error
    if (error.code === 'unsafe-transaction') throw error
    blocker = error
  }
  return {
    chainIdentifier: request.chainIdentifier,
    venueId: venue.id,
    venueName: venue.displayName,
    ...body,
    accountRentLamports,
    fetchedAt: (deps.now ?? Date.now)(),
    blocker,
    recheck: async () => void (await verify()),
  }
}
