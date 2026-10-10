/**
 * One real swap on a testnet, through the same code the app runs: a quote from the chain, the
 * exact-amount approvals when the input is a token, and the swap itself sent by the wallet's
 * native-operation journal and consolidator (`sendContractCall`), then read back from the
 * receipt. It spends testnet funds. Never point it at a mainnet.
 *
 *   set -a; source .env; set +a
 *   SWAP_LIVECHECK_ACCOUNT_JSON=/path/outside/the/repo/account.json \
 *   TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx \
 *     packages/wallet/swap/swap-real.livecheck.ts <FROM> <TO> <amount> [slippageBps]
 *
 * `SWAP_LIVECHECK_ACCOUNT_JSON`: a `{"address","privateKey"}` file for the account that swaps. It
 * is created when missing; fund the printed address and run again. Keys are never printed.
 * The journal is kept beside that file, so a run that was interrupted after signing is resumed
 * by the next run instead of being sent again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  JsonRpcProvider,
  Transaction,
  Wallet,
  formatUnits,
  parseUnits,
} from 'ethers'
import { getEvmDexDeployment } from '../chain/dex-deployments'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import { EvmLegacyConsolidator } from '../chain/evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from '../chain/evm-transaction-builder'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import { fetchSwapQuote, planSwap, readTokenBalances } from './evm-swap'
import { executeSwap, type SwapWallet } from './swap-execution'
import { findToken } from './uniswap-v4'

async function main(): Promise<void> {
  const [fromSymbol, toSymbol, amount, slippage = '100'] = process.argv.slice(2)
  const chainIdentifier = process.env.SWAP_LIVECHECK_CHAIN ?? 'monad-testnet'
  const entry = PROTOCOL_CHAINS[chainIdentifier]
  if (!entry || entry.network !== 'testnet')
    throw new Error('This check only runs on a testnet')
  const url =
    process.env.SWAP_LIVECHECK_RPC_URL ?? process.env.MONAD_TESTNET_HTTP_RPC_URL
  const accountFile = process.env.SWAP_LIVECHECK_ACCOUNT_JSON
  if (!url || !accountFile || !fromSymbol || !toSymbol || !amount)
    throw new Error(
      'Usage: SWAP_LIVECHECK_ACCOUNT_JSON=… tsx swap-real.livecheck.ts <FROM> <TO> <amount> [slippageBps]',
    )
  const deployment = getEvmDexDeployment(chainIdentifier)
  if (!deployment) throw new Error(`No swap deployment for ${chainIdentifier}`)
  const provider = new JsonRpcProvider(url, undefined, { batchMaxCount: 1 })
  if (
    String((await provider.getNetwork()).chainId) !==
    String(entry.nativeChainId)
  )
    throw new Error('The RPC endpoint is not the expected chain')

  if (!existsSync(accountFile)) {
    mkdirSync(dirname(accountFile), { recursive: true })
    const created = Wallet.createRandom()
    writeFileSync(
      accountFile,
      JSON.stringify({
        address: created.address,
        privateKey: created.privateKey,
      }),
      { mode: 0o600 },
    )
    console.log(
      `Created ${created.address}. Fund it with the native coin and run again.`,
    )
    return
  }
  const signer = new Wallet(
    JSON.parse(readFileSync(accountFile, 'utf8')).privateKey as string,
  )
  const account = signer.address
  const tokenIn = findToken(deployment, fromSymbol)
  const tokenOut = findToken(deployment, toSymbol)
  if (!tokenIn || !tokenOut)
    throw new Error('Unknown token for this deployment')

  const journal = new EvmNativeOperationJournal({
    location: join(dirname(accountFile), `journal-${account.toLowerCase()}`),
    binding: {
      chainIdentifier,
      nativeChainId: String(entry.nativeChainId),
      publicTuple: account.toLowerCase(),
    },
  })
  mkdirSync(join(dirname(accountFile), `journal-${account.toLowerCase()}`), {
    recursive: true,
  })
  await journal.Open()
  const consolidator = new EvmLegacyConsolidator({
    provider,
    journal,
    transactionBuilder: new NativeEvmTransactionBuilder(),
    getSources: async () => [{ kind: 'main', address: account.toLowerCase() }],
    sign: async (_source, unsigned) =>
      signer.signTransaction(Transaction.from(unsigned)),
  })
  const wallet: SwapWallet = {
    sendContractCall: params => consolidator.sendContractCall(params),
    getContractCallFunds: () => consolidator.contractCallFunds(),
    resumeNativeOperation: id => consolidator.resumeOperation(id),
    reobserveNativeOperations: () => consolidator.reobservePending(),
  }
  try {
    const unfinished = journal
      .list()
      .filter(
        row =>
          !row.cancelled &&
          row.members.some(
            m => m.signed && !('transactionHash' in m.observation),
          ),
      )
    for (const row of unfinished) {
      console.log(`resuming recorded operation ${row.operationId}`)
      await consolidator.resumeOperation(row.operationId).catch(() => undefined)
    }

    const show = (balances: bigint[]) =>
      deployment.tokens
        .map((t, i) => `${formatUnits(balances[i]!, t.decimals)} ${t.symbol}`)
        .join(', ')
    const before = await readTokenBalances(provider, deployment, account)
    console.log(`account ${account}`)
    console.log(`before: ${show(before)}`)

    const quote = await fetchSwapQuote(provider, deployment, {
      tokenIn,
      tokenOut,
      amountIn: parseUnits(amount, tokenIn.decimals),
    })
    const plan = await planSwap(provider, deployment, {
      quote,
      slippageBps: Number(slippage),
      account,
    })
    console.log(
      `quote: ${amount} ${tokenIn.symbol} -> ${formatUnits(
        quote.amountOut,
        tokenOut.decimals,
      )} ${tokenOut.symbol} (fee ${quote.lpFeePpm / 10_000}%, impact ${
        quote.priceImpactPpm / 10_000
      }%), minimum ${formatUnits(
        plan.minimumAmountOut,
        tokenOut.decimals,
      )}, approvals needed: ${
        plan.approvals.map(step => step.kind).join(', ') || 'none'
      }`,
    )
    const result = await executeSwap({
      reader: provider,
      wallet,
      deployment,
      plan,
      account,
      onProgress: progress => console.log('progress', JSON.stringify(progress)),
      onSigned: async signed =>
        console.log(
          `signed and journaled before broadcast: ${signed.operationId} ${signed.txHash}`,
        ),
    })
    console.log(
      'result',
      JSON.stringify(result, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    )
    if (result.status === 'confirmed' && result.amountOut !== undefined)
      console.log(
        `received from receipt: ${formatUnits(
          result.amountOut,
          tokenOut.decimals,
        )} ${tokenOut.symbol}; network fee paid ${formatUnits(
          result.feeWei,
          18,
        )}`,
      )
    console.log(
      `after:  ${show(await readTokenBalances(provider, deployment, account))}`,
    )
    console.log(
      'journal:',
      journal
        .list()
        .map(
          row =>
            `${row.operationId} ${row.kind} ${row.members
              .map(m => m.observation.state)
              .join('/')}`,
        )
        .join('; '),
    )
  } finally {
    await consolidator.stopReobservation()
    await journal.Close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
