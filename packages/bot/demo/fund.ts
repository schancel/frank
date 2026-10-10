/**
 * Sends testnet MON from the funding wallet to one address, on the real chain, and waits for it:
 *
 *   TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx packages/bot/demo/fund.ts <address> <MON>
 *
 * For scripts that need a funded account (the browser checks fund the account they created). The
 * RPC URL and wallet come from the environment or `.env` as in `real-stack.ts`; transfers are
 * serialised with every other user of the funding wallet. Prints the transaction hash.
 */
import { isAddress, parseEther } from 'ethers'

import { fundFromWallet, realStackEnv } from './real-stack'

async function main(argv: string[]): Promise<void> {
  const [to, amount] = argv
  if (argv.length !== 2 || !isAddress(to) || !/^[0-9]+(\.[0-9]+)?$/.test(amount)) {
    throw new Error('Usage: fund.ts <0x address> <amount in MON, e.g. 0.2>')
  }
  const env = realStackEnv()
  if (!env.MONAD_TESTNET_HTTP_RPC_URL || !env.E2E_DEMO_MAIN_WALLET_JSON) {
    throw new Error('MONAD_TESTNET_HTTP_RPC_URL and E2E_DEMO_MAIN_WALLET_JSON are required (environment or .env)')
  }
  const { txHash, from } = await fundFromWallet({
    rpcUrl: env.MONAD_TESTNET_HTTP_RPC_URL,
    walletJsonPath: env.E2E_DEMO_MAIN_WALLET_JSON,
    to,
    valueWei: parseEther(amount),
  })
  console.log(`sent ${amount} MON from ${from} to ${to}: ${txHash}`)
}

main(process.argv.slice(2)).catch(err => {
  console.error(err instanceof Error ? err.message : 'funding failed')
  process.exit(1)
})
