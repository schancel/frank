/**
 * Wallets and contracts on a regtest stack that has the Monad network (monad-regtest.ts).
 *
 *   const stack = await startRegtestStack({ chains: ['monad-regtest'] })
 *   const monad = monadOf(stack)
 *   const alice = await openMonadWallet(stack, 'alice')        // keys, directory entry, profile
 *   await monad.fund(alice.mainAccount, 50n * 10n ** 18n)      // from the faucet: free
 *   const digest = await alice.send(bob.address, [{ type: 'text', text: 'hi' }], stampWei)
 *   const contracts = await deployMonadContracts(stack)        // GenericHTLC and StateChannel
 *
 * The wallet is the one the testnet harness opens (`openRealWallet` in ../real-stack.ts), on the
 * `monad-regtest` network: it reads and sends through the relay, never straight to the chain.
 */
import { join, resolve } from 'path'

import { openRealWallet, RealWallet } from '../real-stack'
import { MONAD_REGTEST_CHAIN, MONAD_REGTEST_NETWORK_TAG, MonadRegtest } from './monad-regtest'
import type { RegtestStack } from './regtest-stack'
import { deployContracts, type DeploymentRecord } from '../../../contracts/scripts/deploy'

export function monadOf(stack: RegtestStack): MonadRegtest {
  const chain = stack.chains[MONAD_REGTEST_CHAIN]
  if (!chain) throw new Error("this stack has no Monad network: startRegtestStack({ chains: ['monad-regtest'] })")
  return chain as MonadRegtest
}

/** A new account on the stack's relay. Its state is in the stack's directory and goes with it. */
export function openMonadWallet(
  stack: RegtestStack,
  label: string,
  options: {
    stampValueWei?: bigint
    /** The record `deployMonadContracts` returned, so the wallet finds this run's contracts. */
    contracts?: DeploymentRecord
  } = {},
): Promise<RealWallet> {
  monadOf(stack)
  return openRealWallet({
    label,
    relayUrl: stack.relayUrl,
    stateDir: stack.stateDir,
    stampValueWei: options.stampValueWei,
    network: {
      rpcChain: MONAD_REGTEST_CHAIN,
      networkTag: MONAD_REGTEST_NETWORK_TAG,
      ...(options.contracts
        ? {
            contracts: {
              stateChannel: options.contracts.contracts.StateChannel.address,
              htlc: options.contracts.contracts.GenericHTLC.address,
            },
          }
        : {}),
    },
  })
}

/**
 * Deploys GenericHTLC and StateChannel to the solonet from the faucet and returns the record,
 * which is also written to `<stack state>/deployments/monad-regtest.json`. The record belongs to
 * this chain only and is never committed. A solonet that already has the contracts (an earlier
 * check deployed them through the deterministic proxy) is recorded again, not deployed twice.
 */
export async function deployMonadContracts(stack: RegtestStack): Promise<DeploymentRecord> {
  const monad = monadOf(stack)
  return deployContracts({
    signer: monad.faucet,
    chainIdentifier: MONAD_REGTEST_CHAIN,
    outDir: resolve(join(stack.stateDir, 'deployments')),
  })
}
