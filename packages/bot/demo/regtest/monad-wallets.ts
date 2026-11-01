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
import { closeSync, lstatSync, openSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'

import { Wallet } from 'ethers'

import { DEMO_DEFAULT_BURN_ADDRESS } from '../demo-config'
import { findWallets, TRANSFER_GAS } from '../funds'
import { openRealWallet, RealWallet, type SweepOutcome } from '../real-stack'
import { describeRanges, followTransfers, notTheWallets, type ReachBlock } from './chain-reach'
import { MONAD_REGTEST_CHAIN, MONAD_REGTEST_CHAIN_ID, MONAD_REGTEST_NETWORK_TAG, MonadRegtest } from './monad-regtest'
import type { RegtestStack } from './regtest-stack'
import { deployContracts, type DeploymentRecord } from '../../../contracts/scripts/deploy'

export function monadOf(stack: RegtestStack): MonadRegtest {
  const chain = stack.chains[MONAD_REGTEST_CHAIN]
  if (!chain) throw new Error("this stack has no Monad network: startRegtestStack({ chains: ['monad-regtest'] })")
  return chain as MonadRegtest
}

/** One setup-only faucet obligation. This public record is not a wallet payment journal.
 * A retained/partial record blocks re-running setup after an unknown acknowledgement. */
export async function fundWithPublicIntent(
  stack: RegtestStack,
  wallet: Pick<RealWallet, 'label' | 'mainAccount'>,
  amountWei: bigint,
  intentPath: string,
): Promise<string> {
  if (!isAbsolute(intentPath) || dirname(resolve(intentPath)) !== dirname(resolve(stack.stateDir)) ||
      !/^[a-z0-9_-]+$/i.test(wallet.label) || amountWei <= 0n)
    throw new Error('setup funding requires an absolute original-run sibling intent and a positive amount')
  const keyFile = lstatSync(join(stack.stateDir, 'wallets', wallet.label, 'account-root.hex'))
  if (!keyFile.isFile() || keyFile.size === 0)
    throw new Error('setup wallet keys must already exist in their original state')
  const monad = monadOf(stack)
  const [chainId, block, checkpoint, latest, pending] = await Promise.all([
    monad.provider.send('eth_chainId', []),
    monad.provider.getBlock('latest'),
    monad.provider.getBlock(monad.checkpoint.height),
    monad.provider.getTransactionCount(monad.faucetAddress, 'latest'),
    monad.provider.getTransactionCount(monad.faucetAddress, 'pending'),
  ])
  if (BigInt(chainId) !== MONAD_REGTEST_CHAIN_ID || !block?.hash ||
      checkpoint?.hash?.toLowerCase() !== monad.checkpoint.hash.toLowerCase() ||
      !Number.isSafeInteger(latest) || latest < 0 || latest !== pending)
    throw new Error('setup chain/checkpoint or exclusive faucet nonce baseline is not verified')
  const intent = {
    version: 1, phase: 'prepared', chainIdentifier: monad.chainIdentifier,
    nativeChainId: MONAD_REGTEST_CHAIN_ID.toString(), rpcUrl: monad.rpcUrl,
    checkpoint: monad.checkpoint, stateDir: resolve(stack.stateDir),
    recipient: wallet.mainAccount, amountWei: amountWei.toString(),
    faucet: monad.faucetAddress, faucetNonce: { latest, pending },
    baselineBlock: { number: block.number, hash: block.hash },
  }
  // Reserve the final name atomically. A partial/failed record is retained and fails closed.
  // Never infer permission to fund again from an empty file, missing receipt or low balance.
  closeSync(openSync(intentPath, 'wx', 0o600))
  const { writeDurably } = await import('./solonet-keys')
  writeDurably(intentPath, `${JSON.stringify(intent, null, 2)}\n`)
  const transactionHash = await monad.fund(wallet.mainAccount, amountWei)
  writeDurably(intentPath, `${JSON.stringify({ ...intent, phase: 'confirmed', transactionHash }, null, 2)}\n`)
  return transactionHash
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
 * Ticks `wallet` the way the app and the bot host do (`reconcileAttempts` drives every unfinished
 * message one step), until every transaction of its own sets is on the chain. On Monad the change
 * behind a delivered message's payments goes out only on later ticks, and until it lands a small
 * wallet's next paid send is refused with `FundsInPendingSendError` (owner ruling 2026-10-26: a
 * send is refused, never queued). A check that sends again after a paid message ticks first.
 */
export async function tickUntilSettled(wallet: RealWallet, timeoutMs = 180_000): Promise<number> {
  const startedAt = Date.now()
  for (let ticks = 1; ; ticks++) {
    await wallet.chain.directMessages.reconcileAttempts({ wallet: wallet.handle, payloadDigests: [] })
    const open = (wallet.handle.getNativeOperations?.() ?? []).filter(
      row =>
        row.kind === 'transaction-set' &&
        !row.cancelled &&
        row.members.some(
          member =>
            member.signed !== null &&
            member.observation.state !== 'included-success' &&
            member.observation.state !== 'included-revert',
        ),
    )
    if (open.length === 0) return ticks
    if (Date.now() - startedAt > timeoutMs)
      throw new Error(
        `${wallet.label}'s own transactions were not all on the chain after ${ticks} ticks (${open.map(row => row.operationId).join(', ')})`,
      )
    await new Promise(resolveTick => setTimeout(resolveTick, 2000))
  }
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
 * accounts, found and derived the way `findWallets` (`funds.ts`) finds them. It first lets the wallets' last
 * transactions settle (Monad refuses to empty an account within a few blocks of its last one),
 * then moves one account at a time. Returns what came back, what stayed (dust or a failure), and
 * how many accounts still hold more than dust (`unswept`). A check calls `stack.fundsReturned()`
 * only when that is 0, so the stack keeps the keys otherwise.
 *
 * The keys found in the state directory are checked against the chain, not trusted: every
 * transaction the found accounts sent since the solonet handle was opened (`startBlock`) is read
 * block by block, and so are the transactions of every account those reached. A reached account
 * that is none of the found ones (a coin the wallet holds whose key `findWallets` does not see)
 * and holds more than dust afterwards counts in `unswept` and is named: the stack then keeps the
 * wallets' state, from which the wallet itself can still spend it. So does each block range the
 * node no longer has. The faucet, the burn address, the relays' group-write payee and `payees`
 * are not the wallets' and are not counted.
 */
export async function returnToFaucet(
  stack: RegtestStack,
  payees: Iterable<string> = [],
): Promise<{ returnedWei: bigint; leftWei: bigint; unswept: number; left: SweepOutcome['left'] }> {
  const monad = monadOf(stack)
  await monad.mine(4)
  const gasPrice = BigInt(await monad.provider.send('eth_gasPrice', []))
  const fee = TRANSFER_GAS * gasPrice
  let returnedWei = 0n
  let leftWei = 0n
  let unswept = 0
  const left: SweepOutcome['left'] = []
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
        if (held > 0n) left.push({ wallet: wallet.path, account: account.role, address, balanceWei: held, reason: 'below economical return fee' })
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
        else {
          leftWei += held
          unswept += 1
          left.push({ wallet: wallet.path, account: account.role, address, balanceWei: held, reason: 'return receipt did not succeed' })
        }
      } catch {
        leftWei += held
        unswept += 1
        left.push({ wallet: wallet.path, account: account.role, address, balanceWei: held, reason: 'return outcome unresolved' })
      }
    }
  const { missed, missing } = await accountsOutsideTheKeys(monad, seen, fee * 2n, payees)
  for (const { address, held } of missed) {
    leftWei += held
    unswept += 1
    left.push({ wallet: stack.stateDir, account: 'unknown account', address, balanceWei: held, reason: 'key not found in original state' })
    console.warn(`[regtest] ${address} received money from the wallets and holds ${held} wei, but its key is not among those found: the stack's state is kept`)
  }
  if (missing.length > 0) {
    unswept += missing.length
    console.warn(`[regtest] the node no longer has ${describeRanges(missing)}, so where the wallets' money went there is unknown: the stack's state is kept`)
  }
  return { returnedWei, leftWei, unswept, left }
}

