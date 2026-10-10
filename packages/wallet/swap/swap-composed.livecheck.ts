/**
 * One real swap on Monad testnet through the composed EVM wallet handle, the object the app
 * holds: its wallet queue, input admission, on-disk journals, and a provider that reaches the
 * chain only through a relay's RPC gateway. It spends testnet funds. Never point it at mainnet.
 *
 * Needs a running relay (`backend/cashweb/run-local-monad.sh`).
 *
 *   SWAP_LIVECHECK_RELAY_URL=http://127.0.0.1:<port> \
 *   SWAP_LIVECHECK_WALLET_DIR=/path/outside/the/repo \
 *   TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx \
 *     packages/wallet/swap/swap-composed.livecheck.ts [<FROM> <TO> <amount> [slippageBps]]
 *
 * `SWAP_LIVECHECK_WALLET_DIR` holds the wallet's roots (created when missing, mode 600, never
 * printed) and its state. With no swap arguments it prints the wallet's main and identity
 * addresses and balances and stops: fund them and run again. When the main account cannot pay
 * for the swap alone, the amount the wallet's other accounts must first move into it is printed
 * and then moved, once, as the app does after the user confirms it on the review card.
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { formatUnits, parseUnits } from 'ethers'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'
import type { MonadRootBundle } from '../chain/active-chain'
import { getEvmDexDeployment } from '../chain/dex-deployments'
import { createEvmChain } from '../chain/monad-chain'
import { registerMonadIdentity } from '../monad-identity'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { readTokenBalances } from './evm-swap'
import type { SwapWallet } from './swap-execution'
import { findToken } from './uniswap-v4'
import { UniswapV4Dex } from './uniswap-v4-dex'

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
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: Uint8Array.from(Buffer.from(stored[purpose]!, 'hex')),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

async function main(): Promise<void> {
  const relayBaseUrl = process.env.SWAP_LIVECHECK_RELAY_URL
  const dir = process.env.SWAP_LIVECHECK_WALLET_DIR
  if (!relayBaseUrl || !dir)
    throw new Error(
      'Set SWAP_LIVECHECK_RELAY_URL and SWAP_LIVECHECK_WALLET_DIR',
    )
  const [fromSymbol, toSymbol, amount, slippage = '100'] = process.argv.slice(2)
  const chainIdentifier = 'monad-testnet'
  const deployment = getEvmDexDeployment(chainIdentifier)!
  const wallet = (await createEvmChain({
    networkId: 'monad-testnet',
    chainIdentifier: 'monad-testnet',
    chainId: 10143,
    rpcChain: 'monad-testnet',
    relayBaseUrl,
    networkTag: 'MONT',
    stampBurnAddress:
      process.env.MONAD_STAMP_BURN_ADDRESS ??
      '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: 10n ** 16n,
    defaultTopicVoteValueWei: 10n ** 12n,
    subAccountPoolSize: 2,
    walletStorageLocation: join(dir, 'state'),
  }).createWallet(loadRoots(dir))) as EvmChainWalletHandle
  try {
    // The relay's RPC gateway serves only identities it knows: publish this one, as a bot does.
    await registerMonadIdentity({
      relayBaseUrl,
      identity: wallet.identity,
      profile: { name: 'swap livecheck' },
    })
    const reader = wallet.evmReader!
    const account = (await wallet.getReceiveAddress()).raw
    const show = (balances: bigint[]) =>
      deployment.tokens
        .map((t, i) => `${formatUnits(balances[i]!, t.decimals)} ${t.symbol}`)
        .join(', ')
    const funds = async () => {
      const f = await wallet.getContractCallFunds!()
      return `main ${formatUnits(
        f.mainBalance,
        18,
      )} MON, other accounts ${formatUnits(f.otherBalance, 18)} MON, busy ${
        f.mainBusy
      }`
    }
    console.log(
      `chain id via the relay gateway: ${
        (await wallet.provider.getNetwork()).chainId
      }`,
    )
    console.log(`main account ${account}`)
    console.log(`identity account ${wallet.identity.address.raw}`)
    console.log(
      `main holds: ${show(
        await readTokenBalances(reader, deployment, account),
      )}`,
    )
    console.log(`wallet: ${await funds()}`)
    if (!fromSymbol || !toSymbol || !amount) return

    const tokenIn = findToken(deployment, fromSymbol)
    const tokenOut = findToken(deployment, toSymbol)
    if (!tokenIn || !tokenOut) throw new Error('Unknown token')
    const swapWallet: SwapWallet = {
      sendContractCall: params => wallet.sendContractCall!(params),
      getContractCallFunds: () => wallet.getContractCallFunds!(),
      fundMainAccount: params => wallet.fundMainAccount!(params),
      estimateLegacyFee: params => wallet.estimateLegacyFee!(params),
      resumeLegacySend: id => wallet.resumeLegacySend!(id),
      resumeNativeOperation: id => wallet.resumeNativeOperation!(id),
      getUnresolvedContractCalls: () => wallet.getUnresolvedContractCalls!(),
      reobserveNativeOperations: () => wallet.reobserveNativeOperations!(),
    }
    // The adapter class, given the wallet as its narrow interface, as the app composes it.
    const dex = new UniswapV4Dex(chainIdentifier, deployment, {
      reader,
      ...swapWallet,
      sendContractCall: ({ record, ...call }) => {
        if (record)
          console.log(
            `record handed to the contract send: ${JSON.stringify(
              record,
              (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
            )}`,
          )
        return swapWallet.sendContractCall(call)
      },
    })
    const quote = await dex.quote({
      tokenIn,
      tokenOut,
      amountIn: parseUnits(amount, tokenIn.decimals),
    })
    const plan = await dex.plan({
      quote,
      slippageBps: Number(slippage),
      account,
    })
    const first = await dex.cost({ plan, account })
    const need = await dex.consolidation({ plan, swapFee: first.swapFee })
    const cost = await dex.cost({ plan, account, moveWei: need.moveWei })
    console.log(
      `quote: ${amount} ${tokenIn.symbol} -> ${formatUnits(
        quote.amountOut,
        tokenOut.decimals,
      )} ${tokenOut.symbol}, minimum ${formatUnits(
        plan.minimumAmountOut,
        tokenOut.decimals,
      )}; approvals: ${plan.approvals.map(s => s.kind).join(', ') || 'none'}`,
    )
    console.log(
      `network fee as the form shows it: ${formatUnits(
        cost.networkFeeWei,
        18,
      )} MON over ${cost.transactions.length} transaction(s), complete ${
        cost.complete
      }; swap gas limit ${cost.swapFee?.gasLimit ?? 'n/a'}`,
    )
    console.log(
      need.moveWei > 0n
        ? `to be moved into the main account first: ${formatUnits(
            need.moveWei,
            18,
          )} MON (possible: ${need.possible})`
        : 'the main account can pay by itself: nothing is moved',
    )
    if (!need.possible) throw new Error('The wallet cannot cover this swap')
    const result = await dex.execute({
      plan,
      account,
      consolidateWei: need.moveWei,
      onProgress: progress => console.log('progress', JSON.stringify(progress)),
    })
    console.log(
      'result',
      JSON.stringify(result, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    )
    console.log(
      `main holds: ${show(
        await readTokenBalances(reader, deployment, account),
      )}`,
    )
    console.log(`wallet: ${await funds()}`)
    console.log(
      'operations:',
      wallet.getNativeOperations!()
        .map(
          row =>
            `${row.operationId} ${row.kind} ${row.members
              .map(
                m =>
                  `${m.source.kind}:${m.observation.state}:${
                    m.signed?.transactionHash ?? '-'
                  }`,
              )
              .join(' | ')}`,
        )
        .join('\n  '),
    )
  } finally {
    await wallet.close()
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(1)
  },
)
