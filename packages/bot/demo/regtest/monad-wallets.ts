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

import { Wallet } from 'ethers'

import { findWallets, TRANSFER_GAS } from '../funds'
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

/**
 * Sends everything the stack's wallets hold back to the faucet, so a check leaves nothing in
 * accounts whose keys go with the stack's directory: each wallet's main, identity and change
 * accounts, found and derived the way `funds:sweep` finds them. It first lets the wallets' last
 * transactions settle (Monad refuses to empty an account within a few blocks of its last one),
 * then moves one account at a time. Returns what came back and what stayed (dust or a failure).
 */
export async function returnToFaucet(
  stack: RegtestStack,
): Promise<{ returnedWei: bigint; leftWei: bigint }> {
  const monad = monadOf(stack)
  await monad.mine(4)
  const gasPrice = BigInt(await monad.provider.send('eth_gasPrice', []))
  const fee = TRANSFER_GAS * gasPrice
  let returnedWei = 0n
  let leftWei = 0n
  const seen = new Set<string>()
  for (const wallet of await findWallets(stack.stateDir))
    for (const account of wallet.accounts) {
      const address = account.address.toLowerCase()
      if (!account.privateKey || seen.has(address)) continue
      seen.add(address)
      const held = await monad.provider.getBalance(address)
      // Not worth a transfer that costs about what it returns.
      if (held <= fee * 2n) {
        leftWei += held
        continue
      }
      // One account that cannot be swept (a payment still in flight, a timeout) leaves the rest
      // to be swept.
      try {
        const signer = new Wallet(account.privateKey, monad.provider)
        const tx = await signer.sendTransaction({
          type: 0,
          to: monad.faucetAddress,
          value: held - fee,
          gasLimit: TRANSFER_GAS,
          gasPrice,
        })
        const receipt = await tx.wait(1, 120_000)
        if (receipt?.status === 1) returnedWei += held - fee
        else leftWei += held
      } catch {
        leftWei += held
      }
    }
  return { returnedWei, leftWei }
}
