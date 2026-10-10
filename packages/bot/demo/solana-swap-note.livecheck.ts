/**
 * One real swap on Solana devnet, entirely through a relay, whose record is then read back from
 * the account's own mailbox by a wallet opened afresh. It spends devnet funds. It needs a relay
 * with the message and directory routes and the Solana RPC proxy
 * (`backend/cashweb/run-local-monad.sh` has them).
 *
 *   SWAP_LIVECHECK_RELAY_URL=http://127.0.0.1:<port> \
 *   SWAP_LIVECHECK_WALLET_DIR=/path/outside/the/repo \
 *   TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx \
 *     packages/bot/demo/solana-swap-note.livecheck.ts [lamports]
 *
 * `SWAP_LIVECHECK_WALLET_DIR/roots.json` holds the account's roots (created when missing, mode
 * 600, never printed), including the Solana wallet's. With no amount it prints the Solana
 * address and its balances and stops: fund it (https://faucet.solana.com, devnet) and run again.
 * Each run uses new state directories beside the roots, so the second wallet in a run has never
 * seen the swap: everything it shows came from the mailbox and the chain.
 *
 * What it shows, in order:
 *  1. the swap is quoted and sent through the Orca exchange class and the Solana wallet's
 *     legacy send, with its record as an argument; every chain call goes through the relay;
 *  2. the wallet journals the signed transaction with the record before broadcasting, and once
 *     the chain has finalised it raises its sync event, which is sent as a free note from the
 *     account to itself; the journal entry leaves when the relay has accepted the note;
 *  3. a second wallet, opened from the same roots with empty state, reads its mailbox and finds
 *     the `swap-record` item under the id derived from the chain and the transaction;
 *  4. that wallet reads what the swap did from the chain, checking that the record's account
 *     paid for the transaction and that it called the exchange.
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getBytes, keccak256, toUtf8Bytes } from 'ethers'
import { Connection, PublicKey } from '@solana/web3.js'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import { formatBaseUnit } from '@frank/wallet/chain/base-unit'
import { swapRecordId } from '@frank/wallet/chain/evm-legacy-consolidator'
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import {
  createEvmChain,
  installCanonicalDirectory,
} from '@frank/wallet/chain/monad-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'
import { registerMonadIdentity } from '@frank/wallet/monad-identity'
import {
  BrowserSolanaLegacyJournal,
  createSolanaDex,
  fetchSwapTokenBalances,
  getSolanaSwapVenue,
  NATIVE_SOL_MINT,
  observeSolanaSwapRecord,
  trackSolanaSwap,
  type SolanaDexWallet,
  type SolanaLegacySync,
  type SolanaSwapObserver,
  type SolanaSwapSender,
} from '@frank/wallet/solana-swap'
import { SolanaWallet } from '@frank/wallet/solana-wallet'
import { DirectoryManager } from '@frank/bot-framework/src/directory-manager'

const MESSAGING_CHAIN = 'monad-testnet'
const CHAIN = 'solana-devnet'
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const PURPOSES = [
  'evm-wallet',
  'identity-authentication',
  'messaging-encryption',
  'solana-wallet',
] as const

function loadRoots(dir: string) {
  const file = join(dir, 'roots.json')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        Object.fromEntries(
          PURPOSES.map(purpose => [purpose, randomBytes(32).toString('hex')]),
        ),
      ),
      { mode: 0o600 },
    )
  }
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<
    string,
    string
  >
  const bytes = (purpose: (typeof PURPOSES)[number]) =>
    Uint8Array.from(Buffer.from(stored[purpose]!, 'hex'))
  const root = (purpose: (typeof PURPOSES)[number]) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: bytes(purpose),
  })
  return {
    messaging: {
      evm: root('evm-wallet'),
      authentication: root('identity-authentication'),
      messaging: root('messaging-encryption'),
    } as MonadRootBundle,
    solanaSeed: bytes('solana-wallet'),
  }
}

/** A file standing in for the browser's storage, so the journal is durable across wallets. */
function fileStorage(path: string) {
  return {
    getItem: () => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    setItem: (_key: string, value: string) => writeFileSync(path, value),
  }
}

