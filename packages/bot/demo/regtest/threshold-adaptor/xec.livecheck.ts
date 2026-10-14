import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  XEC_REGTEST,
  encodeAddress,
  pubkeyHashFromBytes,
  internalHashFromDisplay,
  displayTxidFromBytes,
  serializeTransaction,
  parseTransaction,
  type Transaction,
} from '@frank/nakamoto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { startEcashRegtest } from '../ecash-regtest'
import { buildXecAdaptorSpend } from './native-digests'
import { freshJointKey, hex, must } from './signing-fixture'

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'frank-adaptor-xec-'))
  const node = await startEcashRegtest({ stateDir, blockIntervalMs: 60000 })
  try {
    const chain = await node.rpc<{ chain: string }>('getblockchaininfo')
    if (
      chain.chain !== 'regtest' ||
      (await node.rpc('getblockhash', [node.checkpoint.height])) !==
        node.checkpoint.hash
    )
      throw new Error('identity mismatch')
    const key = freshJointKey()
    const hash = createHash('ripemd160')
      .update(createHash('sha256').update(key.publicKey).digest())
      .digest()
    const scriptCode = Uint8Array.from(
      Buffer.concat([
        Buffer.from('76a914', 'hex'),
        hash,
        Buffer.from('88ac', 'hex'),
      ])
    )
    const address = must(
      encodeAddress(
        {
          kind: 'p2pkh',
          hash: must(pubkeyHashFromBytes(new Uint8Array(hash))),
        },
        XEC_REGTEST,
        'cashaddr'
      )
    )
    const amount = 100000n,
      value = 99000n
    const funding = await node.fund(address, amount)
    const fundingWallet = await node.rpc<{ blockhash: string }>(
      'gettransaction',
      [funding]
    )
    const funded = await node.rpc<{
      vout: { n: number; scriptPubKey: { hex: string } }[]
    }>('getrawtransaction', [funding, true, fundingWallet.blockhash])
    const output = funded.vout.find(
      (o) => o.scriptPubKey.hex === hex(scriptCode)
    )
    if (!output) throw new Error('funding output missing')
    const recipient = await node.rpc<string>('getnewaddress')
    const destination = await node.rpc<{ scriptPubKey: string }>(
      'validateaddress',
      [recipient]
    )
    const tx: Transaction = {
      version: 2,
      inputs: [
        {
          prevout: {
            txid: internalHashFromDisplay(
              must(
                displayTxidFromBytes(
                  new Uint8Array(Buffer.from(funding, 'hex'))
                )
              )
            ),
            vout: output.n,
          },
          scriptSig: new Uint8Array(),
          sequence: 0xffffffff,
        },
      ],
      outputs: [
        {
          value,
          scriptPubKey: new Uint8Array(
            Buffer.from(destination.scriptPubKey, 'hex')
          ),
        },
      ],
      locktime: 0,
    }
    const digest = buildXecAdaptorSpend('xec-regtest', tx, scriptCode, amount)
    const signed = key.sign(
      digest,
      JSON.stringify({
        chainIdentifier: node.chainIdentifier,
        checkpoint: node.checkpoint,
        funding,
        vout: output.n,
        inputSats: amount.toString(),
        recipient,
        recipientSats: value.toString(),
      })
    )
    const der = secp256k1.Signature.fromCompact(
      signed.completed
    ).toDERRawBytes()
    const signature = Buffer.concat([der, Buffer.from([0x41])])
    const scriptSig = Buffer.concat([
      Buffer.from([signature.length]),
      signature,
      Buffer.from([key.publicKey.length]),
      key.publicKey,
    ])
    const raw = hex(
      must(
        serializeTransaction(
          {
            ...tx,
            inputs: [
              { ...tx.inputs[0]!, scriptSig: new Uint8Array(scriptSig) },
            ],
          },
          XEC_REGTEST
        )
      )
    )
    const compact = secp256k1.Signature.fromCompact(signed.completed)
    const highDer = new secp256k1.Signature(
      compact.r,
      secp256k1.CURVE.n - compact.s
    ).toDERRawBytes()
    const invalidSignatures = [
      Buffer.concat([highDer, Buffer.from([0x41])]),
      Buffer.from([0x30, 0x00, 0x41]),
    ]
    for (const invalid of invalidSignatures) {
      const badScript = new Uint8Array(
        Buffer.concat([
          Buffer.from([invalid.length]),
          invalid,
          Buffer.from([key.publicKey.length]),
          key.publicKey,
        ])
      )
      const badRaw = hex(
        must(
          serializeTransaction(
            { ...tx, inputs: [{ ...tx.inputs[0]!, scriptSig: badScript }] },
            XEC_REGTEST
          )
        )
      )
      const bad = await node.rpc<{ allowed: boolean }[]>('testmempoolaccept', [
        [badRaw],
      ])
      if (bad[0]?.allowed !== false)
        throw new Error('node accepted malformed/high-s signature')
    }
    const acceptance = await node.rpc<
      { allowed: boolean; 'reject-reason'?: string }[]
    >('testmempoolaccept', [[raw]])
    if (!acceptance[0]?.allowed)
      throw new Error(`node rejection: ${acceptance[0]?.['reject-reason']}`)
    const txid = await node.rpc<string>('sendrawtransaction', [raw])
    if ((await node.rpc<string>('sendrawtransaction', [raw])) !== txid)
      throw new Error('duplicate broadcast mismatch')
    await node.mine()
    const receivedWallet = await node.rpc<{ blockhash: string }>(
      'gettransaction',
      [txid]
    )
    const observedRaw = await node.rpc<string>('getrawtransaction', [
      txid,
      false,
      receivedWallet.blockhash,
    ])
    if (observedRaw !== raw) throw new Error('observed transaction mismatch')
    const observed = must(
      parseTransaction(
        new Uint8Array(Buffer.from(observedRaw, 'hex')),
        XEC_REGTEST
      )
    )
    const observedScript = observed.inputs[0]!.scriptSig
    const observedSignature = secp256k1.Signature.fromDER(
      observedScript.subarray(1, observedScript[0]!)
    ).toCompactRawBytes()
    const extraction = signed.observe(
      buildXecAdaptorSpend('xec-regtest', observed, scriptCode, amount),
      observedSignature
    )
    if ((await node.rpc('gettxout', [funding, output.n])) !== null)
      throw new Error('input remains unspent')
    const received = await node.rpc<{
      value: number
      confirmations: number
    } | null>('gettxout', [txid, 0])
    if (
      !received ||
      received.confirmations < 1 ||
      BigInt(Math.round(received.value * 100)) !== value
    )
      throw new Error('recipient accounting mismatch')
    writeFileSync(
      join(stateDir, 'evidence.json'),
      JSON.stringify(
        {
          chainIdentifier: node.chainIdentifier,
          version: await node.rpc('getnetworkinfo'),
          checkpoint: node.checkpoint,
          digest: hex(digest),
          bindingHash: signed.bindingHash,
          transcriptHashes: signed.transcriptHashes,
          raw,
          txid,
          recipient,
          inputSats: amount.toString(),
          recipientSats: value.toString(),
          feeSats: (amount - value).toString(),
          received,
          ...extraction,
        },
        null,
        2
      )
    )
    console.log(`PASS XEC native acceptance: ${stateDir}/evidence.json`)
  } finally {
    await node.stop()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
