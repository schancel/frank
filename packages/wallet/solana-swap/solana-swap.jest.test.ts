/**
 * Solana swap at its narrow seams. The RPC and Jupiter responses replayed here were recorded
 * from the real networks (fixtures/*.json); the real end-to-end run is
 * `packages/wallet/solana-swap.livecheck.ts`.
 */
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import confirmedSwaps from './fixtures/devnet-confirmed-swaps.json'
import jupiterFixture from './fixtures/jupiter-mainnet-sol-to-usdc.json'
import orcaFixture from './fixtures/orca-devnet-quotes.json'
import { swapRecordId } from '../chain/evm-legacy-consolidator'
import { createSolanaDex, type SolanaDexWallet } from './dex'
import {
  createSolanaLegacySender,
  observeSolanaSwapRecord,
  observeSwapTransaction,
  resumeSolanaLegacyTransactions,
  SolanaSwapRecordMismatchError,
  SolanaSwapStillPendingError,
  swapRecordItemOf,
  trackSolanaSwap,
  type PreparedLegacyTransaction,
  type SolanaLegacyJournalEntry,
  type SolanaSwapIntent,
  type SolanaSwapRecord,
  type SolanaSwapSender,
  type SwapTransactionMeta,
} from './execute'
import {
  decodeWhirlpool,
  swapTickArrayStartIndexes,
  whirlpoolTradeFee,
} from './orca'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  fetchSwapTokenBalances,
  findAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from './spl'
import {
  minimumOutput,
  platformFeeAmount,
  simulateAndCheckSwap,
  SolanaSwapError,
  type SolanaSwapConnection,
  type SwapCheck,
} from './swap'
import {
  getSolanaSwapVenue,
  getSolanaSwapVenues,
  listSolanaDexEntries,
  NATIVE_SOL_MINT,
  validateSolanaSwapVenue,
  type JupiterVenue,
  type OrcaWhirlpoolsVenue,
} from './venues'
import { SolanaWallet } from '../solana-wallet'

const OWNER = new PublicKey(orcaFixture.owner)
const DEVNET = listSolanaDexEntries('solana-devnet')[0] as OrcaWhirlpoolsVenue
const JUPITER = listSolanaDexEntries('solana-mainnet').find(
  entry => entry.adapter === 'jupiter',
) as JupiterVenue
const DEV_USDC = DEVNET.tokens[1].mint
const USDC = JUPITER.tokens[1].mint
const STRANGER = new PublicKey('2xxDGGSDHvuRqrcqfqEFaqYMTsrk5nMf7CjN3i9sn7er')

const fromBase64 = (value: string) =>
  Uint8Array.from(Buffer.from(value, 'base64'))
const toBase64 = (value: Uint8Array) => Buffer.from(value).toString('base64')

/** Turns the recorder's JSON back into the values web3.js returned. */
function revive(value: any): any {
  if (Array.isArray(value)) return value.map(revive)
  if (value && typeof value === 'object') {
    if ('$bigint' in value) return BigInt(value.$bigint)
    if ('$bytes' in value) return fromBase64(value.$bytes)
    if ('$pubkey' in value) return new PublicKey(value.$pubkey)
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, revive(inner)]),
    )
  }
  return value
}

interface RecordedCall {
  method: string
  args: any[]
  result: any
}

/**
 * Replays recorded RPC calls and fails if the code asks for anything that was not recorded.
 * `edit` may alter a result on its way out, to stand in for a chain that answers differently.
 */
function replay(
  calls: RecordedCall[],
  edit: (method: string, result: any) => any = (_m, result) => result,
): SolanaSwapConnection {
  const queue = [...calls]
  const next = (method: string, args: unknown[]) => {
    const wanted = JSON.stringify({ method, args })
    const index = queue.findIndex(
      call =>
        JSON.stringify({ method: call.method, args: call.args }) === wanted,
    )
    if (index < 0)
      throw new Error(`unrecorded RPC call: ${wanted.slice(0, 300)}`)
    return edit(method, revive(queue.splice(index, 1)[0].result))
  }
  return {
    getBalance: async address => next('getBalance', [address.toBase58()]),
    getMultipleAccountsInfo: async addresses =>
      next('getMultipleAccountsInfo', [addresses.map(a => a.toBase58())]),
    getLatestBlockhash: async (...args) => next('getLatestBlockhash', args),
    getFeeForMessage: async message =>
      next('getFeeForMessage', [toBase64(message.serialize())]),
    getBlockHeight: async (...args) => next('getBlockHeight', args),
    getMinimumBalanceForRentExemption: async (...args) =>
      next('getMinimumBalanceForRentExemption', args),
    getTokenAccountsByOwner: async (owner, filter) =>
      next('getTokenAccountsByOwner', [
        owner.toBase58(),
        filter.programId.toBase58(),
      ]),
    simulateTransaction: async (transaction, config) =>
      next('simulateTransaction', [toBase64(transaction.serialize()), config]),
  }
}

const noSend = {
  sendLegacyTransaction: async () => {
    throw new Error('not sending in this test')
  },
  legacyTransactionOutcome: async () => {
    throw new Error('not sending in this test')
  },
}
const walletOver = (chain: SolanaSwapConnection): SolanaDexWallet => ({
  chain,
  ...noSend,
})

describe('dex configuration', () => {
  it('offers Orca on devnet and nothing on mainnet, from the enabled flags alone', () => {
    expect(getSolanaSwapVenues('solana-devnet').map(venue => venue.id)).toEqual(
      ['orca-whirlpools'],
    )
    expect(getSolanaSwapVenue('solana-devnet')?.adapter).toBe('orca-whirlpools')
    // Listed, quotable by tooling, but not offered: enabled is false.
    expect(
      listSolanaDexEntries('solana-mainnet').map(entry => [
        entry.id,
        entry.enabled,
      ]),
    ).toEqual([
      ['jupiter', false],
      ['orca-whirlpools', false],
    ])
    expect(getSolanaSwapVenues('solana-mainnet')).toEqual([])
    expect(getSolanaSwapVenue('solana-mainnet')).toBeUndefined()
    expect(getSolanaSwapVenue('solana-devnet', 'jupiter')).toBeUndefined()
    for (const unknown of ['solana', 'monad-testnet', 'toString']) {
      expect(getSolanaSwapVenues(unknown)).toEqual([])
    }
  })

  it('has the entry fields shared with the other chain families', () => {
    for (const chain of ['solana-devnet', 'solana-mainnet']) {
      for (const entry of listSolanaDexEntries(chain)) {
        expect(entry).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            adapter: expect.any(String),
            enabled: expect.any(Boolean),
            displayName: expect.any(String),
            maintainer: expect.any(String),
          }),
        )
        expect(entry.interfaceFee).toBeUndefined() // no fee anywhere today (#1375)
      }
    }
  })

  it('every exchange states the most a swap through it may pay in network fees', () => {
    for (const chain of ['solana-devnet', 'solana-mainnet']) {
      for (const entry of listSolanaDexEntries(chain)) {
        expect(Number.isSafeInteger(entry.maxNetworkFeeLamports)).toBe(true)
        // At least one signature's base fee, and well under a hundredth of a SOL.
        expect(entry.maxNetworkFeeLamports).toBeGreaterThanOrEqual(5000)
        expect(entry.maxNetworkFeeLamports).toBeLessThan(10_000_000)
      }
    }
    for (const bad of [0, -1, 1.5, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        validateSolanaSwapVenue({
          ...DEVNET,
          maxNetworkFeeLamports: bad as number,
        }),
      ).toThrow(/network fee/)
    }
  })

  it('lists only real tokens: AVU is a unit of account, never a swap side', () => {
    for (const chain of ['solana-devnet', 'solana-mainnet']) {
      for (const entry of listSolanaDexEntries(chain)) {
        for (const token of entry.tokens) {
          expect(token.symbol.toUpperCase()).not.toContain('AVU')
          expect(() => new PublicKey(token.mint)).not.toThrow()
        }
      }
    }
  })

  it('refuses an interface fee that is malformed or above one percent', () => {
    const withFee = (interfaceFee: { bps: number; recipient: string }) => () =>
      validateSolanaSwapVenue({ ...DEVNET, interfaceFee })
    const recipient = STRANGER.toBase58()
    expect(withFee({ bps: 100, recipient })).not.toThrow()
    expect(withFee({ bps: 101, recipient })).toThrow(/1\.\.100 basis points/)
    expect(withFee({ bps: 0, recipient })).toThrow(/basis points/)
    expect(withFee({ bps: 8.75, recipient })).toThrow(/basis points/)
    expect(withFee({ bps: 30, recipient: 'not-an-address' })).toThrow(
      /not an address/,
    )
  })
})

describe('amount arithmetic', () => {
  it('rounds the minimum output and the interface fee down', () => {
    expect(minimumOutput(111_100n, 50)).toBe(110_544n)
    expect(minimumOutput(1n, 50)).toBe(0n)
    expect(minimumOutput(10_000n, 0)).toBe(10_000n)
    expect(platformFeeAmount(5_000_000n, 100)).toBe(50_000n)
    expect(platformFeeAmount(99n, 100)).toBe(0n)
  })

  it('rounds the pool trade fee up, as the program does', () => {
    const pool = { feeRate: 2000 } as Parameters<typeof whirlpoolTradeFee>[0]
    expect(whirlpoolTradeFee(pool, 5_000_000n)).toBe(10_000n)
    expect(whirlpoolTradeFee(pool, 1n)).toBe(1n)
  })

  it('picks tick arrays in the direction of the swap, including below zero', () => {
    const pool = { tickCurrentIndex: -38050, tickSpacing: 64 }
    expect(swapTickArrayStartIndexes(pool, true)).toEqual([
      -39424, -45056, -50688,
    ])
    expect(swapTickArrayStartIndexes(pool, false)).toEqual([
      -39424, -33792, -28160,
    ])
    // Sitting on the last tick of an array, a price-raising swap starts in the next one.
    expect(
      swapTickArrayStartIndexes(
        { tickCurrentIndex: -33856, tickSpacing: 64 },
        false,
      ),
    ).toEqual([-33792, -28160, -22528])
  })
})

