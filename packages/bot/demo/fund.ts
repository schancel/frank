/**
 * Sends testnet MON from the TEST wallet (FRANK_TEST_WALLET_JSON) to one address, on the real
 * chain, and waits for it:
 *
 *   TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx packages/bot/demo/fund.ts <address> <MON>
 *
 * For scripts that need a funded account (the browser checks fund the account they created). It
 * never spends from the demo's funding wallet and refuses when FRANK_TEST_WALLET_JSON is unset:
 * the demo's bot host is the only spender of E2E_DEMO_MAIN_WALLET_JSON. One call sends at most
 * 0.5 MON unless FRANK_TEST_MAX_FUND_WEI says otherwise. Transfers are serialised with every
 * other user of the test wallet. Prints the transaction hash. `fund.ts --info` prints the test
 * wallet's address and the float a persistent test account keeps, as JSON, and sends nothing.
 */
import { readFileSync } from 'fs'

import { getAddress, isAddress, parseEther } from 'ethers'

import { TEST_ACCOUNT_FLOAT_WEI, fundFromWallet, realStackEnv } from './real-stack'

async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === '--info') {
    // For a script that sends its leftover back: the test wallet's address and the float a
    // persistent test account keeps (the one constant, in real-stack.ts). Sends nothing.
    const path = realStackEnv().FRANK_TEST_WALLET_JSON
    if (!path) throw new Error('FRANK_TEST_WALLET_JSON is not set')
    const address = getAddress((JSON.parse(readFileSync(path, 'utf8')) as { address: string }).address)
    console.log(JSON.stringify({ address, floatWei: TEST_ACCOUNT_FLOAT_WEI.toString() }))
    return
  }
  const [to, amount] = argv
  if (argv.length !== 2 || !isAddress(to) || !/^[0-9]+(\.[0-9]+)?$/.test(amount)) {
    throw new Error('Usage: fund.ts <0x address> <amount in MON, e.g. 0.2>')
  }
  const env = realStackEnv()
  const walletJsonPath = env.FRANK_TEST_WALLET_JSON
  if (!env.MONAD_TESTNET_HTTP_RPC_URL || !walletJsonPath) {
    throw new Error(
      'MONAD_TESTNET_HTTP_RPC_URL and FRANK_TEST_WALLET_JSON are required (environment or .env). FRANK_TEST_WALLET_JSON is a funded testnet wallet used only by tests; the demo funding wallet is never used for this.',
    )
  }
  const { txHash, from } = await fundFromWallet({
    rpcUrl: env.MONAD_TESTNET_HTTP_RPC_URL,
    walletJsonPath,
    to,
    valueWei: parseEther(amount),
    maxWei: env.FRANK_TEST_MAX_FUND_WEI ? BigInt(env.FRANK_TEST_MAX_FUND_WEI) : undefined,
  })
  console.log(`sent ${amount} MON from ${from} to ${to}: ${txHash}`)
}

main(process.argv.slice(2)).catch(err => {
  console.error(err instanceof Error ? err.message : 'funding failed')
  process.exit(1)
})
