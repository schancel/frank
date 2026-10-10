/**
 * Manually-run check of the Solana swap against the REAL networks. Not a jest test: it needs
 * the network and, to execute, a devnet-funded key.
 *
 *   # live quotes: devnet Orca (needs a funded wallet), then every listed mainnet exchange
 *   node --import tsx packages/wallet/solana-swap.livecheck.ts quote <keyfile>
 *
 *   # one real DEVNET swap from the key in <keyfile>, then the reverse direction
 *   node --import tsx packages/wallet/solana-swap.livecheck.ts execute <keyfile> [lamports]
 *
 *   # one real DEVNET swap through every configured devnet pool
 *   node --import tsx packages/wallet/solana-swap.livecheck.ts pools <keyfile> [lamports]
 *
 *   # a real DEVNET round trip with a 1% interface fee paid to <recipient> (config has none)
 *   node --import tsx packages/wallet/solana-swap.livecheck.ts fee <keyfile> <lamports> <recipient>
 *
 * <keyfile> holds a 32-byte seed as 64 hex characters; it is created if missing, and its
 * address printed so it can be funded from https://faucet.solana.com (devnet).
 * RPC URLs come from SOLANA_DEVNET_HTTP_RPC_URL / SOLANA_MAINNET_HTTP_RPC_URL when set
 * (source the repo's .env), otherwise the public endpoints. Point the devnet URL at a relay's
 * `/chain-rpc/solana-devnet/rpc` to run everything through its proxy.
 *
 * This script never sends a mainnet transaction: on mainnet it only quotes (the exchange's
 * quote, its transaction, and the safety check in simulation).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Connection, PublicKey } from '@solana/web3.js'

import { formatBaseUnit } from './chain/base-unit'
import {
  createSolanaDex,
  fetchSwapTokenBalances,
  listSolanaDexEntries,
  NATIVE_SOL_MINT,
  createSolanaLegacySender,
  type SolanaDex,
  type SolanaDexWallet,
  type SolanaLegacyJournalEntry,
  type SolanaSwapSender,
  type SolanaSwapOutcome,
  type SolanaSwapQuote,
  type SolanaSwapTokenBalance,
  type SolanaSwapVenue,
} from './solana-swap'
import { SolanaWallet } from './solana-wallet'

const GENESIS = {
  'solana-devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'solana-mainnet': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const
type Network = keyof typeof GENESIS

const text = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner),
    1,
  )

/** One exchange of one network, wired to a real connection and the key in `keyfile`. */
async function open(network: Network, keyfile: string, entry: SolanaSwapVenue) {
  if (!existsSync(keyfile)) {
    writeFileSync(keyfile, randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  const seed = Uint8Array.from(
    Buffer.from(readFileSync(keyfile, 'utf8').trim(), 'hex'),
  )
  const connection = new Connection(
    network === 'solana-devnet'
      ? process.env.SOLANA_DEVNET_HTTP_RPC_URL ??
        'https://api.devnet.solana.com'
      : process.env.SOLANA_MAINNET_HTTP_RPC_URL ??
        'https://api.mainnet-beta.solana.com',
    'confirmed',
  )
  const wallet = await SolanaWallet.fromSeed({
    connection,
    seed,
    chainIdentifier: network,
    networkId: network,
    genesisHash: GENESIS[network],
  })
  // A journal in memory is enough here: this script follows each swap to its end in one run.
  let journal: SolanaLegacyJournalEntry[] = []
  const chain = connection as unknown as SolanaDexWallet['chain'] &
    SolanaSwapSender
  const dex = createSolanaDex(
    network,
    entry,
    {
      chain,
      ...createSolanaLegacySender({
        connection: chain,
        signer: async () => wallet,
        journal: {
          list: () => journal,
          put: record => {
            journal = [...journal, { record }]
            console.log('journaled before sending:', record.transactionId)
          },
          settle: (id, status) => console.log('journal: settled', status, id),
          remove: id => {
            journal = journal.filter(e => e.record.transactionId !== id)
          },
        },
      }),
    },
    { apiKey: process.env.JUPITER_API_KEY },
  )
  const owner = new PublicKey(wallet.address)
  const tokens = () => fetchSwapTokenBalances(connection, owner, entry.tokens)
  return { dex, owner, tokens }
}

const show = (tokens: readonly SolanaSwapTokenBalance[]) =>
  tokens.map(t => `${formatBaseUnit(t.amount, t.decimals)} ${t.symbol}`)

function describe(
  quote: SolanaSwapQuote,
  tokens: readonly SolanaSwapTokenBalance[],
) {
  const amount = (value: bigint, mint: string) => {
    const token = tokens.find(t => t.mint === mint)!
    return `${formatBaseUnit(value, token.decimals)} ${token.symbol}`
  }
  return {
    exchange: quote.venueName,
    pay: amount(quote.inputAmount, quote.inputMint),
    expected: amount(quote.expectedOutputAmount, quote.outputMint),
    minimum: amount(quote.minOutputAmount, quote.outputMint),
    priceImpactBps: quote.priceImpactBps,
    route: quote.route.map(hop => hop.label).join(' -> '),
    tradeFee:
      quote.tradeFee && amount(quote.tradeFee.amount, quote.tradeFee.mint),
    interfaceFee:
      quote.platformFee &&
      amount(quote.platformFee.amount, quote.platformFee.mint),
    networkFeeLamports: quote.networkFeeLamports,
    accountRentLamports: quote.accountRentLamports,
    temporaryRentLamports: quote.temporaryRentLamports,
    lastValidBlockHeight: quote.lastValidBlockHeight,
    cannotExecute: quote.blocker?.message,
  }
}

async function swapOnce(
  dex: SolanaDex,
  owner: PublicKey,
  tokens: readonly SolanaSwapTokenBalance[],
  inputMint: string,
  outputMint: string,
  amount: bigint,
): Promise<SolanaSwapOutcome> {
  const quote = await dex.quote({
    owner,
    inputMint,
    outputMint,
    amount,
    slippageBps: 50,
  })
  console.log('quote', text(describe(quote, tokens)))
  const asset = (mint: string) => {
    const token = tokens.find(t => t.mint === mint)!
    return {
      symbol: token.symbol,
      address: token.native ? null : token.mint,
      decimals: token.decimals,
    }
  }
  const outcome = await dex.execute(
    quote,
    { assetIn: asset(inputMint), assetOut: asset(outputMint) },
    record => console.log('submitted', record.transactionId),
  )
  console.log('outcome', text(outcome))
  return outcome
}

async function main() {
  const [mode, keyfile, amountArg, feeRecipient] = process.argv.slice(2)
  if (!['quote', 'execute', 'pools', 'fee'].includes(mode) || !keyfile) {
    throw new Error(
      'usage: solana-swap.livecheck.ts quote|execute|pools|fee <keyfile> [lamports] [fee recipient]',
    )
  }
  const [devnetEntry] = listSolanaDexEntries('solana-devnet')
  const devnet = await open('solana-devnet', keyfile, {
    ...devnetEntry,
    ...(mode === 'fee' && feeRecipient
      ? { interfaceFee: { bps: 100, recipient: feeRecipient } }
      : {}),
  })
  const devTokens = await devnet.tokens()
  const usdc = devnetEntry.tokens[1].mint
  console.log('wallet', devnet.owner.toBase58())
  console.log('devnet balances', show(devTokens))

  if (mode === 'quote') {
    for (const amount of [1_000_000n, 50_000_000n]) {
      try {
        const quote = await devnet.dex.quote({
          owner: devnet.owner,
          inputMint: NATIVE_SOL_MINT,
          outputMint: usdc,
          amount,
          slippageBps: 50,
        })
        console.log('devnet quote', text(describe(quote, devTokens)))
      } catch (error) {
        console.log('devnet quote failed:', String(error))
      }
    }
    // Mainnet exchanges are listed but not enabled; quote them all the same, read-only.
    for (const entry of listSolanaDexEntries('solana-mainnet')) {
      const mainnet = await open('solana-mainnet', keyfile, entry)
      const mainTokens = await mainnet.tokens()
      for (const amount of [10_000_000n, 1_000_000_000n]) {
        try {
          const quote = await mainnet.dex.quote({
            owner: mainnet.owner,
            inputMint: NATIVE_SOL_MINT,
            outputMint: entry.tokens[1].mint,
            amount,
            slippageBps: 50,
          })
          console.log(
            `mainnet quote (enabled: ${entry.enabled}; not executed)`,
            text(describe(quote, mainTokens)),
          )
        } catch (error) {
          console.log(`mainnet ${entry.displayName} quote:`, String(error))
        }
        await new Promise(resolve => setTimeout(resolve, 5000)) // keyless rate limit
      }
    }
    return
  }

  const swap = (inputMint: string, outputMint: string, amount: bigint) =>
    swapOnce(devnet.dex, devnet.owner, devTokens, inputMint, outputMint, amount)
  const first = await swap(
    NATIVE_SOL_MINT,
    usdc,
    BigInt(amountArg ?? '10000000'),
  )
  if (first.status !== 'confirmed') return
  if (mode === 'pools') {
    // SOL -> devUSDC above, then devUSDC -> every other configured token.
    const others = devnetEntry.tokens.slice(2)
    for (const token of others) {
      await swap(
        usdc,
        token.mint,
        first.receivedAmount / BigInt(others.length + 1),
      )
    }
  } else {
    await swap(usdc, NATIVE_SOL_MINT, first.receivedAmount)
  }
  console.log('devnet balances after', show(await devnet.tokens()))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