/** The recorded batch read whose first requested address is the given one. */
const recordedRead = (calls: RecordedCall[], first: string) =>
  calls.find(
    call =>
      call.method === 'getMultipleAccountsInfo' && call.args[0][0] === first,
  )!

describe('token accounts and pools', () => {
  const calls = orcaFixture.swaps.solToDevUsdc.calls as RecordedCall[]

  it('derives the same associated token account the chain uses', async () => {
    const address = await findAssociatedTokenAddress(
      OWNER,
      new PublicKey(DEV_USDC),
    )
    // The wallet's token accounts as the cluster itself listed them.
    const listed = calls
      .filter(call => call.method === 'getTokenAccountsByOwner')
      .flatMap(call => revive(call.result).value)
      .map((entry: { pubkey: PublicKey }) => entry.pubkey.toBase58())
    expect(listed).toContain(address.toBase58())
  })

  it('reads decimals from the mint and reports a missing token account as zero', async () => {
    const mints = revive(recordedRead(calls, NATIVE_SOL_MINT).result)
    const balances = await fetchSwapTokenBalances(
      {
        getBalance: async () => 1_500_000_000n,
        getMultipleAccountsInfo: async addresses =>
          addresses[0].toBase58() === NATIVE_SOL_MINT ? mints : [null, null],
      },
      OWNER,
      DEVNET.tokens.slice(0, 2),
    )
    expect(
      balances.map(b => [b.symbol, b.decimals, b.amount, b.native]),
    ).toEqual([
      ['SOL', 9, 1_500_000_000n, true],
      ['devUSDC', 6, 0n, false],
    ])
  })

  it('refuses a pool account the exchange program does not own', () => {
    const poolAccount = revive(recordedRead(calls, DEVNET.pools[0]).result)[0]
    const address = new PublicKey(DEVNET.pools[0])
    const pool = decodeWhirlpool(
      address,
      new PublicKey(DEVNET.programId),
      poolAccount,
    )
    expect(pool.tokenMintA.toBase58()).toBe(NATIVE_SOL_MINT)
    expect(pool.tokenMintB.toBase58()).toBe(DEV_USDC)
    expect(pool.feeRate).toBe(2000)
    expect(() =>
      decodeWhirlpool(address, TOKEN_PROGRAM_ID, poolAccount),
    ).toThrow(/not an Orca Whirlpool/)
  })
})

describe('Orca devnet quote (recorded devnet responses)', () => {
  const { solToDevUsdc, devUsdcToSol } = orcaFixture.swaps
  const orca = (
    calls: RecordedCall[],
    entry: OrcaWhirlpoolsVenue = DEVNET,
    edit?: (method: string, result: any) => any,
  ) =>
    createSolanaDex('solana-devnet', entry, walletOver(replay(calls, edit)), {
      now: () => 42,
    })
  const request = (swap: typeof solToDevUsdc) => ({
    owner: OWNER,
    inputMint: swap.request.inputMint,
    outputMint: swap.request.outputMint,
    amount: BigInt(swap.request.amount),
    slippageBps: swap.request.slippageBps,
  })

  it('takes the expected output from the simulated swap and enforces the minimum', async () => {
    const quote = await orca(solToDevUsdc.calls).quote(request(solToDevUsdc))
    expect(quote.venueId).toBe('orca-whirlpools')
    const expected = BigInt(solToDevUsdc.expected.expectedOutputAmount)
    expect(expected).toBeGreaterThan(100_000n) // about 22 devUSDC per SOL, for 0.005 SOL
    expect(quote.expectedOutputAmount).toBe(expected)
    expect(quote.minOutputAmount).toBe(minimumOutput(expected, 50))
    expect(quote.tradeFee).toEqual({ amount: 10_000n, mint: NATIVE_SOL_MINT })
    expect(quote.platformFee).toBeUndefined()
    expect(quote.networkFeeLamports).toBe(5000n)
    expect(quote.priorityFeeLamports).toBe(0n)
    expect(quote.accountRentLamports).toBe(0n)
    expect(quote.temporaryRentLamports).toBe(
      BigInt(solToDevUsdc.expected.temporaryRentLamports),
    )
    expect(quote.priceImpactBps).toBeLessThan(1)
    expect(quote.fetchedAt).toBe(42)
    expect(quote.blocker).toBeUndefined()
    expect(toBase64(quote.transaction.serialize())).toBe(
      solToDevUsdc.expected.transaction,
    )

    // open output account; create + initialise a temporary wrapped-SOL account; swap; close it.
    // No instruction touches the wallet's own wrapped-SOL account, and none is about a fee.
    const message = quote.transaction.message
    const programs = message.compiledInstructions.map(ix =>
      message.staticAccountKeys[ix.programIdIndex].toBase58(),
    )
    expect(programs).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      DEVNET.programId,
      TOKEN_PROGRAM_ID.toBase58(),
    ])
    const ownWrappedSol = await findAssociatedTokenAddress(
      OWNER,
      new PublicKey(NATIVE_SOL_MINT),
    )
    expect(
      message.staticAccountKeys.some(key => key.equals(ownWrappedSol)),
    ).toBe(false)
    const swapData = Buffer.from(message.compiledInstructions[3].data)
    expect(swapData.readBigUInt64LE(8)).toBe(5_000_000n)
    expect(swapData.readBigUInt64LE(16)).toBe(minimumOutput(expected, 50))
    expect(message.header.numRequiredSignatures).toBe(1)
    expect(message.staticAccountKeys[0].equals(OWNER)).toBe(true)
  })

  /** The recorded chain, counting calls; reads no recording has are answered from what it holds. */
  function counted(calls: RecordedCall[]) {
    const made: string[] = []
    const held = new Map<string, any>()
    for (const call of calls) {
      if (call.method === 'getMultipleAccountsInfo') {
        call.args[0].forEach((address: string, i: number) =>
          held.set(address, call.result[i]),
        )
      } else if (call.method === 'getTokenAccountsByOwner') {
        for (const entry of call.result.value) {
          held.set(entry.pubkey.$pubkey, entry.account)
        }
      }
    }
    const recorded = replay(calls)
    const chain = new Proxy(recorded, {
      get:
        (target, method: keyof SolanaSwapConnection) =>
        async (...args: any[]) => {
          made.push(method)
          try {
            return await (target[method] as any)(...args)
          } catch (error) {
            if (method !== 'getMultipleAccountsInfo') throw error
            return (args[0] as PublicKey[]).map(address =>
              revive(held.get(address.toBase58()) ?? null),
            )
          }
        },
    })
    return { chain, made }
  }

  it("simulates once for a quote, and lists the wallet's token accounts once for a run of quotes", async () => {
    const first = counted(solToDevUsdc.calls)
    const cycle = {}
    const quote = await createSolanaDex(
      'solana-devnet',
      DEVNET,
      walletOver(first.chain),
    ).quote(request(solToDevUsdc), cycle)
    const count = (made: string[], method: string) =>
      made.filter(name => name === method).length
    // The simulation that finds the expected output is the quote's check; the transaction
    // with the minimum in it is simulated when it is about to be signed.
    expect(count(first.made, 'simulateTransaction')).toBe(1)
    expect(count(first.made, 'getTokenAccountsByOwner')).toBe(2)
    expect(first.made).toHaveLength(10)

    // The next quote of the same run: no listing, and the accounts found by the first are
    // read again (their balances are not remembered) in the one read of the wallet's accounts.
    const second = counted(solToDevUsdc.calls)
    const again = await createSolanaDex(
      'solana-devnet',
      DEVNET,
      walletOver(second.chain),
    ).quote(request(solToDevUsdc), cycle)
    expect(count(second.made, 'getTokenAccountsByOwner')).toBe(0)
    expect(count(second.made, 'simulateTransaction')).toBe(1)
    expect(second.made).toHaveLength(8)
    expect(again.expectedOutputAmount).toBe(quote.expectedOutputAmount)
    expect(again.check.walletAccounts.map(a => a.address.toBase58())).toEqual(
      quote.check.walletAccounts.map(a => a.address.toBase58()),
    )
    expect(again.check.walletAccounts.map(a => a.state.amount)).toEqual(
      quote.check.walletAccounts.map(a => a.state.amount),
    )

    // A run for another wallet starts over.
    const other = counted(solToDevUsdc.calls)
    await createSolanaDex('solana-devnet', DEVNET, walletOver(other.chain))
      .quote({ ...request(solToDevUsdc), owner: STRANGER }, cycle)
      .catch(() => undefined)
    expect(other.made).toContain('getTokenAccountsByOwner')
  })

  it('quotes selling a token for SOL, counting what arrives after the fee', async () => {
    const quote = await orca(devUsdcToSol.calls).quote(request(devUsdcToSol))
    expect(quote.expectedOutputAmount).toBe(
      BigInt(devUsdcToSol.expected.expectedOutputAmount),
    )
    expect(quote.minOutputAmount).toBe(
      BigInt(devUsdcToSol.expected.minOutputAmount),
    )
    expect(quote.accountRentLamports).toBe(0n)
    expect(toBase64(quote.transaction.serialize())).toBe(
      devUsdcToSol.expected.transaction,
    )
  })

  it('gives no quote when the network does not state the fee, rather than showing a fee of zero', async () => {
    await expect(
      orca(solToDevUsdc.calls, DEVNET, (method, result) =>
        method === 'getFeeForMessage' ? { ...result, value: null } : result,
      ).quote(request(solToDevUsdc)),
    ).rejects.toMatchObject({
      code: 'simulation-failed',
      detail: expect.stringMatching(/did not state the fee/),
    })
  })

  it('does not quote an amount the wallet does not hold', async () => {
    await expect(
      orca(solToDevUsdc.calls).quote({
        ...request(solToDevUsdc),
        amount: 10n ** 15n,
      }),
    ).rejects.toMatchObject({ code: 'insufficient-balance' })
  })

  it('a pool that fails verification disables only its own pair', async () => {
    // The first configured "pool" is not a pool at all (it is a token mint); the real
    // SOL/devUSDC pool is listed after it and must still be found and quoted.
    const entry = { ...DEVNET, pools: [DEV_USDC, DEVNET.pools[0]] }
    const poolsRead = recordedRead(solToDevUsdc.calls, DEVNET.pools[0])
    const mintAccount = recordedRead(solToDevUsdc.calls, NATIVE_SOL_MINT)
      .result[1]
    const calls = solToDevUsdc.calls.map(call =>
      call === poolsRead
        ? {
            ...call,
            args: [entry.pools],
            result: [mintAccount, call.result[0]],
          }
        : call,
    )
    const quote = await orca(calls, entry).quote(request(solToDevUsdc))
    expect(quote.expectedOutputAmount).toBe(
      BigInt(solToDevUsdc.expected.expectedOutputAmount),
    )
    // With only the bad entry configured, the pair simply has no market.
    await expect(
      orca(
        solToDevUsdc.calls.map(call =>
          call === poolsRead
            ? { ...call, args: [[DEV_USDC]], result: [mintAccount] }
            : call,
        ),
        { ...DEVNET, pools: [DEV_USDC] },
      ).quote(request(solToDevUsdc)),
    ).rejects.toMatchObject({ code: 'no-route' })
  })

  it('says so when no pool trades the pair, and rejects nonsense before the network', async () => {
    const dex = orca([])
    for (const bad of [
      { amount: 0n },
      { outputMint: NATIVE_SOL_MINT },
      { slippageBps: 5001 },
      { slippageBps: 0.5 },
    ]) {
      await expect(
        dex.quote({ ...request(solToDevUsdc), ...bad }),
      ).rejects.toMatchObject({ code: 'invalid-request' })
    }
  })

  it('refuses a dust swap whose minimum would round to nothing', async () => {
    // The pool answers "1 base unit": half a percent off that is zero.
    const before = solToDevUsdc.calls
      .filter(call => call.method === 'getTokenAccountsByOwner')
      .flatMap(call => revive(call.result).value)
      .map((entry: any) => Buffer.from(entry.account.data))
      .find(
        (data: Buffer) =>
          new PublicKey(data.subarray(0, 32)).toBase58() === DEV_USDC,
      )!
      .readBigUInt64LE(64)
    const dust = (method: string, result: any) => {
      if (method !== 'simulateTransaction') return result
      // Simulated accounts are: the wallet, the output token account, then the rest.
      const accounts = [...result.value.accounts]
      const data = Buffer.from(fromBase64(accounts[1].data[0]))
      data.writeBigUInt64LE(before + 1n, 64)
      accounts[1] = { ...accounts[1], data: [toBase64(data), 'base64'] }
      // The same account is listed again among the wallet's token accounts.
      for (let i = 2; i < accounts.length; i++) {
        if (accounts[i]?.data[0] === result.value.accounts[1].data[0]) {
          accounts[i] = accounts[1]
        }
      }
      return { ...result, value: { ...result.value, accounts } }
    }
    await expect(
      orca(solToDevUsdc.calls, DEVNET, dust).quote(request(solToDevUsdc)),
    ).rejects.toMatchObject({ code: 'invalid-request' })
  })
})