/**
 * Check the keys a sweep found against the chain: every account the `found` accounts' transactions
 * reached since `monad.startBlock`, followed through the accounts reached in turn, that is not
 * itself found and holds more than `dust` now (`missed`), and the block ranges the node no longer
 * has (`missing`). A check that ran longer than solonet's history window cannot tell where its
 * wallets' money went in those blocks, so a caller counts each missing range as unswept and keeps
 * the stack. The faucet, the burn address, the relays' group-write payee and `payees` are not the
 * wallets' (`notTheWallets`).
 */
export async function accountsOutsideTheKeys(
  monad: MonadRegtest,
  found: Set<string>,
  dust: bigint,
  payees: Iterable<string> = [],
): Promise<{ missed: { address: string; held: bigint }[]; missing: Array<[number, number]> }> {
  const head = await monad.provider.getBlockNumber()
  const numbers = Array.from({ length: head - monad.startBlock + 1 }, (_, i) => monad.startBlock + i)
  const blocks: ReachBlock[] = []
  for (let at = 0; at < numbers.length; at += 16) {
    const batch = numbers.slice(at, at + 16)
    const read = await Promise.all(batch.map(n => monad.provider.send('eth_getBlockByNumber', [`0x${n.toString(16)}`, true])))
    batch.forEach((number, i) => blocks.push({ number, block: read[i] ?? null }))
  }
  const { reached, missing } = followTransfers(
    blocks,
    found,
    notTheWallets(monad.faucetAddress, DEMO_DEFAULT_BURN_ADDRESS, payees),
  )
  const missed: { address: string; held: bigint }[] = []
  for (const address of reached) {
    const held = await monad.provider.getBalance(address)
    if (held > dust) missed.push({ address, held })
  }
  console.log(
    `[regtest] the wallets' transactions since block ${monad.startBlock} reached ${reached.size} accounts outside the ${found.size} found keys; ${missed.length} of those hold more than dust${
      missing.length ? `; the node no longer has ${describeRanges(missing)}` : ''
    }`,
  )
  return { missed, missing }
}
