import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcProvider, Wallet, Signature, Transaction } from 'ethers'
import { recoveryBit } from '@frank/threshold-ecdsa'
import { buildEvmAdaptorTransfer, requireLoopback } from './native-digests'
import { freshJointKey, hex } from './signing-fixture'

async function main() {
  const url = requireLoopback(process.env.ADAPTOR_MONAD_RPC_URL ?? '')
  const height = Number(process.env.ADAPTOR_MONAD_CHECKPOINT_HEIGHT)
  const hash = process.env.ADAPTOR_MONAD_CHECKPOINT_HASH
  if (
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')
  )
    throw new Error('operator checkpoint required')
  const provider = new JsonRpcProvider(url)
  try {
    if (
      (await provider.getNetwork()).chainId !== 20143n ||
      (await provider.getBlock(height))?.hash !== hash
    )
      throw new Error('solonet identity mismatch')
    const version: string = await provider.send('web3_clientVersion', [])
    if (!/monad/i.test(version)) throw new Error('actual Monad client required')
    // Public local-solonet genesis faucet only; no external wallet or configurable private key.
    const faucet = new Wallet(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      provider
    )
    const joint = freshJointKey(),
      recipient = Wallet.createRandom().address
    const funding = await faucet.sendTransaction({
      to: joint.address,
      value: 10n ** 19n,
    })
    if (!(await funding.wait())?.status) throw new Error('funding failed')
    const before = await provider.getBalance(recipient)
    const fee = await provider.getFeeData()
    const built = buildEvmAdaptorTransfer({
      chainIdentifier: 'monad-regtest',
      chainId: 20143n,
      nonce: 0,
      to: recipient,
      value: 10n ** 15n,
      gasLimit: 21000n,
      maxFeePerGas: fee.maxFeePerGas ?? 100000000000n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n,
    })
    const signed = joint.sign(
      built.digest,
      JSON.stringify({
        chainIdentifier: 'monad-regtest',
        checkpoint: { height, hash },
        sender: joint.address,
        recipient,
        value: built.transaction.value.toString(),
        nonce: 0,
      })
    )
    const yParity = recoveryBit(joint.publicKey, built.digest, signed.completed)
    if (yParity === null) throw new Error('signature parity failed')
    built.transaction.signature = Signature.from({
      r: `0x${hex(signed.completed.subarray(0, 32))}`,
      s: `0x${hex(signed.completed.subarray(32))}`,
      yParity,
    })
    const raw = built.transaction.serialized
    const submitted = await provider.broadcastTransaction(raw)
    let duplicate: unknown
    let duplicateRpcFailed = false
    try {
      duplicate = await provider.send('eth_sendRawTransaction', [raw])
    } catch (error) {
      duplicateRpcFailed = true
      if (!(await provider.getTransaction(submitted.hash))) throw error
    }
    if (!duplicateRpcFailed && duplicate !== submitted.hash)
      throw new Error('duplicate transaction identity changed')
    const receipt = await submitted.wait(2)
    if (
      !receipt ||
      receipt.status !== 1 ||
      receipt.from.toLowerCase() !== joint.address.toLowerCase() ||
      receipt.to !== recipient
    )
      throw new Error('receipt intent mismatch')
    const observed = await provider.getTransaction(submitted.hash)
    if (
      !observed ||
      observed.from.toLowerCase() !== joint.address.toLowerCase() ||
      observed.to !== recipient ||
      observed.value !== built.transaction.value ||
      observed.nonce !== 0 ||
      observed.chainId !== 20143n ||
      observed.data !== '0x'
    )
      throw new Error('transaction intent mismatch')
    const parsed = Transaction.from({
      type: 2,
      chainId: observed.chainId,
      nonce: observed.nonce,
      to: observed.to,
      value: observed.value,
      data: observed.data,
      accessList: observed.accessList,
      gasLimit: observed.gasLimit,
      maxFeePerGas: observed.maxFeePerGas,
      maxPriorityFeePerGas: observed.maxPriorityFeePerGas,
    })
    const extraction = signed.observe(
      Buffer.from(parsed.unsignedHash.slice(2), 'hex'),
      Buffer.from(
        observed.signature.r.slice(2) + observed.signature.s.slice(2),
        'hex'
      )
    )
    if (
      (await provider.getTransactionCount(
        joint.address,
        receipt.blockNumber
      )) !== 1
    )
      throw new Error('joint nonce accounting mismatch')
    const block = await provider.getBlock(receipt.blockNumber)
    const next = await provider.getBlock(receipt.blockNumber + 1)
    if (
      block?.hash !== receipt.blockHash ||
      next?.parentHash !== block.hash ||
      (await provider.getBlock(height))?.hash !== hash
    )
      throw new Error('receipt ancestry changed')
    const after = await provider.getBalance(recipient, receipt.blockNumber)
    if (after - before !== built.transaction.value)
      throw new Error('recipient accounting mismatch')
    const stateDir = mkdtempSync(join(tmpdir(), 'frank-adaptor-monad-'))
    writeFileSync(
      join(stateDir, 'evidence.json'),
      JSON.stringify(
        {
          chainIdentifier: 'monad-regtest',
          version,
          checkpoint: { height, hash },
          digest: hex(built.digest),
          preimage: built.preimage,
          bindingHash: signed.bindingHash,
          transcriptHashes: signed.transcriptHashes,
          raw,
          txid: submitted.hash,
          receipt: receipt.toJSON(),
          recipientWei: (after - before).toString(),
          ...extraction,
        },
        null,
        2
      )
    )
    console.log(`PASS MON native acceptance: ${stateDir}/evidence.json`)
  } finally {
    provider.destroy()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
