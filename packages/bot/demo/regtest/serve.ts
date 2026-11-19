/**
 * Keeps a local regtest stack running for the app, until Ctrl-C.
 *
 *   LOTUSD_BIN=<lotus>/daemon/.build/v2-current/lotusd yarn --cwd packages/bot regtest:serve
 *
 * Starts the networks in FRANK_REGTEST_CHAINS (default `monad-regtest,lotus-v2-regtest`: solonet
 * for identity, messages and stamps, and a Lotus v2 `lotusd -regtest` for the main balance) and
 * the real relay on them (regtest-stack.ts), then prints the app command, with
 * QCLI_FRANK_BASE_CHAIN=lotus-v2-regtest when Lotus runs, and the faucet command:
 *
 *   yarn --cwd packages/bot regtest:lotus-fund <stack directory> <rxpi1... address> <XPI>
 *
 * The stack directory (printed; it holds `stack.json` with the node's local addresses) and its
 * chains are this run's only: Ctrl-C stops everything and removes it, as regtest-stack.ts says
 * (solonet keys are kept first). Nothing here reaches a public network.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { faucetPay, LOTUS_REGTEST_CHAIN, type LotusRegtest } from './lotus-regtest'
import { startRegtestStack } from './regtest-stack'

const ATOMS_PER_XPI = 1_000_000n
const BURN = '0x000000000000000000000000000000000000dEaD'
type Chain = 'xec-regtest' | 'monad-regtest' | 'lotus-v2-regtest'
const KNOWN: readonly Chain[] = ['xec-regtest', 'monad-regtest', 'lotus-v2-regtest']

function xpiAtoms(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim())
  if (!match) throw new Error(`not an XPI amount: ${text}`)
  return BigInt(match[1]!) * ATOMS_PER_XPI + BigInt((match[2] ?? '').padEnd(6, '0') || '0')
}

async function serve() {
  const chains = (process.env.FRANK_REGTEST_CHAINS ?? 'monad-regtest,lotus-v2-regtest')
    .split(',')
    .map(chain => chain.trim())
    .filter(Boolean)
  for (const chain of chains)
    if (!KNOWN.includes(chain as Chain))
      throw new Error(`unknown regtest network ${chain}; known: ${KNOWN.join(', ')}`)
  const stack = await startRegtestStack({ chains: chains as Chain[] })
  const lotus = stack.chains[LOTUS_REGTEST_CHAIN] as LotusRegtest | undefined
  writeFileSync(
    join(stack.stateDir, 'stack.json'),
    JSON.stringify(
      {
        relayUrl: stack.relayUrl,
        ...(lotus ? { lotus: { rpcUrl: lotus.rpcUrl, chronikUrl: lotus.chronikUrl } } : {}),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  const messaging = chains.includes('monad-regtest') ? 'monad-regtest' : undefined
  console.log(`
The regtest stack is running (Ctrl-C stops it). Relay: ${stack.relayUrl}
Networks: ${chains.join(', ')}. State: ${stack.stateDir}

App (another terminal, from the repository root; once per checkout: yarn install and
yarn --cwd app prepare:packages). The dev server is http://localhost:8080:

  cd app && QCLI_MONAD_RELAY_BASE_URL=${stack.relayUrl}${messaging ? ` QCLI_MONAD_RPC_CHAIN=${messaging}` : ''} \\
    QCLI_MONAD_STAMP_BURN_ADDRESS=${BURN}${lotus ? ` QCLI_FRANK_BASE_CHAIN=${LOTUS_REGTEST_CHAIN}` : ''} \\
    yarn dev:browser
${
  lotus
    ? `
Pay an app account's Lotus main balance (its rxpi1... address is on the Wallet page):

  yarn --cwd packages/bot regtest:lotus-fund ${stack.stateDir} <rxpi1... address> 100
`
    : ''
}${messaging ? `\nMonad (stamps): yarn --cwd packages/bot regtest:monad-fund <0x address> 20\n` : ''}`)
  await new Promise(() => undefined)
}

async function fund(args: string[]) {
  const [stateDir, address, amount] = args
  if (!stateDir || !address || !amount)
    throw new Error('usage: regtest:lotus-fund <stack directory> <rxpi1... address> <XPI>')
  const { lotus } = JSON.parse(readFileSync(join(stateDir, 'stack.json'), 'utf8')) as {
    lotus?: { rpcUrl: string; chronikUrl: string }
  }
  if (!lotus) throw new Error(`the stack in ${stateDir} runs no ${LOTUS_REGTEST_CHAIN}`)
  const txid = await faucetPay(lotus, address, xpiAtoms(amount))
  console.log(`paid ${amount} XPI to ${address} in ${txid} (mined)`)
}

const [command, ...rest] = process.argv.slice(2)
;(command === 'fund' ? fund(rest) : serve()).catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
