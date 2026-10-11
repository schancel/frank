/**
 * One real swap on Monad testnet whose record is then read back from the account's own mailbox
 * by a wallet opened afresh. It spends testnet funds. It needs a relay with the message and
 * directory routes (`backend/cashweb/run-local-monad.sh` has them).
 *
 *   SWAP_LIVECHECK_RELAY_URL=http://127.0.0.1:<port> \
 *   SWAP_LIVECHECK_WALLET_DIR=/path/outside/the/repo \
 *   TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx \
 *     packages/bot/demo/swap-note.livecheck.ts <FROM> <TO> <amount>
 *
 * `SWAP_LIVECHECK_WALLET_DIR/roots.json` holds the wallet's roots (created when missing, mode
 * 600, never printed); fund the printed main address first. Each run uses new state directories
 * beside it, so the second wallet in a run has never seen the swap: everything it shows came
 * from the mailbox and the chain.
 *
 * What it shows, in order:
 *  1. the swap is sent through the composed wallet handle and the Uniswap v4 adapter class,
 *     with its record as an argument of the wallet's contract send;
 *  2. the wallet journals the record and, once the swap is included, sends it in a free note to
 *     the account itself (the member becomes `syncApplied` when the relay has accepted it);
 *  3. a second wallet, opened from the same roots with empty state, reads its mailbox and finds
 *     the `swap-record` item, under the id derived from the chain and the transaction;
 *  4. that wallet reads what the swap did from the chain by the record's transaction and route.
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { formatUnits, parseUnits } from 'ethers'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import { getEvmDexDeployment } from '@frank/wallet/chain/dex-deployments'
import { swapRecordId } from '@frank/wallet/chain/evm-legacy-consolidator'
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import {
  createRelayPricedEvmChain,
  installCanonicalDirectory,
} from '@frank/wallet/chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'
import { registerMonadIdentity } from '@frank/wallet/monad-identity'
import { findToken } from '@frank/wallet/swap/uniswap-v4'
import { UniswapV4Dex } from '@frank/wallet/swap/uniswap-v4-dex'
import { DirectoryManager } from '@frank/bot-framework/directory-manager'

const CHAIN = 'monad-testnet'
const PURPOSES = [
  'evm-wallet',
  'identity-authentication',
  'messaging-encryption',
] as const

function loadRoots(dir: string): MonadRootBundle {
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
  const root = (purpose: (typeof PURPOSES)[number]) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: Uint8Array.from(Buffer.from(stored[purpose]!, 'hex')),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  } as MonadRootBundle
}

/** A wallet with messaging, as a host composes one: directory entry published and installed. */
async function openWallet(relayBaseUrl: string, dir: string, state: string) {
  const chain = createRelayPricedEvmChain({
    networkId: CHAIN,
    chainIdentifier: CHAIN,
    chainId: 10143,
    rpcChain: CHAIN,
    relayBaseUrl,
    networkTag: 'MONT',
    stampBurnAddress:
      process.env.MONAD_STAMP_BURN_ADDRESS ??
      '0x000000000000000000000000000000000000dEaD',

    defaultTopicVoteValueWei: 10n ** 12n,
    subAccountPoolSize: 2,
    walletStorageLocation: join(dir, state, 'wallet'),
  })
  mkdirSync(join(dir, state), { recursive: true })
  // The note is best effort inside the wallet and its failure is not thrown: say why here.
  const send = chain.directMessages.send.bind(chain.directMessages)
  chain.directMessages.send = async params => {
    try {
      return await send(params)
    } catch (error) {
      console.log(
        `   (note to self not sent: ${
          error instanceof Error ? `${error.name}: ${error.message}` : error
        })`,
      )
      throw error
    }
  }
  const wallet = (await chain.createWallet(
    loadRoots(dir),
  )) as EvmChainWalletHandle
  await registerMonadIdentity({
    relayBaseUrl,
    identity: wallet.identity,
    profile: { name: 'swap note livecheck' },
  }).catch(() => undefined)
  const directory = DirectoryManager.create({
    handle: wallet,
    networkTag: 'MONT',
    relayBaseUrl,
    location: join(dir, state, 'directory'),
  })
  await directory.publishWithRetry('swap-note-livecheck')
  const removeDirectory = installCanonicalDirectory(
    wallet,
    directory.rawDirectory,
  )
  const removeItems = installMessageItemRegistry(
    wallet,
    createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable),
  )
  const dex = new UniswapV4Dex(CHAIN, getEvmDexDeployment(CHAIN)!, {
    reader: wallet.evmReader!,
    sendContractCall: params => wallet.sendContractCall!(params),
    getContractCallFunds: () => wallet.getContractCallFunds!(),
    estimateLegacyFee: params => wallet.estimateLegacyFee!(params),
    fundMainAccount: params => wallet.fundMainAccount!(params),
    resumeLegacySend: id => wallet.resumeLegacySend!(id),
    resumeNativeOperation: id => wallet.resumeNativeOperation!(id),
    getUnresolvedContractCalls: () => wallet.getUnresolvedContractCalls!(),
    reobserveNativeOperations: () => wallet.reobserveNativeOperations!(),
  })
  return {
    chain,
    wallet,
    dex,
    close: async () => {
      removeItems()
      removeDirectory()
      await directory.close()
      await wallet.close()
    },
  }
}

