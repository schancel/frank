/**
 * Proves a recorded GenericHTLC deployment works, with dust: locks and withdraws with the
 * preimage (and reads the preimage back from the lock), then locks with a short absolute
 * deadline and refunds once the chain's clock reaches it. Both locks pay the
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
import { confirmedSender, resolveCliTarget, type DeploymentRecord } from './deploy'

const NATIVE = ethers.ZeroAddress
/** GenericHTLC `State`: 0 none, 1 open, 2 withdrawn, 3 refunded. */
const WITHDRAWN = 2n
const REFUNDED = 3n

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

  // State is read at the block of the transaction that changed it: a node can still answer
  // from before that transaction for a moment.
  const confirmed = confirmedSender(signer)
  const send = async (
    label: string,
    method: string,
    args: unknown[],
    value?: bigint,
  ): Promise<ethers.TransactionReceipt> => {
    const request = await htlc[method].populateTransaction(...args, {
      ...(value === undefined ? {} : { value }),
    })
    const receipt = await confirmed(request)
    log(`${label}: ${receipt.hash}`)
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

  // A lock's deadline is absolute and judged by the chain's clock, not this machine's.
  const chainNow = async () => BigInt((await provider.getBlock('latest'))!.timestamp)
  const openLock = async (label: string, expiresAt: bigint) => {
    const terms = [self, self, NATIVE, amount, hashLock, expiresAt] as const
    const lockId: string = await htlc.lockIdOf(self, ...terms)
    const receipt = await send(label, 'lock', [...terms], amount)
    return { lockId, receipt }
  }

  const first = await openLock('lock', (await chainNow()) + 3600n)
  const withdraw = await send('withdraw', 'withdraw', [first.lockId, preimage])
  const withdrawn = await lockAt(first.lockId, withdraw)
  if (withdrawn.state !== WITHDRAWN || withdrawn.preimage !== preimage) {
    throw new Error(`lock ${first.lockId} is not withdrawn with its preimage`)
  }

  // Far enough ahead that the lock transaction is mined before the deadline.
  const shortExpiresAt = (await chainNow()) + BigInt(refundAfter) + 5n
  const second = await openLock('lock (short deadline)', shortExpiresAt)
  const shortLock = second.receipt
  // A refund before the deadline must be refused by the deployed contract.
  const lockBlock = await provider.getBlock(shortLock.blockNumber)
  if (BigInt(lockBlock!.timestamp) < shortExpiresAt) {
    const early = await htlc.refund
      .staticCall(second.lockId, { blockTag: shortLock.blockNumber })
      .then(
        () => 'accepted',
        () => 'refused',
      )
    if (early !== 'refused') throw new Error('refund before the deadline was not refused')
    log('refund before the deadline: refused')
  }
  // The refund is mined in a later block, whose timestamp must have reached the deadline. A
  // quiet node mines no blocks, so its latest timestamp does not move: wait by this clock, with
  // a margin for the node's clock.
  while (Date.now() / 1000 < Number(shortExpiresAt) + 2) {
    await new Promise(r => setTimeout(r, 1000))
  }
  const refund = await send('refund', 'refund', [second.lockId])
  if ((await lockAt(second.lockId, refund)).state !== REFUNDED) {
    throw new Error(`lock ${second.lockId} is not refunded`)
  }

  const [lockTx, withdrawTx, shortLockTx, refundTx] = [
    first.receipt,
    withdraw,
    shortLock,
    refund,
  ].map(
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