/** The account as a host composes it: messaging identity, directory entry, Solana wallet. */
async function openAccount(relayBaseUrl: string, dir: string, state: string) {
  const roots = loadRoots(dir)
  mkdirSync(join(dir, state), { recursive: true })
  const chain = createEvmChain({
    networkId: MESSAGING_CHAIN,
    chainIdentifier: MESSAGING_CHAIN,
    chainId: 10143,
    rpcChain: MESSAGING_CHAIN,
    relayBaseUrl,
    networkTag: 'MONT',
    stampBurnAddress:
      process.env.MONAD_STAMP_BURN_ADDRESS ??
      '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: 10n ** 16n,
    defaultTopicVoteValueWei: 10n ** 12n,
    subAccountPoolSize: 2,
    walletStorageLocation: join(dir, state, 'wallet'),
  })
  const identity = (await chain.createWallet(
    roots.messaging,
  )) as EvmChainWalletHandle
  await registerMonadIdentity({
    relayBaseUrl,
    identity: identity.identity,
    profile: { name: 'solana swap note livecheck' },
  }).catch(() => undefined)
  const directory = DirectoryManager.create({
    handle: identity,
    networkTag: 'MONT',
    relayBaseUrl,
    location: join(dir, state, 'directory'),
  })
  await directory.publishWithRetry('solana-swap-note-livecheck')
  const removeDirectory = installCanonicalDirectory(
    identity,
    directory.rawDirectory,
  )
  const removeItems = installMessageItemRegistry(
    identity,
    createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable),
  )

  // The wallet's sync event, wired as the app wires it: a free note from the account to itself.
  const notes: string[] = []
  const onSync: SolanaLegacySync = async item => {
    try {
      await chain.directMessages.send({
        wallet: identity,
        recipient: { raw: identity.identity.address.raw },
        items: [item],
        stampValue: 0n,
        messageId: getBytes(
          keccak256(
            toUtf8Bytes(
              `frank-wallet-sync:${item.chainIdentifier}:${item.txHash}`,
            ),
          ),
        ).slice(0, 16),
      })
      notes.push(item.swapId)
    } catch (error) {
      console.log(
        `   (note to self not sent: ${
          error instanceof Error ? `${error.name}: ${error.message}` : error
        })`,
      )
      throw error
    }
  }

  // Solana through the relay's proxy only.
  const connection = new Connection(
    `${relayBaseUrl.replace(/\/+$/, '')}/chain-rpc/${CHAIN}/rpc`,
    'confirmed',
  )
  const journal = new BrowserSolanaLegacyJournal(
    fileStorage(join(dir, state, 'solana-legacy.json')),
  )
  const solana = await SolanaWallet.fromSeed({
    connection,
    seed: roots.solanaSeed,
    chainIdentifier: CHAIN,
    networkId: CHAIN,
    genesisHash: GENESIS,
    legacy: { journal, onSync },
  })
  const sender = connection as unknown as SolanaSwapSender
  const entry = getSolanaSwapVenue(CHAIN)!
  const wallet: SolanaDexWallet = {
    chain: connection as unknown as SolanaDexWallet['chain'],
    sendLegacyTransaction: (prepared, intent, onSubmitted) =>
      solana.sendLegacyTransaction(prepared, intent, onSubmitted),
    legacyTransactionOutcome: record =>
      trackSolanaSwap(sender, journal, record, { onSync }),
  }
  return {
    chain,
    identity,
    connection,
    journal,
    notes,
    entry,
    owner: new PublicKey(solana.address),
    dex: createSolanaDex(CHAIN, entry, wallet),
    close: async () => {
      removeItems()
      removeDirectory()
      await directory.close()
      await identity.close()
    },
  }
}

const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