const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

async function main(): Promise<void> {
  const relayBaseUrl = process.env.SWAP_LIVECHECK_RELAY_URL
  const dir = process.env.SWAP_LIVECHECK_WALLET_DIR
  const [fromSymbol, toSymbol, amount] = process.argv.slice(2)
  if (!relayBaseUrl || !dir)
    throw new Error(
      'Set SWAP_LIVECHECK_RELAY_URL and SWAP_LIVECHECK_WALLET_DIR',
    )
  // SWAP_LIVECHECK_RUN names an earlier run to continue (its swap is already on chain).
  const run = process.env.SWAP_LIVECHECK_RUN ?? `run-${Date.now()}`
  console.log(`run ${run}`)
  const deployment = getEvmDexDeployment(CHAIN)!

  const first = await openWallet(relayBaseUrl, dir, `${run}-a`)
  let txHash: string | undefined
  try {
    const account = (await first.wallet.getReceiveAddress()).raw
    const funds = await first.wallet.getContractCallFunds!()
    console.log(
      `main account ${account}, holds ${formatUnits(
        funds.mainBalance,
        18,
      )} MON`,
    )
    const earlier = first.wallet.getNativeOperations!().find(
      r => r.kind === 'contract' && r.record && r.members[0]?.signed,
    )
    if (!earlier && (!fromSymbol || !toSymbol || !amount)) return
    const result = earlier
      ? {
          status: 'confirmed' as const,
          operationId: earlier.operationId,
          txHash: earlier.members[0]!.signed!.transactionHash,
        }
      : await swap()
    async function swap() {
      const tokenIn = findToken(deployment, fromSymbol)!
      const tokenOut = findToken(deployment, toSymbol)!
      const quote = await first.dex.quote({
        tokenIn,
        tokenOut,
        amountIn: parseUnits(amount, tokenIn.decimals),
      })
      const plan = await first.dex.plan({ quote, slippageBps: 100, account })
      console.log(
        `quote: ${amount} ${tokenIn.symbol} -> ${formatUnits(
          quote.amountOut,
          tokenOut.decimals,
        )} ${tokenOut.symbol}`,
      )
      const done = await first.dex.execute({ plan, account })
      console.log('1. swap result', json(done))
      if (done.status !== 'confirmed')
        throw new Error('The swap did not confirm')
      return done
    }
    txHash = result.txHash
    const row = () =>
      first.wallet.getNativeOperations!().find(
        r => r.operationId === result.operationId,
      )!
    console.log('   record in the wallet journal:', json(row().record))
    // 2. The note is the wallet's to send and retry; ask it again until the relay has it.
    for (let i = 0; i < 20 && !row().members[0]!.syncApplied; i++) {
      await new Promise(resolve => setTimeout(resolve, 3_000))
      await first.wallet.resumeNativeOperation!(result.operationId).catch(
        () => undefined,
      )
    }
    console.log(
      `2. note to self accepted by the relay: ${row().members[0]!.syncApplied}`,
    )
    if (!row().members[0]!.syncApplied)
      throw new Error('The note to self was not accepted')
  } finally {
    await first.close()
  }
  if (!txHash) return

  // 3. A wallet that has never seen the swap: empty state, same account.
  const second = await openWallet(relayBaseUrl, dir, `${run}-b`)
  try {
    console.log(
      `3. fresh wallet: ${
        second.wallet.getNativeOperations!().length
      } operations in its own journal`,
    )
    const received = await second.chain.directMessages.fetchSince({
      wallet: second.wallet,
      sinceMs: 0,
    })
    const records = received.flatMap(message =>
      message.items.filter(
        (item): item is SwapRecordItem => item.type === 'swap-record',
      ),
    )
    const expected = swapRecordId(CHAIN, txHash.toLowerCase())
    const record = records.find(item => item.swapId === expected)
    console.log(
      `   mailbox: ${received.length} message(s), ${
        records.length
      } swap record(s); this swap's record found: ${record !== undefined}`,
    )
    if (!record) throw new Error('The swap record was not in the mailbox')
    console.log('   record from the mailbox:', json(record))
    // 4. What it did, from the chain, by the record alone.
    const outcome = await second.dex.observe({
      transactionId: record.txHash,
      account: record.account,
      route: JSON.parse(record.route!),
    })
    console.log(
      '4. outcome read from the chain by the fresh wallet:',
      json(outcome),
    )
  } finally {
    await second.close()
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    error => {
      console.error(error instanceof Error ? error.stack ?? error.message : error)
      process.exit(1)
    },
  )
}