describe('the safety check on what a transaction would do (recorded simulations, altered)', () => {
  const { devUsdcToSol, solToDevUsdc } = orcaFixture.swaps
  const quoteWith = (
    swap: typeof devUsdcToSol,
    alter: (accounts: any[]) => void,
  ) => {
    return createSolanaDex(
      'solana-devnet',
      DEVNET,
      walletOver(
        replay(swap.calls, (method, result) => {
          if (method !== 'simulateTransaction') return result
          const accounts = result.value.accounts.map((account: any) =>
            account ? { ...account, data: [...account.data] } : account,
          )
          alter(accounts)
          return { ...result, value: { ...result.value, accounts } }
        }),
      ),
    ).quote({
      owner: OWNER,
      inputMint: swap.request.inputMint,
      outputMint: swap.request.outputMint,
      amount: BigInt(swap.request.amount),
      slippageBps: 50,
    })
  }
  /** Rewrites one simulated token account's bytes. */
  const patch = (account: any, edit: (data: Buffer) => void) => {
    const data = Buffer.from(fromBase64(account.data[0]))
    edit(data)
    account.data = [toBase64(data), 'base64']
  }
  /** Index, in the simulated accounts, of the wallet's token account for a mint. */
  const indexOfMint = (accounts: any[], mint: string) =>
    accounts.findIndex(
      (account, i) =>
        i > 0 &&
        account &&
        account.owner === TOKEN_PROGRAM_ID.toBase58() &&
        new PublicKey(fromBase64(account.data[0]).slice(0, 32)).toBase58() ===
          mint,
    )

  it('passes the genuine simulation', async () => {
    await expect(
      quoteWith(devUsdcToSol, () => undefined),
    ).resolves.toMatchObject({
      expectedOutputAmount: BigInt(devUsdcToSol.expected.expectedOutputAmount),
    })
  })

  it('refuses a larger debit of the input token than agreed', async () => {
    await expect(
      quoteWith(devUsdcToSol, accounts =>
        patch(accounts[indexOfMint(accounts, DEV_USDC)], data =>
          data.writeBigUInt64LE(data.readBigUInt64LE(64) - 1n, 64),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/debits more of the input token/),
    })
  })

  it('refuses a transaction that leaves a delegate on a token account', async () => {
    await expect(
      quoteWith(devUsdcToSol, accounts =>
        patch(accounts[indexOfMint(accounts, DEV_USDC)], data => {
          data.writeUInt32LE(1, 72)
          Buffer.from(STRANGER.toBytes()).copy(data, 76)
        }),
      ),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/who may spend from or close/),
    })
  })

  it('refuses a transaction that hands a token account to someone else', async () => {
    await expect(
      quoteWith(devUsdcToSol, accounts =>
        patch(accounts[indexOfMint(accounts, DEV_USDC)], data =>
          Buffer.from(STRANGER.toBytes()).copy(data, 32),
        ),
      ),
    ).rejects.toMatchObject({ code: 'unsafe-transaction' })
  })

  it('refuses a transaction that moves a token that is not part of the swap', async () => {
    const other = DEVNET.tokens[2].mint // devUSDT, which the recorded wallet holds
    await expect(
      quoteWith(devUsdcToSol, accounts =>
        patch(accounts[indexOfMint(accounts, other)], data =>
          data.writeBigUInt64LE(data.readBigUInt64LE(64) - 1n, 64),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/not part of the swap/),
    })
  })

  it('refuses a transaction that takes extra SOL', async () => {
    const takeSol = (lamports: bigint) => (accounts: any[]) => {
      accounts[0] = {
        ...accounts[0],
        lamports: BigInt(accounts[0].lamports) - lamports,
      }
    }
    await expect(
      quoteWith(solToDevUsdc, takeSol(1_000_000n)),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/more SOL than the swap needs/),
    })
    // "Less than the minimum" is decided when the transaction that carries the minimum is
    // simulated, which is at signing (see the wallet's legacy send below).
  })

  it('refuses a transaction that changes who controls the wallet account', async () => {
    await expect(
      quoteWith(devUsdcToSol, accounts => {
        accounts[0] = { ...accounts[0], owner: TOKEN_PROGRAM_ID.toBase58() }
      }),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/controls the wallet/),
    })
  })
})

/**
 * A wallet described by hand, for the cases no recording has: paying SOL for devUSDC, holding
 * its devUSDC account (the swap's output) and a second devUSDC account that is not.
 */
describe('the safety check on a wallet described by hand', () => {
  const mint = new PublicKey(DEV_USDC)
  const outputAccount = new PublicKey(DEVNET.pools[1])
  const secondAccount = new PublicKey(DEVNET.pools[2])
  const RENT = 2_039_280n
  const tokenAccount = (amount: bigint) => ({
    mint,
    owner: OWNER,
    amount,
    delegate: null,
    closeAuthority: null,
  })
  const check: SwapCheck = {
    owner: OWNER,
    state: {
      lamports: 1_000_000_000n,
      input: {
        mint: new PublicKey(NATIVE_SOL_MINT),
        native: true,
        decimals: 9,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenAccount: STRANGER,
        tokenAccountLamports: 0n,
        account: undefined,
      },
      output: {
        mint,
        native: false,
        decimals: 6,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenAccount: outputAccount,
        tokenAccountLamports: RENT,
        account: tokenAccount(100n),
      },
    },
    inputAmount: 10_000_000n,
    minOutputAmount: 200n,
    networkFeeLamports: 5000n,
    walletAccounts: [
      { address: outputAccount, state: tokenAccount(100n) },
      { address: secondAccount, state: tokenAccount(500n) },
    ],
  }
  const simulatedToken = (amount: bigint) => {
    const data = Buffer.alloc(165)
    Buffer.from(mint.toBytes()).copy(data, 0)
    Buffer.from(OWNER.toBytes()).copy(data, 32)
    data.writeBigUInt64LE(amount, 64)
    return {
      lamports: RENT,
      owner: TOKEN_PROGRAM_ID.toBase58(),
      data: [toBase64(data), 'base64'],
    }
  }
  /** A chain whose simulation ends with these balances. */
  const chain = (after: {
    lamports?: bigint
    output?: bigint
    second?: bigint
    fee?: bigint | null
    preLamports?: bigint
  }) =>
    ({
      simulateTransaction: async () => ({
        value: {
          err: null,
          logs: [],
          fee: after.fee === undefined ? 5000n : after.fee,
          ...(after.preLamports === undefined
            ? {}
            : { preBalances: [after.preLamports] }),
          accounts: [
            {
              lamports: after.lamports ?? 1_000_000_000n - 10_000_000n - 5000n,
              owner: SystemProgram.programId.toBase58(),
              data: ['', 'base64'],
            },
            simulatedToken(after.output ?? 322n),
            simulatedToken(after.output ?? 322n),
            simulatedToken(after.second ?? 500n),
          ],
        },
      }),
    } as unknown as SolanaSwapConnection)
  const run = (
    after: Parameters<typeof chain>[0],
    overrides: Partial<SwapCheck> = {},
  ) =>
    simulateAndCheckSwap(chain(after), {} as VersionedTransaction, {
      ...check,
      ...overrides,
    })

  it('passes the swap as agreed', async () => {
    await expect(run({})).resolves.toEqual({
      outputAmount: 222n,
      accountRentLamports: 0n,
    })
  })

  it('allows the reviewed network fee and no more, whatever fee the transaction carries', async () => {
    const paid = 1_000_000_000n - 10_000_000n
    // The simulation charged 50 000 lamports where 5 000 were reviewed.
    await expect(
      run({ lamports: paid - 50_000n, fee: 50_000n }),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/network fee/),
    })
    // A network that does not state the simulated fee: the reviewed fee is the allowance.
    await expect(
      run({ lamports: paid - 5000n, fee: null }),
    ).resolves.toMatchObject({ outputAmount: 222n })
    await expect(
      run({ lamports: paid - 50_000n, fee: null }),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/more SOL than the swap needs/),
    })
  })

  it("refuses a transaction that takes from another of the wallet's accounts of the output token", async () => {
    // 300 leave the second account while 222 arrive in the output account.
    await expect(run({ second: 200n })).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/not part of the swap/),
    })
  })
})