async function main(): Promise<void> {
  const relayBaseUrl = process.env.SWAP_LIVECHECK_RELAY_URL
  const dir = process.env.SWAP_LIVECHECK_WALLET_DIR
  const [amount] = process.argv.slice(2)
  if (!relayBaseUrl || !dir)
    throw new Error(
      'Set SWAP_LIVECHECK_RELAY_URL and SWAP_LIVECHECK_WALLET_DIR',
    )
  const run = `run-${Date.now()}`
  console.log(`run ${run}`)

  const first = await openAccount(relayBaseUrl, dir, `${run}-a`)
  let signature: string | undefined
  try {
    const tokens = await fetchSwapTokenBalances(
      first.connection,
      first.owner,
      first.entry.tokens,
    )
    console.log(
      `Solana account ${first.owner.toBase58()}, holds ${tokens
        .map(t => `${formatBaseUnit(t.amount, t.decimals)} ${t.symbol}`)
        .join(', ')}`,
    )
    console.log(`messaging identity ${first.identity.identity.address.raw}`)
    if (!amount) return
    const [sol, usdc] = tokens
    const quote = await first.dex.quote({
      owner: first.owner,
      inputMint: NATIVE_SOL_MINT,
      outputMint: usdc.mint,
      amount: BigInt(amount),
      slippageBps: 50,
    })
    console.log(
      `quote on ${quote.venueName}: ${formatBaseUnit(
        quote.inputAmount,
        sol.decimals,
      )} SOL -> ${formatBaseUnit(quote.expectedOutputAmount, usdc.decimals)} ${
        usdc.symbol
      }, minimum ${formatBaseUnit(quote.minOutputAmount, usdc.decimals)}`,
    )
    const outcome = await first.dex.execute(
      quote,
      {
        assetIn: { symbol: sol.symbol, address: null, decimals: sol.decimals },
        assetOut: {
          symbol: usdc.symbol,
          address: usdc.mint,
          decimals: usdc.decimals,
        },
      },
      record => {
        signature = record.transactionId
        console.log(
          `   journaled before broadcast: ${
            first.journal.list().length
          } entry, ${record.transactionId}`,
        )
      },
    )
    console.log('1. swap outcome', json(outcome))
    if (outcome.status !== 'confirmed')
      throw new Error('The swap did not confirm')
    // 2. The sync event was raised at the outcome; the entry leaves once the note is accepted.
    console.log(
      `2. note to self accepted by the relay: ${
        first.notes.length === 1
      }; journal entries left: ${first.journal.list().length}`,
    )
    if (first.notes.length !== 1 || first.journal.list().length !== 0)
      throw new Error('The note to self was not accepted')
  } finally {
    await first.close()
  }
  if (!signature) return

  // 3. An account that has never seen the swap: empty state, same roots.
  const second = await openAccount(relayBaseUrl, dir, `${run}-b`)
  try {
    console.log(
      `3. fresh wallet: ${
        second.journal.list().length
      } entries in its own journal`,
    )
    const received = await second.chain.directMessages.fetchSince({
      wallet: second.identity,
      sinceMs: 0,
    })
    const records = received.flatMap(message =>
      message.items.filter(
        (item): item is SwapRecordItem => item.type === 'swap-record',
      ),
    )
    const expected = swapRecordId(CHAIN, signature)
    const record = records.find(item => item.swapId === expected)
    console.log(
      `   mailbox: ${received.length} message(s), ${
        records.length
      } swap record(s); this swap's record found: ${record !== undefined}`,
    )
    if (!record) throw new Error('The swap record was not in the mailbox')
    console.log('   record from the mailbox:', json(record))
    // 4. What it did, from the chain, by the record alone. Finalization takes a few seconds.
    for (let i = 0; i < 20; i++) {
      const seen = await observeSolanaSwapRecord(
        second.connection as unknown as SolanaSwapObserver,
        record,
        second.entry.programId,
      )
      if (seen.status !== 'unknown') {
        console.log(
          '4. outcome read from the chain by the fresh wallet:',
          json(seen),
        )
        return
      }
      await new Promise(resolve => setTimeout(resolve, 3_000))
    }
    throw new Error('The chain did not show the swap as finalized')
  } finally {
    await second.close()
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(1)
  },
)
