// THROWAWAY spike script. Prints the chain wallet's live balance on Monad
// testnet via the real Alchemy RPC endpoint. Run: npx tsx spike/check-balance.ts
import fs from 'node:fs'
import path from 'node:path'
import { JsonRpcProvider, formatEther } from 'ethers'
import { requireEnv, ENV_SOURCE } from './lib/env'

async function main() {
  const rpcUrl = requireEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const walletPath = path.resolve(__dirname, 'data/chain-wallet.json')
  if (!fs.existsSync(walletPath)) {
    console.error('No chain wallet found. Run: npx tsx spike/keygen.ts')
    process.exit(1)
  }
  const { address } = JSON.parse(fs.readFileSync(walletPath, 'utf8'))

  console.log('env loaded from:', ENV_SOURCE)
  console.log('RPC:', rpcUrl.replace(/\/v2\/.*/, '/v2/<redacted>'))
  console.log('wallet address:', address)

  const provider = new JsonRpcProvider(rpcUrl)
  const network = await provider.getNetwork()
  console.log('connected chainId:', network.chainId.toString())

  const balance = await provider.getBalance(address)
  console.log('balance (wei):', balance.toString())
  console.log('balance (MON):', formatEther(balance))

  if (balance === 0n) {
    console.log(
      '\n>>> Balance is zero. Fund this address with testnet MON before running spike/sender.ts <<<',
    )
  } else {
    console.log('\nFunded. Ready to run spike/sender.ts')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