describe('Jupiter quote (recorded API and mainnet responses)', () => {
  const request = {
    owner: OWNER,
    inputMint: NATIVE_SOL_MINT,
    outputMint: USDC,
    amount: 10_000_000n,
    slippageBps: 50,
  }
  const api = jupiterFixture.http[0].response as any
  const built = jupiterFixture.http[1].response as any

  function replayFetch(edit?: (body: any) => any) {
    const queue = [...jupiterFixture.http]
    const requests: { url: string; body?: any }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const call = queue.shift()!
      requests.push({
        url,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      })
      const body = JSON.parse(JSON.stringify(call.response))
      return new Response(JSON.stringify(edit ? edit(body) : body), {
        status: call.status,
      })
    }) as unknown as typeof fetch
    return { fetchImpl, requests }
  }
  const quoteWith = (
    edit?: (body: any) => any,
    entry: JupiterVenue = JUPITER,
  ) => {
    const { fetchImpl, requests } = replayFetch(edit)
    const quote = createSolanaDex(
      'solana-mainnet',
      entry,
      walletOver(replay(jupiterFixture.calls)),
      { fetch: fetchImpl },
    ).quote(request)
    return Object.assign(quote, { requests })
  }

  /** Jupiter's recorded transaction with one more instruction appended. */
  function withExtraInstruction(extra: TransactionInstruction): string {
    const original = VersionedTransaction.deserialize(
      fromBase64(built.swapTransaction),
    )
    const tableKey = (original.message as any).addressTableLookups[0]
      .accountKey as PublicKey
    const tableAccount = revive(
      recordedRead(jupiterFixture.calls, tableKey.toBase58()).result,
    )[0]
    const tables = [
      new AddressLookupTableAccount({
        key: tableKey,
        state: AddressLookupTableAccount.deserialize(tableAccount.data),
      }),
    ]
    const message = TransactionMessage.decompile(original.message, {
      addressLookupTableAccounts: tables,
    })
    message.instructions.push(extra)
    return toBase64(
      new VersionedTransaction(message.compileToV0Message(tables)).serialize(),
    )
  }
  const tampered = (swapTransaction: string) => (body: any) =>
    'swapTransaction' in body ? { ...body, swapTransaction } : body

  it("accepts Jupiter's real transaction, and reports that this wallet cannot pay for it", async () => {
    const pending = quoteWith()
    const quote = await pending
    expect(quote.venueName).toBe('Jupiter')
    expect(quote.expectedOutputAmount).toBe(BigInt(api.outAmount))
    expect(quote.minOutputAmount).toBe(BigInt(api.otherAmountThreshold))
    expect(quote.route.map(hop => hop.label)).toEqual(
      api.routePlan.map((hop: any) => hop.swapInfo.label),
    )
    expect(toBase64(quote.transaction.serialize())).toBe(built.swapTransaction)
    expect(quote.platformFee).toBeUndefined()
    // The recorded wallet holds no mainnet SOL: the quote is real, carrying it out is not possible.
    expect(quote.blocker).toMatchObject({ code: 'insufficient-sol' })
    // No fee was asked for.
    expect(pending.requests[0].url).not.toMatch(/platformFee/i)
    expect(pending.requests[1].body.feeAccount).toBeUndefined()
  })

  it('decides when the transaction expires from the chain, not from the API', async () => {
    const tip = revive(
      jupiterFixture.calls.find(call => call.method === 'getBlockHeight')!
        .result,
    ) as bigint
    // Whatever the API claims, even "already expired".
    const quote = await quoteWith(body =>
      'lastValidBlockHeight' in body
        ? { ...body, lastValidBlockHeight: 1 }
        : body,
    )
    expect(quote.lastValidBlockHeight).toBe(BigInt(tip) + 300n)
  })

  it('refuses a quote that is for a different swap', async () => {
    await expect(
      quoteWith(body =>
        'inAmount' in body ? { ...body, inAmount: '1' } : body,
      ),
    ).rejects.toMatchObject({ code: 'venue-unavailable' })
  })

  it('refuses a fee nobody configured, and accepts exactly the configured one', async () => {
    const withFee = (feeBps: number) => (body: any) =>
      'inAmount' in body
        ? { ...body, platformFee: { amount: '3293', feeBps } }
        : body
    await expect(quoteWith(withFee(30))).rejects.toMatchObject({
      code: 'venue-unavailable',
    })
    const entry = {
      ...JUPITER,
      interfaceFee: { bps: 30, recipient: STRANGER.toBase58() },
    }
    // A different rate than configured is refused.
    await expect(quoteWith(withFee(31), entry)).rejects.toMatchObject({
      code: 'venue-unavailable',
    })
    // The configured rate gets as far as reading Jupiter's transaction, which (recorded with
    // no fee) does not carry it: the swap instruction's own fee field must match too.
    const pending = quoteWith(withFee(30), entry)
    await expect(pending).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/quoted amounts and slippage/),
    })
    expect(pending.requests[0].url).toMatch(/platformFeeBps=30/)
    expect(pending.requests[1].body.feeAccount).toBe(
      (
        await findAssociatedTokenAddress(STRANGER, new PublicKey(USDC))
      ).toBase58(),
    )
  })

  it('refuses a minimum of zero, or looser than the chosen slippage', async () => {
    const threshold = (value: string) => (body: any) =>
      'otherAmountThreshold' in body
        ? { ...body, otherAmountThreshold: value }
        : body
    await expect(quoteWith(threshold('0'))).rejects.toMatchObject({
      code: 'invalid-request',
    })
    await expect(
      quoteWith(threshold((BigInt(api.outAmount) / 2n).toString())),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/looser than the chosen slippage/),
    })
  })

  it('refuses a transaction with an extra transfer', async () => {
    await expect(
      quoteWith(
        tampered(
          withExtraInstruction(
            SystemProgram.transfer({
              fromPubkey: OWNER,
              toPubkey: STRANGER,
              lamports: 1_000n,
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/moves SOL somewhere other than/),
    })
  })

  it('refuses a transaction with an Approve', async () => {
    const usdcAccount = await findAssociatedTokenAddress(
      OWNER,
      new PublicKey(USDC),
    )
    const approve = new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: usdcAccount, isSigner: false, isWritable: true },
        { pubkey: STRANGER, isSigner: false, isWritable: false },
        { pubkey: OWNER, isSigner: true, isWritable: false },
      ],
      data: Uint8Array.of(4, 255, 255, 255, 255, 255, 255, 255, 255),
    })
    await expect(
      quoteWith(tampered(withExtraInstruction(approve))),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/token instruction that is not part/),
    })
  })

  it('refuses a transaction whose swap takes more input, or enforces a looser minimum, than quoted', async () => {
    const original = VersionedTransaction.deserialize(
      fromBase64(built.swapTransaction),
    )
    const message = original.message as any
    const swap = message.compiledInstructions.find(
      (ix: any) =>
        message.staticAccountKeys[ix.programIdIndex]?.toBase58() ===
        JUPITER.programId,
    )
    const tail = swap.data.length - 19
    for (const [offset, write] of [
      [
        tail,
        (data: Buffer, at: number) => data.writeBigUInt64LE(20_000_000n, at),
      ],
      [tail + 16, (data: Buffer, at: number) => data.writeUInt16LE(5000, at)],
    ] as const) {
      const data = Buffer.from(swap.data)
      write(data, offset)
      const copy = VersionedTransaction.deserialize(
        fromBase64(built.swapTransaction),
      )
      const copySwap = (copy.message as any).compiledInstructions.find(
        (ix: any) => ix.programIdIndex === swap.programIdIndex,
      )
      copySwap.data = Uint8Array.from(data)
      await expect(
        quoteWith(tampered(toBase64(copy.serialize()))),
      ).rejects.toMatchObject({
        code: 'unsafe-transaction',
        detail: expect.stringMatching(/quoted amounts and slippage/),
      })
    }
  })

  /** Jupiter's recorded transaction with the data of its n-th compute-budget instruction replaced. */
  function withComputeBudget(index: number, data: Uint8Array): string {
    const copy = VersionedTransaction.deserialize(
      fromBase64(built.swapTransaction),
    )
    const message = copy.message as any
    const budget = message.compiledInstructions.filter(
      (ix: any) =>
        message.staticAccountKeys[ix.programIdIndex]?.toBase58() ===
        'ComputeBudget111111111111111111111111111111',
    )
    budget[index].data = data
    return toBase64(copy.serialize())
  }
  const u64 = (tag: number, value: bigint) => {
    const data = Buffer.alloc(9)
    data.writeUInt8(tag, 0)
    data.writeBigUInt64LE(value, 1)
    return Uint8Array.from(data)
  }

  it('shows the priority fee Jupiter set, separately, and asks Jupiter to keep it under the limit', async () => {
    const pending = quoteWith()
    const quote = await pending
    // As recorded: 1 400 000 compute units at 71 428 micro-lamports each, rounded up.
    expect(quote.priorityFeeLamports).toBe(100_000n)
    expect(quote.networkFeeLamports).toBe(105_000n)
    expect(pending.requests[1].body.prioritizationFeeLamports).toEqual({
      priorityLevelWithMaxLamports: {
        maxLamports: JUPITER.maxNetworkFeeLamports - 5000,
        priorityLevel: 'high',
      },
    })
  })

  it('refuses a transaction whose priority fee would burn more than the exchange entry allows', async () => {
    // The same swap with the compute-unit price raised a thousandfold: 100 SOL in fees.
    await expect(
      quoteWith(tampered(withComputeBudget(1, u64(3, 71_428_000n)))),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/network fee/),
    })
    // The limit is the entry's: the recorded 105 000 lamports is too much for a lower one.
    await expect(
      quoteWith(undefined, { ...JUPITER, maxNetworkFeeLamports: 104_999 }),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/network fee/),
    })
    // The old instruction that names an extra fee outright is not accepted at all.
    const deprecated = Buffer.alloc(9)
    deprecated.writeUInt32LE(200_000, 1)
    deprecated.writeUInt32LE(1_000_000_000, 5)
    await expect(
      quoteWith(tampered(withComputeBudget(0, Uint8Array.from(deprecated)))),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/compute-budget instruction/),
    })
  })

  it('gives no Jupiter quote when the network does not state the fee', async () => {
    const { fetchImpl } = replayFetch()
    await expect(
      createSolanaDex(
        'solana-mainnet',
        JUPITER,
        walletOver(
          replay(jupiterFixture.calls, (method, result) =>
            method === 'getFeeForMessage' ? { ...result, value: null } : result,
          ),
        ),
        { fetch: fetchImpl },
      ).quote(request),
    ).rejects.toMatchObject({ code: 'simulation-failed' })
  })

  it("refuses a swap instruction that pays the output anywhere but this wallet's own token account", async () => {
    /** Jupiter's recorded transaction with one account of its swap instruction replaced. */
    const withSwapAccount = (position: number, keyIndex: number) => {
      const copy = VersionedTransaction.deserialize(
        fromBase64(built.swapTransaction),
      )
      const message = copy.message as any
      const swap = message.compiledInstructions.find(
        (ix: any) =>
          message.staticAccountKeys[ix.programIdIndex]?.toBase58() ===
          JUPITER.programId,
      )
      swap.accountKeyIndexes[position] = keyIndex
      return toBase64(copy.serialize())
    }
    const original = VersionedTransaction.deserialize(
      fromBase64(built.swapTransaction),
    ).message
    const usdcAccount = await findAssociatedTokenAddress(
      OWNER,
      new PublicKey(USDC),
    )
    const swap = original.compiledInstructions.find(
      ix =>
        original.staticAccountKeys[ix.programIdIndex]?.toBase58() ===
        JUPITER.programId,
    )!
    // As recorded: the destination is the wallet's own USDC account, and no other is named.
    expect(
      original.staticAccountKeys[swap.accountKeyIndexes[3]].equals(usdcAccount),
    ).toBe(true)
    const someoneElses = original.staticAccountKeys.findIndex(
      key => key.toBase58() === '3saT3dWGVR4nwfCZY5TB4ABoFMhsccKADt24MwyAN5yZ',
    )
    for (const tamperedTransaction of [
      // The destination token account itself.
      withSwapAccount(3, someoneElses),
      // Jupiter's optional "send the output here instead" account.
      withSwapAccount(4, someoneElses),
      // The mint the destination is for.
      withSwapAccount(5, someoneElses),
    ]) {
      await expect(
        quoteWith(tampered(tamperedTransaction)),
      ).rejects.toMatchObject({
        code: 'unsafe-transaction',
        detail: expect.stringMatching(
          /output .* this wallet's own token account/,
        ),
      })
    }
    // A Jupiter instruction whose layout this wallet does not know is not guessed at.
    const unknown = VersionedTransaction.deserialize(
      fromBase64(built.swapTransaction),
    )
    const unknownSwap = (unknown.message as any).compiledInstructions.find(
      (ix: any) => ix.programIdIndex === swap.programIdIndex,
    )
    unknownSwap.data = Uint8Array.from(unknownSwap.data)
    unknownSwap.data.set([187, 100, 250, 204, 49, 196, 175, 20], 0) // route_v2
    await expect(
      quoteWith(tampered(toBase64(unknown.serialize()))),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/kind of swap instruction/),
    })
  })

  it('refuses a transaction that needs anyone else to pay or sign', async () => {
    const other = (await Keypair.generate()).publicKey
    const foreign = new VersionedTransaction(
      new TransactionMessage({
        payerKey: other,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: other,
            toPubkey: OWNER,
            lamports: 1n,
          }),
        ],
      }).compileToV0Message(),
    )
    await expect(
      quoteWith(tampered(toBase64(foreign.serialize()))),
    ).rejects.toMatchObject({ code: 'unsafe-transaction' })
  })

  it('reports an API outage as the exchange being unavailable', async () => {
    await expect(
      createSolanaDex(
        'solana-mainnet',
        JUPITER,
        walletOver(replay(jupiterFixture.calls)),
        {
          fetch: (async () =>
            new Response('<html>503</html>', {
              status: 503,
            })) as typeof fetch,
        },
      ).quote(request),
    ).rejects.toMatchObject({ code: 'venue-unavailable' })
  })
})

