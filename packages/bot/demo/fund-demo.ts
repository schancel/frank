/** Operator entrypoint. Deliberately accepts no RPC URL, amount, wallet file, or key. */
import { ensureDemoBalance } from './demo-funding'

export async function fundDemo(argv: string[]): Promise<void> {
  if (argv.length !== 4 || argv[0] !== '--fake-chain' || argv[1] !== '--port') {
    throw new Error(
      'Usage: fund-demo.ts --fake-chain --port <fake RPC port> <EVM receive address>',
    )
  }
  const result = await ensureDemoBalance(
    { fakeChain: true, rpcUrl: `http://127.0.0.1:${argv[2]}` },
    argv[3],
  )
  console.log(`Simulated ledger credit only: ${JSON.stringify(result)}`)
}

if (require.main === module) {
  fundDemo(process.argv.slice(2)).catch(error => {
    console.error(
      error instanceof Error ? error.message : 'Simulated funding failed',
    )
    process.exitCode = 1
  })
}
