/**
 * Proves a recorded GenericHTLC deployment works, with dust: locks and withdraws with the
 * preimage, then locks with a short timelock and refunds after it. Both locks pay the
 * sending wallet itself, so the only cost is gas.
 *
 *   yarn --cwd packages/contracts htlc-round --chain monad-testnet --rpc <url> --wallet-json <file>
 *   yarn --cwd packages/contracts htlc-round --local --rpc http://127.0.0.1:8545 --out-dir <dir>
 *
 * Takes the same flags as `deploy` and reads the address from the deployment record.
 */
import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import GenericHTLCArtifact from '../artifacts/GenericHTLC.json'
import { resolveCliTarget, type DeploymentRecord } from './deploy'

const LOCK = 'lock(bytes32,address,address,bytes32,uint256)'

export interface HtlcRoundResult {
  lockTx: string
  withdrawTx: string
  shortLockTx: string
  refundTx: string
}

export async function htlcRound(options: {
  signer: ethers.Signer
  htlcAddress: string
  amount?: bigint
  refundAfterSeconds?: number
  log?: (line: string) => void
}): Promise<HtlcRoundResult> {
  const { signer, htlcAddress } = options
  const amount = options.amount ?? ethers.parseEther('0.0001')
  const refundAfter = options.refundAfterSeconds ?? 5
  const log = options.log ?? (() => undefined)
  const provider = signer.provider!
  const self = await signer.getAddress()
  const htlc = new ethers.Contract(htlcAddress, GenericHTLCArtifact.abi, signer)

  // The nonce is counted here, and state is read at the block of the transaction that
  // changed it: a node can still answer from before that transaction for a moment.
  let nonce = await provider.getTransactionCount(self, 'pending')
  const send = async (
    label: string,
    method: string,
    args: unknown[],
    value?: bigint,
  ): Promise<ethers.TransactionReceipt> => {
    const sent: ethers.ContractTransactionResponse = await htlc[method](...args, {
      nonce,
      ...(value === undefined ? {} : { value }),
    })
    nonce += 1
    const receipt = await sent.wait()
    if (!receipt || receipt.status !== 1) throw new Error(`${label} ${sent.hash} failed`)
    log(`${label}: ${sent.hash}`)
    return receipt
  }
  const lockAt = async (lockId: string, receipt: ethers.TransactionReceipt) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await htlc.locks(lockId, { blockTag: receipt.blockNumber })
      } catch (err) {
        if (attempt >= 30) throw err
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  }

  const preimage = ethers.hexlify(ethers.randomBytes(32))
  const hashLock = ethers.sha256(preimage)

  const first = ethers.hexlify(ethers.randomBytes(32))
  const lock = await send('lock', LOCK, [first, self, self, hashLock, 3600], amount)
  const withdraw = await send('withdraw', 'withdraw', [first, preimage])
  if ((await lockAt(first, withdraw)).withdrawn !== true) {
    throw new Error(`lock ${first} is not withdrawn`)
  }

  const second = ethers.hexlify(ethers.randomBytes(32))
  const shortLock = await send(
    'lock (short timelock)',
    LOCK,
    [second, self, self, hashLock, refundAfter],
    amount,
  )
  const expiresAt = Number((await lockAt(second, shortLock)).expiresAt)
  // A refund before the timelock must be refused by the deployed contract.
  if (Date.now() / 1000 < expiresAt - 1) {
    const early = await htlc.refund
      .staticCall(second, { blockTag: shortLock.blockNumber })
      .then(
        () => 'accepted',
        () => 'refused',
      )
    if (early !== 'refused') throw new Error('refund before the timelock was not refused')
    log('refund before the timelock: refused')
  }
  while (Date.now() / 1000 < expiresAt + 2) {
    await new Promise(r => setTimeout(r, 1000))
  }
  const refund = await send('refund', 'refund', [second])
  if ((await lockAt(second, refund)).refunded !== true) {
    throw new Error(`lock ${second} is not refunded`)
  }

  const [lockTx, withdrawTx, shortLockTx, refundTx] = [lock, withdraw, shortLock, refund].map(
    receipt => receipt.hash,
  )
  return { lockTx, withdrawTx, shortLockTx, refundTx }
}

async function main(argv: readonly string[]) {
  const target = await resolveCliTarget(argv)
  const recordFile = path.join(target.outDir, `${target.chainIdentifier}.json`)
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as DeploymentRecord
  const htlcAddress = record.contracts.GenericHTLC.address
  const before = await target.provider.getBalance(target.signer.address)
  console.log(`GenericHTLC on ${target.chainIdentifier}: ${htlcAddress}`)
  await htlcRound({ signer: target.signer, htlcAddress, log: line => console.log(line) })
  const after = await target.provider.getBalance(target.signer.address)
  console.log(`Spent on gas: ${ethers.formatEther(before - after)}`)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`HTLC round failed: ${(err as Error).message}`)
    process.exit(1)
  })
}