describe('what a confirmed swap did (real confirmed devnet swaps)', () => {
  const tx = confirmedSwaps.transactions
  const owner = OWNER.toBase58()

  it('SOL for a token, opening the token account', () => {
    expect(
      observeSwapTransaction(
        tx.solToDevUsdcCreatingTokenAccount.meta as SwapTransactionMeta,
        owner,
        NATIVE_SOL_MINT,
        DEV_USDC,
      ),
    ).toEqual({
      receivedAmount: 222_201n,
      spentAmount: 10_000_000n,
      networkFeeLamports: 5000n,
      accountRentLamports: 1_488_440n,
    })
  })

  it('a token for SOL: what arrived, without the fee', () => {
    expect(
      observeSwapTransaction(
        tx.devUsdcToSol.meta as SwapTransactionMeta,
        owner,
        DEV_USDC,
        NATIVE_SOL_MINT,
      ),
    ).toEqual({
      receivedAmount: 9_959_977n,
      spentAmount: 222_201n,
      networkFeeLamports: 5000n,
      accountRentLamports: 0n,
    })
  })
})

describe('a recorded swap is shown as mine only if the chain agrees', () => {
  const meta = confirmedSwaps.transactions.solToDevUsdcCreatingTokenAccount
    .meta as SwapTransactionMeta
  const claim = {
    txHash: 'sig',
    account: OWNER.toBase58(),
    assetIn: {},
    assetOut: { address: DEV_USDC },
  }
  const chainWith = (
    found: {
      payer?: PublicKey
      program?: string
      meta?: SwapTransactionMeta | null
    } | null,
  ) => ({
    getTransaction: async () =>
      found === null
        ? null
        : {
            meta: found.meta === undefined ? meta : found.meta,
            transaction: {
              message: {
                staticAccountKeys: [
                  found.payer ?? OWNER,
                  new PublicKey(found.program ?? DEVNET.programId),
                ],
                compiledInstructions: [{ programIdIndex: 1 }],
              },
            },
          },
  })

  it('reads what it did from the finalized transaction', async () => {
    await expect(
      observeSolanaSwapRecord(chainWith({}), claim, DEVNET.programId),
    ).resolves.toEqual({
      status: 'confirmed',
      receivedAmount: 222_201n,
      spentAmount: 10_000_000n,
      networkFeeLamports: 5000n,
      accountRentLamports: 1_488_440n,
    })
    await expect(
      observeSolanaSwapRecord(
        chainWith({ meta: { ...meta, err: { InstructionError: [3, 'x'] } } }),
        claim,
        DEVNET.programId,
      ),
    ).resolves.toEqual({ status: 'failed', networkFeeLamports: 5000n })
  })

  it("disowns a record whose transaction another account paid for, or that is not the exchange's", async () => {
    await expect(
      observeSolanaSwapRecord(
        chainWith({ payer: STRANGER }),
        claim,
        DEVNET.programId,
      ),
    ).rejects.toBeInstanceOf(SolanaSwapRecordMismatchError)
    await expect(
      observeSolanaSwapRecord(
        chainWith({ program: TOKEN_PROGRAM_ID.toBase58() }),
        claim,
        DEVNET.programId,
      ),
    ).rejects.toBeInstanceOf(SolanaSwapRecordMismatchError)
  })

  it('a transaction the chain does not show yet, or a failing read, decides nothing', async () => {
    await expect(
      observeSolanaSwapRecord(chainWith(null), claim, DEVNET.programId),
    ).resolves.toEqual({ status: 'unknown' })
    await expect(
      observeSolanaSwapRecord(
        {
          getTransaction: async () => {
            throw new Error('rpc down')
          },
        },
        claim,
        DEVNET.programId,
      ),
    ).rejects.toThrow('rpc down')
  })
})

describe("the wallet's legacy send: record, send, follow", () => {
  const record: SolanaSwapRecord = {
    chainIdentifier: 'solana-devnet',
    venueId: 'orca-whirlpools',
    venueName: 'Orca Whirlpools (devnet)',
    route: 'Orca Whirlpool',
    transactionId: 'sig',
    account: OWNER.toBase58(),
    assetIn: { symbol: 'SOL', address: null, decimals: 9 },
    amountIn: '10000000',
    assetOut: { symbol: 'devUSDC', address: DEV_USDC, decimals: 6 },
    quotedAmountOut: '222201',
    minimumAmountOut: '221089',
    interfaceFeeAmount: '0',
    networkFeeLamports: '5000',
    priorityFeeLamports: '0',
    signedAtMs: 1,
    recovery: {
      signedTransaction: toBase64(Uint8Array.of(1, 2, 3)),
      lastValidBlockHeight: '100',
    },
  }
  const {
    transactionId: _id,
    signedAtMs: _at,
    recovery: _r,
    ...intent
  } = record
  void [_id, _at, _r]

  function memoryJournal(initial: SolanaSwapRecord[] = []) {
    let entries: SolanaLegacyJournalEntry[] = initial.map(entry => ({
      record: entry,
    }))
    const settled: [string, string][] = []
    return {
      settled,
      list: () => entries,
      put: (entry: SolanaSwapRecord) => {
        entries = [...entries, { record: entry }]
      },
      settle: (id: string, status: 'confirmed' | 'failed') => {
        settled.push([id, status])
        entries = entries.map(entry =>
          entry.record.transactionId === id
            ? { ...entry, settled: status }
            : entry,
        )
      },
      remove: (id: string) => {
        entries = entries.filter(entry => entry.record.transactionId !== id)
      },
    }
  }

  type Status = null | { err: unknown; confirmationStatus?: any } | Error
  /**
   * `heights`: the finalized block height at each read; that node's slot is the height plus
   * 1000. `statusSlots`: the slot of the node answering each status read (default: far ahead).
   */
  function sender(script: {
    statuses: Status[]
    heights?: number[]
    statusSlots?: number[]
  }) {
    const sent: Uint8Array[] = []
    let heightIndex = 0
    let statusIndex = 0
    const connection: SolanaSwapSender = {
      sendRawTransaction: async raw => {
        sent.push(raw)
        return 'sig'
      },
      getSignatureStatuses: async () => {
        const next =
          script.statuses.length > 1
            ? script.statuses.shift()!
            : script.statuses[0]
        if (next instanceof Error) throw next
        const slots = script.statusSlots ?? [1_000_000]
        return {
          context: { slot: slots[Math.min(statusIndex++, slots.length - 1)] },
          value: [next],
        }
      },
      getEpochInfo: async () => {
        const heights = script.heights ?? [0]
        const blockHeight = heights[Math.min(heightIndex++, heights.length - 1)]
        return { absoluteSlot: blockHeight + 1000, blockHeight }
      },
      getTransaction: async () => ({
        meta: confirmedSwaps.transactions.solToDevUsdcCreatingTokenAccount
          .meta as SwapTransactionMeta,
      }),
    }
    return { connection, sent }
  }
  const track = { sleep: async () => undefined, maxRpcFailures: 3 }

  it('re-sends the same bytes until confirmed, then records what the chain delivered', async () => {
    const store = memoryJournal([record])
    const { connection, sent } = sender({
      statuses: [null, null, { err: null, confirmationStatus: 'confirmed' }],
    })
    const outcome = await trackSolanaSwap(connection, store, record, track)
    expect(outcome).toEqual({
      status: 'confirmed',
      signature: 'sig',
      finalized: false,
      receivedAmount: 222_201n,
      spentAmount: 10_000_000n,
      networkFeeLamports: 5000n,
      priorityFeeLamports: 0n,
      accountRentLamports: 1_488_440n,
    })
    expect(sent.length).toBeGreaterThan(0)
    expect(
      sent.every(raw => toBase64(raw) === record.recovery.signedTransaction),
    ).toBe(true)
    // The outcome went to the journal where it was decided. With no sync event wired there is
    // nobody to tell, so the entry leaves at once.
    expect(store.settled).toEqual([['sig', 'confirmed']])
    expect(store.list()).toEqual([])
  })

  it('is expired only after several checks find the height passed and the signature unknown', async () => {
    const store = memoryJournal([record])
    const { connection } = sender({
      statuses: [null],
      heights: [99, 100, 101],
    })
    let polls = 0
    await expect(
      trackSolanaSwap(connection, store, record, {
        ...track,
        sleep: async () => void polls++,
      }),
    ).resolves.toEqual({ status: 'expired', signature: 'sig' })
    // Heights 99 and 100 are still valid; then three separate checks past the height.
    expect(polls).toBe(4)
    // It never reached the chain: nothing is settled or announced, the entry just leaves.
    expect(store.settled).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('a node that has not itself reached the expiry height cannot say the swap expired', async () => {
    // The height passed 100 at slot 1101 on one node. The node answering the status reads is
    // still at slot 1000: its "never seen it" says nothing about blocks it has not processed.
    // Asked five times; then a node that is past the expiry answers, and has the swap.
    const store = memoryJournal([record])
    const { connection } = sender({
      statuses: [
        null,
        null,
        null,
        null,
        null,
        { err: null, confirmationStatus: 'finalized' },
      ],
      heights: [101],
      statusSlots: [1000, 1000, 1000, 1000, 1100, 1101],
    })
    await expect(
      trackSolanaSwap(connection, store, record, track),
    ).resolves.toMatchObject({ status: 'confirmed', finalized: true })

    // The same lagging answers, then three from a node past the expiry: expired.
    const lagging = sender({
      statuses: [null],
      heights: [101],
      statusSlots: [1000, 1000, 1000, 1000, 1101],
    })
    let polls = 0
    await expect(
      trackSolanaSwap(lagging.connection, memoryJournal([record]), record, {
        ...track,
        sleep: async () => void polls++,
      }),
    ).resolves.toEqual({ status: 'expired', signature: 'sig' })
    expect(polls).toBe(6)
  })

  it('does not expire a swap that one node had not seen and another then reports', async () => {
    const store = memoryJournal([record])
    const { connection } = sender({
      statuses: [null, null, { err: null, confirmationStatus: 'finalized' }],
      heights: [101],
    })
    await expect(
      trackSolanaSwap(connection, store, record, track),
    ).resolves.toMatchObject({ status: 'confirmed', finalized: true })
  })

  it('a failure is final only once finalized; before that the swap stays pending', async () => {
    const error = { InstructionError: [4, { Custom: 6036 }] }
    const store = memoryJournal([record])
    const { connection } = sender({
      statuses: [
        { err: error, confirmationStatus: 'processed' },
        { err: error, confirmationStatus: 'confirmed' },
        // That fork was dropped; the same transaction then succeeds.
        { err: null, confirmationStatus: 'confirmed' },
      ],
    })
    await expect(
      trackSolanaSwap(connection, store, record, track),
    ).resolves.toMatchObject({ status: 'confirmed' })

    const failing = memoryJournal([record])
    const finalized = sender({
      statuses: [
        { err: error, confirmationStatus: 'confirmed' },
        { err: error, confirmationStatus: 'finalized' },
      ],
    })
    await expect(
      trackSolanaSwap(finalized.connection, failing, record, track),
    ).resolves.toMatchObject({ status: 'failed', networkFeeLamports: 5000n })
    expect(failing.settled).toEqual([['sig', 'failed']])

    // A swap that carried a priority fee reports it as its own part of what was charged.
    const paidPriority = { ...record, priorityFeeLamports: '1200' }
    await expect(
      trackSolanaSwap(
        sender({ statuses: [{ err: null, confirmationStatus: 'finalized' }] })
          .connection,
        memoryJournal([paidPriority]),
        paidPriority,
        track,
      ),
    ).resolves.toMatchObject({
      status: 'confirmed',
      networkFeeLamports: 5000n,
      priorityFeeLamports: 1200n,
    })
  })

  it('keeps the swap pending when the network cannot be asked', async () => {
    const store = memoryJournal([record])
    const { connection } = sender({ statuses: [new Error('offline')] })
    await expect(
      trackSolanaSwap(connection, store, record, track),
    ).rejects.toBeInstanceOf(SolanaSwapStillPendingError)
    expect(store.list()).toEqual([{ record }])
    expect(store.settled).toEqual([])
  })

  const signer = {
    address: OWNER.toBase58(),
    chainIdentifier: 'solana-devnet',
    sign: jest.fn(async () => ({
      signature: 'sig',
      rawTransaction: Uint8Array.of(1, 2, 3),
    })),
  }

  /**
   * A swap that was really quoted (the recorded devnet quote of 0.005 SOL for devUSDC): its
   * transaction, what was reviewed, and the record of what it is for.
   */
  const { solToDevUsdc } = orcaFixture.swaps
  async function reviewed() {
    const quote = await createSolanaDex(
      'solana-devnet',
      DEVNET,
      walletOver(replay(solToDevUsdc.calls)),
    ).quote({
      owner: OWNER,
      inputMint: NATIVE_SOL_MINT,
      outputMint: DEV_USDC,
      amount: 5_000_000n,
      slippageBps: 50,
    })
    const prepared: PreparedLegacyTransaction = {
      transaction: quote.transaction,
      lastValidBlockHeight: quote.lastValidBlockHeight,
      check: quote.check,
    }
    const swapIntent: SolanaSwapIntent = {
      ...intent,
      amountIn: quote.inputAmount.toString(),
      quotedAmountOut: quote.expectedOutputAmount.toString(),
      minimumAmountOut: quote.minOutputAmount.toString(),
    }
    return { quote, prepared, intent: swapIntent }
  }
  /**
   * The chain as the wallet's send reads it just before signing: the wallet's balance and token
   * accounts, and the recorded simulation of the reviewed transaction. `now` stands in for a
   * chain that has moved on since the quote.
   */
  function chainAtSigning(
    now: {
      /** SOL that arrived in the wallet after the quote. */
      received?: bigint
      /** Alters the simulation's outcome. */
      simulated?: (value: any) => any
    } = {},
  ) {
    const recorded = (method: string) =>
      solToDevUsdc.calls.filter(call => call.method === method)
    const balance =
      (revive(recorded('getBalance')[0].result) as bigint) +
      (now.received ?? 0n)
    const tokenAccounts = recorded('getTokenAccountsByOwner').flatMap(
      call => revive(call.result).value,
    ) as { pubkey: PublicKey; account: any }[]
    const reads: string[] = []
    const chain = {
      getTokenAccountsByOwner: async (
        _owner: PublicKey,
        filter: { programId: PublicKey },
      ) => {
        reads.push('getTokenAccountsByOwner')
        return revive(
          recorded('getTokenAccountsByOwner').find(
            call => call.args[1] === filter.programId.toBase58(),
          )!.result,
        )
      },
      getMultipleAccountsInfo: async (addresses: PublicKey[]) => {
        reads.push('getMultipleAccountsInfo')
        return addresses.map(address =>
          address.equals(OWNER)
            ? {
                owner: SystemProgram.programId,
                lamports: balance,
                data: new Uint8Array(),
              }
            : tokenAccounts.find(entry => entry.pubkey.equals(address))
                ?.account ?? null,
        )
      },
      simulateTransaction: async (transaction: VersionedTransaction) => {
        reads.push('simulateTransaction')
        const { value } = revive(
          recorded('simulateTransaction').find(
            call => call.args[0] === toBase64(transaction.serialize()),
          )!.result,
        )
        // The simulation runs on the chain as it is now.
        const moved = {
          ...value,
          preBalances: [
            BigInt(value.preBalances[0]) + (now.received ?? 0n),
            ...value.preBalances.slice(1),
          ],
          accounts: [
            {
              ...value.accounts[0],
              lamports:
                BigInt(value.accounts[0].lamports) + (now.received ?? 0n),
            },
            ...value.accounts.slice(1),
          ],
        }
        return { value: now.simulated ? now.simulated(moved) : moved }
      },
    }
    return { chain, reads }
  }
  const legacy = (
    connection: SolanaSwapSender,
    store: ReturnType<typeof memoryJournal>,
    chain = chainAtSigning().chain,
  ) =>
    createSolanaLegacySender({
      connection: { ...connection, ...chain },
      signer: async () => signer,
      journal: store,
      track,
      now: () => 1,
    })

  it('announces a finalised swap through the sync event, and keeps it owed until delivered', async () => {
    const item = swapRecordItemOf(record)
    expect(item).toEqual({
      type: 'swap-record',
      swapId: swapRecordId('solana-devnet', 'sig'),
      chainIdentifier: 'solana-devnet',
      venueId: 'orca-whirlpools',
      txHash: 'sig',
      account: OWNER.toBase58(),
      assetIn: { symbol: 'SOL', decimals: 9 },
      amountIn: '10000000',
      assetOut: { symbol: 'devUSDC', address: DEV_USDC, decimals: 6 },
      quotedAmountOut: '222201',
      minimumAmountOut: '221089',
      interfaceFee: '0',
      networkFee: '5000',
      route: JSON.stringify({ label: 'Orca Whirlpool' }),
      timestamp: 1,
    })

    // A signature is case-sensitive base58: two that differ only in case are two swaps.
    expect(swapRecordId('solana-devnet', '5VERv8NMvzbJMEkV')).not.toBe(
      swapRecordId('solana-devnet', '5verv8nmvzbjmekv'),
    )

    // The note cannot be sent now: the swap is still confirmed, and the entry stays, settled.
    const store = memoryJournal([record])
    const confirmedNow = () =>
      sender({ statuses: [{ err: null, confirmationStatus: 'finalized' }] })
    const failing = jest
      .fn()
      .mockRejectedValue(new Error('mailbox unreachable'))
    await expect(
      trackSolanaSwap(confirmedNow().connection, store, record, {
        ...track,
        onSync: failing,
      }),
    ).resolves.toMatchObject({ status: 'confirmed' })
    expect(failing).toHaveBeenCalledWith(item)
    expect(store.list()).toEqual([{ record, settled: 'confirmed' }])

    // At the next open the wallet offers it again; nothing is sent to the chain for it.
    const delivered = jest.fn().mockResolvedValue(undefined)
    const later = confirmedNow()
    resumeSolanaLegacyTransactions(
      later.connection,
      store,
      { ...track, onSync: delivered },
      new Set(),
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(delivered).toHaveBeenCalledWith(item)
    expect(later.sent).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('at open, follows an unfinished transaction with its same bytes', async () => {
    const store = memoryJournal([record])
    const { connection, sent } = sender({
      statuses: [null, { err: null, confirmationStatus: 'finalized' }],
    })
    const onSync = jest.fn().mockResolvedValue(undefined)
    resumeSolanaLegacyTransactions(
      connection,
      store,
      { ...track, onSync },
      new Set(),
    )
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(sent.map(toBase64)).toEqual([record.recovery.signedTransaction])
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(store.list()).toEqual([])
  })

  it('a settled transaction whose note is owed does not block a new swap', async () => {
    const store = memoryJournal([record])
    store.settle('sig', 'confirmed')
    const { connection } = sender({
      statuses: [{ err: null, confirmationStatus: 'confirmed' }],
    })
    signer.sign.mockResolvedValueOnce({
      signature: 'sig2',
      rawTransaction: Uint8Array.of(9),
    })
    const swap = await reviewed()
    await expect(
      legacy(connection, store).sendLegacyTransaction(
        swap.prepared,
        swap.intent,
      ),
    ).resolves.toMatchObject({ status: 'confirmed', signature: 'sig2' })
  })

  it('records the transaction, with everything about the swap, before sending it', async () => {
    const store = memoryJournal()
    const { connection, sent } = sender({
      statuses: [{ err: null, confirmationStatus: 'confirmed' }],
    })
    const recordedWhenSent: SolanaLegacyJournalEntry[][] = []
    const realSend = connection.sendRawTransaction
    connection.sendRawTransaction = async (raw, options) => {
      recordedWhenSent.push(store.list())
      return realSend(raw, options)
    }
    const swap = await reviewed()
    const outcome = await legacy(connection, store).sendLegacyTransaction(
      swap.prepared,
      swap.intent,
    )
    expect(recordedWhenSent[0]).toEqual([
      {
        record: {
          ...swap.intent,
          transactionId: 'sig',
          signedAtMs: 1,
          recovery: {
            signedTransaction: record.recovery.signedTransaction,
            lastValidBlockHeight: swap.quote.lastValidBlockHeight.toString(),
          },
        },
      },
    ])
    expect(sent).toHaveLength(1)
    expect(outcome).toMatchObject({
      status: 'confirmed',
      receivedAmount: 222_201n,
    })
  })

  it('sends nothing if the record cannot be written', async () => {
    const store = memoryJournal()
    store.put = () => {
      throw new Error('storage full')
    }
    const { connection, sent } = sender({ statuses: [null] })
    const swap = await reviewed()
    await expect(
      legacy(connection, store).sendLegacyTransaction(
        swap.prepared,
        swap.intent,
      ),
    ).rejects.toThrow('storage full')
    expect(sent).toEqual([])
  })

  /** Rewrites the simulated balance of the wallet's devUSDC account (the swap's output). */
  const creditOnly = (credited: bigint) => (value: any) => {
    const before = Buffer.from(
      fromBase64(value.accounts[1].data[0]),
    ).readBigUInt64LE(64)
    const expected = BigInt(solToDevUsdc.expected.expectedOutputAmount)
    const accounts = value.accounts.map((account: any) => {
      if (account?.data[0] !== value.accounts[1].data[0]) return account
      const data = Buffer.from(fromBase64(account.data[0]))
      data.writeBigUInt64LE(before - expected + credited, 64)
      return { ...account, data: [toBase64(data), 'base64'] }
    })
    return { ...value, accounts }
  }

  it('checks the exact transaction itself, on the chain as it is now, immediately before signing', async () => {
    const store = memoryJournal()
    const { connection } = sender({
      statuses: [{ err: null, confirmationStatus: 'confirmed' }],
    })
    const swap = await reviewed()
    const { chain, reads } = chainAtSigning()
    signer.sign.mockClear()
    signer.sign.mockImplementationOnce(async () => {
      // By the time the key is used the wallet has been read afresh and the transaction run.
      expect(reads).toEqual(
        expect.arrayContaining([
          'getTokenAccountsByOwner',
          'getMultipleAccountsInfo',
          'simulateTransaction',
        ]),
      )
      return { signature: 'sig', rawTransaction: Uint8Array.of(1, 2, 3) }
    })
    await expect(
      legacy(connection, store, chain).sendLegacyTransaction(
        swap.prepared,
        swap.intent,
      ),
    ).resolves.toMatchObject({ status: 'confirmed' })
    expect(signer.sign).toHaveBeenCalledWith(
      swap.prepared.transaction,
      swap.prepared.lastValidBlockHeight,
    )
  })

  it('signs nothing when the swap would now deliver less than the reviewed minimum, and says why', async () => {
    const store = memoryJournal()
    const { connection, sent } = sender({ statuses: [null] })
    const swap = await reviewed()
    signer.sign.mockClear()
    await expect(
      legacy(
        connection,
        store,
        chainAtSigning({
          simulated: creditOnly(swap.quote.minOutputAmount - 1n),
        }).chain,
      ).sendLegacyTransaction(swap.prepared, swap.intent),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/less than the agreed minimum/),
    })
    // A transaction the chain would now reject is not signed either.
    await expect(
      legacy(
        connection,
        store,
        chainAtSigning({
          simulated: value => ({
            ...value,
            err: { InstructionError: [3, { Custom: 6017 }] },
            logs: ['Program log: AnchorError: AmountOutBelowMinimum'],
          }),
        }).chain,
      ).sendLegacyTransaction(swap.prepared, swap.intent),
    ).rejects.toMatchObject({ code: 'slippage' })
    expect(signer.sign).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('SOL that arrived after the quote does not loosen the check', async () => {
    const store = memoryJournal()
    const { connection, sent } = sender({ statuses: [null] })
    const swap = await reviewed()
    signer.sign.mockClear()
    // One SOL arrived since the quote, and the transaction would take half of it on top of
    // the swap. Measured against the balance at quote time the wallet still ends up ahead.
    const takesExtra = (value: any) => ({
      ...value,
      accounts: [
        {
          ...value.accounts[0],
          lamports: BigInt(value.accounts[0].lamports) - 500_000_000n,
        },
        ...value.accounts.slice(1),
      ],
    })
    for (const simulated of [
      takesExtra,
      // The same from a network whose simulation does not report balances before the run.
      (value: any) => ({ ...takesExtra(value), preBalances: undefined }),
    ]) {
      await expect(
        legacy(
          connection,
          store,
          chainAtSigning({ received: 1_000_000_000n, simulated }).chain,
        ).sendLegacyTransaction(swap.prepared, swap.intent),
      ).rejects.toMatchObject({
        code: 'unsafe-transaction',
        detail: expect.stringMatching(/more SOL than the swap needs/),
      })
    }
    expect(signer.sign).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('signs only the transaction that was reviewed, for the swap that was reviewed', async () => {
    const store = memoryJournal()
    const { connection, sent } = sender({ statuses: [null] })
    const swap = await reviewed()
    const other = await createSolanaDex(
      'solana-devnet',
      DEVNET,
      walletOver(replay(orcaFixture.swaps.devUsdcToSol.calls)),
    ).quote({
      owner: OWNER,
      inputMint: DEV_USDC,
      outputMint: NATIVE_SOL_MINT,
      amount: BigInt(orcaFixture.swaps.devUsdcToSol.request.amount),
      slippageBps: 50,
    })
    signer.sign.mockClear()
    // Another transaction under this swap's review.
    await expect(
      legacy(connection, store).sendLegacyTransaction(
        { ...swap.prepared, transaction: other.transaction },
        swap.intent,
      ),
    ).rejects.toMatchObject({
      code: 'unsafe-transaction',
      detail: expect.stringMatching(/not the transaction that was reviewed/),
    })
    // A record that says something else than what was reviewed.
    for (const changed of [
      { amountIn: '1' },
      { minimumAmountOut: '1' },
      {
        assetOut: {
          symbol: 'devUSDT',
          address: DEVNET.tokens[2].mint,
          decimals: 6,
        },
      },
      {
        assetIn: {
          symbol: 'devUSDT',
          address: DEVNET.tokens[2].mint,
          decimals: 6,
        },
      },
    ]) {
      await expect(
        legacy(connection, store).sendLegacyTransaction(swap.prepared, {
          ...swap.intent,
          ...changed,
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' })
    }
    expect(signer.sign).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('will not start a new swap while an earlier one may still land, or if the records cannot be read', async () => {
    const { connection, sent } = sender({ statuses: [null] })
    const swap = await reviewed()
    await expect(
      legacy(connection, memoryJournal([record])).sendLegacyTransaction(
        swap.prepared,
        swap.intent,
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' })
    const unreadable = memoryJournal()
    unreadable.list = () => {
      throw new Error('records unreadable')
    }
    await expect(
      legacy(connection, unreadable).sendLegacyTransaction(
        swap.prepared,
        swap.intent,
      ),
    ).rejects.toThrow('records unreadable')
    expect(sent).toEqual([])
  })

  it('will not sign for another wallet or network, and an exchange will not send a quote it cannot carry out', async () => {
    const store = memoryJournal()
    const { connection } = sender({ statuses: [null] })
    signer.sign.mockClear()
    const swap = await reviewed()
    for (const other of [
      { ...swap.intent, account: SystemProgram.programId.toBase58() },
      { ...swap.intent, chainIdentifier: 'solana-mainnet' },
    ]) {
      await expect(
        legacy(connection, store).sendLegacyTransaction(swap.prepared, other),
      ).rejects.toBeInstanceOf(SolanaSwapError)
    }
    const sendLegacyTransaction = jest.fn()
    const dex = createSolanaDex('solana-devnet', DEVNET, {
      chain: replay([]),
      sendLegacyTransaction,
      legacyTransactionOutcome: jest.fn(),
    })
    await expect(
      dex.execute(
        {
          blocker: new SolanaSwapError('insufficient-sol'),
        } as never,
        { assetIn: record.assetIn, assetOut: record.assetOut },
      ),
    ).rejects.toMatchObject({ code: 'insufficient-sol' })
    expect(sendLegacyTransaction).not.toHaveBeenCalled()
    expect(signer.sign).not.toHaveBeenCalled()
  })

  it('an exchange hands the wallet the transaction and the record of what it is for', async () => {
    const sendLegacyTransaction = jest.fn(async () => ({
      status: 'expired' as const,
      signature: 'sig',
    }))
    const dex = createSolanaDex('solana-devnet', DEVNET, {
      chain: replay([]),
      sendLegacyTransaction,
      legacyTransactionOutcome: jest.fn(),
    })
    const quote = {
      chainIdentifier: 'solana-devnet',
      venueId: 'orca-whirlpools',
      venueName: 'Orca Whirlpools (devnet)',
      owner: OWNER.toBase58(),
      route: [{ label: 'Orca Whirlpool' }],
      inputAmount: 10_000_000n,
      expectedOutputAmount: 222_201n,
      minOutputAmount: 221_089n,
      networkFeeLamports: 5000n,
      priorityFeeLamports: 0n,
      transaction: { the: 'transaction' },
      lastValidBlockHeight: 100n,
      check: { what: 'was reviewed' },
    }
    await dex.execute(quote as never, {
      assetIn: record.assetIn,
      assetOut: record.assetOut,
    })
    // The transaction, what was reviewed for it, and the record: nothing else, no callback
    // of the exchange's own that the wallet would have to trust.
    expect(sendLegacyTransaction).toHaveBeenCalledWith(
      {
        transaction: quote.transaction,
        lastValidBlockHeight: 100n,
        check: quote.check,
      },
      intent,
      undefined,
    )
  })
})

describe('an interface fee, when one is configured (none is today)', () => {
  it('Orca: an explicit transfer of the fee, and only the rest is swapped', async () => {
    // With a fee the transaction differs from the recorded one, so the recorded simulation
    // cannot answer for it; what is checked here is the transaction that gets built.
    const { solToDevUsdc } = orcaFixture.swaps
    const built: VersionedTransaction[] = []
    const chain = replay(solToDevUsdc.calls)
    const recorded = solToDevUsdc.calls.find(
      call => call.method === 'simulateTransaction',
    )!
    const dex = createSolanaDex(
      'solana-devnet',
      {
        ...DEVNET,
        interfaceFee: { bps: 100, recipient: STRANGER.toBase58() },
      },
      walletOver({
        ...chain,
        getFeeForMessage: async () => ({ value: 5000n }),
        simulateTransaction: async transaction => {
          built.push(transaction)
          return revive(recorded.result)
        },
      }),
    )
    const quote = await dex
      .quote({
        owner: OWNER,
        inputMint: NATIVE_SOL_MINT,
        outputMint: DEV_USDC,
        amount: 5_000_000n,
        slippageBps: 50,
      })
      .catch((error: unknown) => error)
    // The fee leaves the wallet in the stand-in simulation's eyes too, so the safety check
    // may refuse the stand-in; the built transaction is what matters here.
    void quote
    const message = built[0].message as any
    const instructions = message.compiledInstructions.map((ix: any) => ({
      program: message.staticAccountKeys[ix.programIdIndex].toBase58(),
      accounts: ix.accountKeyIndexes.map((i: number) =>
        message.staticAccountKeys[i]?.toBase58(),
      ),
      data: Buffer.from(ix.data),
    }))
    const feeTransfer = instructions.find(
      (ix: any) =>
        ix.program === SystemProgram.programId.toBase58() &&
        ix.data.length === 12 &&
        ix.data.readUInt32LE(0) === 2,
    )
    expect(feeTransfer.accounts).toEqual([
      OWNER.toBase58(),
      STRANGER.toBase58(),
    ])
    expect(feeTransfer.data.readBigUInt64LE(4)).toBe(50_000n) // 1% of 0.005 SOL
    const swap = instructions.find((ix: any) => ix.program === DEVNET.programId)
    expect(swap.data.readBigUInt64LE(8)).toBe(4_950_000n)
  })

  it('without one, nothing in the transaction pays anyone but the pool', async () => {
    const { solToDevUsdc } = orcaFixture.swaps
    const transaction = VersionedTransaction.deserialize(
      fromBase64(solToDevUsdc.expected.transaction),
    )
    const message = transaction.message as any
    const plainTransfers = message.compiledInstructions.filter(
      (ix: any) =>
        message.staticAccountKeys[ix.programIdIndex].equals(
          SystemProgram.programId,
        ) &&
        ix.data.length === 12 &&
        Buffer.from(ix.data).readUInt32LE(0) === 2,
    )
    expect(plainTransfers).toEqual([])
  })
})

describe('SolanaWallet signs a swap only through its checked send', () => {
  const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
  const transfer = (payer: PublicKey, extraSigner?: PublicKey) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: extraSigner ?? payer,
            toPubkey: OWNER,
            lamports: 1n,
          }),
        ],
      }).compileToV0Message(),
    )

  it('has no method that signs a swap transaction without the check, and refuses one it does not alone pay for', async () => {
    const asked: string[] = []
    const wallet = await SolanaWallet.fromSeed({
      connection: new Proxy(
        { getGenesisHash: async () => GENESIS },
        {
          get: (target, method: string) =>
            method in target
              ? target[method as keyof typeof target]
              : async () => {
                  asked.push(method)
                  throw new Error(`unexpected RPC call ${method}`)
                },
        },
      ) as never,
      seed: new Uint8Array(32).fill(7),
      chainIdentifier: 'solana-devnet',
      networkId: 'solana-devnet',
      genesisHash: GENESIS,
      legacy: {
        journal: { list: () => [], put() {}, settle() {}, remove() {} },
      },
    })
    expect(
      Object.getOwnPropertyNames(SolanaWallet.prototype).filter(name =>
        /sign.*swap/i.test(name),
      ),
    ).toEqual([])

    const own = new PublicKey(wallet.address)
    const other = (await Keypair.generate()).publicKey
    const mint = new PublicKey(DEV_USDC)
    const send = (transaction: VersionedTransaction) =>
      wallet.sendLegacyTransaction(
        {
          transaction,
          lastValidBlockHeight: 100n,
          check: {
            owner: own,
            transactionMessage: transaction.message.serialize(),
            state: {
              lamports: 1n,
              input: { mint: new PublicKey(NATIVE_SOL_MINT) },
              output: { mint },
            },
            inputAmount: 1n,
            minOutputAmount: 1n,
            networkFeeLamports: 5000n,
            walletAccounts: [],
          } as never,
        },
        {
          chainIdentifier: 'solana-devnet',
          venueId: 'orca-whirlpools',
          venueName: 'Orca Whirlpools (devnet)',
          route: 'Orca Whirlpool',
          account: wallet.address,
          assetIn: { symbol: 'SOL', address: null, decimals: 9 },
          amountIn: '1',
          assetOut: { symbol: 'devUSDC', address: DEV_USDC, decimals: 6 },
          quotedAmountOut: '1',
          minimumAmountOut: '1',
          interfaceFeeAmount: '0',
          networkFeeLamports: '5000',
          priorityFeeLamports: '0',
        },
      )
    await expect(send(transfer(other))).rejects.toThrow(/this wallet alone/)
    await expect(send(transfer(own, other))).rejects.toThrow(
      /this wallet alone/,
    )
    expect(asked).toEqual([])
    // Its own transaction gets as far as the check, which asks the chain before any signing.
    await expect(send(transfer(own))).rejects.toThrow(/unexpected RPC call/)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked).not.toContain('sendRawTransaction')
  })
})
