/**
 * eCash HTLC (packages/wallet/ecash-htlc.ts) on a real Bitcoin ABC regtest node with Chronik.
 * No fake chain: every acceptance and rejection below is the node's own.
 *
 *   yarn --cwd packages/bot regtest:ecash-htlc
 *
 * Needs a Chronik-enabled `bitcoind` (FRANK_BITCOIN_ABC_BIN_DIR, or `yarn --cwd packages/bot
 * regtest:fetch`). The Jest wrapper `ecash-htlc.regtest.jest.test.ts` runs this file and reports
 * NOT RUN when no node is available.
 *
 * Checks, in order:
 *   1. A funds two HTLCs through EcashWallet's native-operation path (P2SH recipient, operation id
 *      `swap:<swapId>:xec-lock`), each output exactly principal + XEC_HTLC_SPEND_FEE_SATS.
 *   2. The node rejects a claim with a wrong 32-byte preimage, and a claim with the matching
 *      31- or 33-byte preimage of an HTLC whose hash lock is over that length (OP_SIZE).
 *   3. B's wallet claim with the right preimage is accepted and mined: one output of exactly
 *      principal to B's primary address.
 *   4. The preimage is read back through Chronik (funding output spentBy → input push #2).
 *   5. A's refund is non-final while MTP ≤ T_A (setmocktime + mining), accepted after MTP > T_A.
 *   6. A second wallet instance of A's seed derives the same keys and signs the same refund txid.
 */
import assert from 'assert/strict'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { ChronikClient } from 'chronik-client'
import { Address } from 'ecash-lib/dist/address/address'
import {
  XEC_REGTEST,
  internalHashFromDisplay,
  displayTxidFromBytes,
  parseTransaction,
  serializeTransaction,
  sighash,
  type Transaction,
} from '@frank/nakamoto'
import { InMemoryNativeTransactionAttemptStore } from '@frank/wallet/chain/chain-wallet'
import { InMemoryEcashOperationStore } from '@frank/wallet/ecash-operation-store'
import { EcashWallet } from '@frank/wallet/ecash-wallet'
import {
  XEC_HTLC_SPEND_FEE_SATS,
  findXecHtlcPreimage,
  xecHtlcAddress,
  xecHtlcFundingValue,
  xecHtlcLockOperationId,
  xecHtlcOutputScript,
  xecHtlcRedeemScript,
  type XecHtlcTerms,
} from '@frank/wallet/ecash-htlc'

import { ECASH_REGTEST_CHAIN, startEcashRegtest, type EcashRegtest } from './ecash-regtest'
import { sleep } from './regtest-chain'

const CHAIN = ECASH_REGTEST_CHAIN
const PRINCIPAL = 10_000n
/** Default ABC regtest activates BIP65 (CHECKLOCKTIMEVERIFY) at this height. */
const CLTV_HEIGHT = 1351

const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))

interface Header {
  hash: string
  height: number
  mediantime: number
}
interface VerboseTx {
  vout: Array<{ n: number; value: number; scriptPubKey: { hex: string } }>
}

export async function ecashHtlcCheck(xec: EcashRegtest): Promise<string[]> {
  const steps: string[] = []
  const step = (line: string) => {
    steps.push(line)
    console.log(`ok - ${line}`)
  }
  const chronik = new ChronikClient([xec.chronikUrl])
  const open = (root: Uint8Array) =>
    EcashWallet.fromDomainRoot({
      domainRoot: {
        registry: 'frank-domain-roots-v1',
        purpose: 'ecash-bch-wallet',
        bytes: Uint8Array.from(root),
      },
      networkId: CHAIN,
      checkpoint: xec.checkpoint,
      chronik,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      operationStore: new InMemoryEcashOperationStore(),
      rebroadcast: async raws => {
        for (const raw of raws) await chronik.broadcastTx(raw)
      },
    })
  /** The transaction as mined in the current tip block (the node keeps no txindex). */
  const minedTx = async (txid: string): Promise<VerboseTx> => {
    const block = await xec.rpc<{ tx: Array<VerboseTx & { txid: string }> }>('getblock', [
      await xec.rpc<string>('getbestblockhash'),
      2,
    ])
    const tx = block.tx.find(item => item.txid === txid)
    assert.ok(tx, `${txid} is mined in the tip block`)
    return tx
  }
  const tip = async () => xec.rpc<Header>('getblockheader', [await xec.rpc<string>('getbestblockhash')])
  const mempoolAccept = async (raw: string) =>
    (await xec.rpc<Array<{ allowed: boolean; 'reject-reason'?: string }>>('testmempoolaccept', [[raw]]))[0]
  const rejected = async (label: string, raw: string, reason: RegExp, outpoint: { txid: string; vout: number }) => {
    const policy = await mempoolAccept(raw)
    assert.equal(policy.allowed, false, `${label}: the node must refuse it`)
    assert.match(policy['reject-reason'] ?? '', reason, `${label}: ${policy['reject-reason']}`)
    await assert.rejects(xec.rpc('sendrawtransaction', [raw]), reason)
    assert.ok(await xec.rpc('gettxout', [outpoint.txid, outpoint.vout, true]), `${label}: output still unspent`)
    step(`${label}: rejected by the node (${policy['reject-reason']})`)
  }
  /** Mines until a block's MTP is at least `target` under node mocktime `target`. */
  const moveMtp = async (target: number) => {
    await xec.rpc('setmocktime', [target])
    for (let i = 0; (await tip()).mediantime < target; i++) {
      assert.ok(i < 15, 'MTP did not reach the target')
      await xec.mine(1)
    }
  }
  const waitFor = async <T>(label: string, read: () => Promise<T | undefined>): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const value = await read().catch(() => undefined)
      if (value !== undefined) return value
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  // CLTV is enforced only from its activation height.
  const height = (await tip()).height
  if (height <= CLTV_HEIGHT) await xec.mine(CLTV_HEIGHT + 1 - height)

  const rootA = new Uint8Array(randomBytes(32))
  const alice = await open(rootA)
  const bob = await open(new Uint8Array(randomBytes(32)))
  const alice2 = await open(rootA)

  const aliceFunding = (await alice.getReceiveAddress()).raw
  await xec.fund(aliceFunding, 1_000_000n)
  await waitFor('alice balance', async () => ((await alice.getBalance()) >= 1_000_000n ? true : undefined))
  step(`alice funded at ${aliceFunding}`)

  const preimage = new Uint8Array(randomBytes(32))
  const claimSwap = randomBytes(32).toString('hex')
  const refundSwap = randomBytes(32).toString('hex')
  const now = (await tip()).mediantime
  const termsOf = (swapId: string, refundTime: number): XecHtlcTerms => ({
    hashLock: sha256(preimage),
    claimPublicKey: bob.htlcPublicKey(swapId, 'claim'),
    refundPublicKey: alice.htlcPublicKey(swapId, 'refund'),
    refundTime,
  })
  const claimTerms = termsOf(claimSwap, now + 100_000)
  const refundTerms = termsOf(refundSwap, now + 3_000)

  // 6 (keys): two instances of one seed agree; the two parties' keys differ.
  assert.equal(hex(alice2.htlcPublicKey(refundSwap, 'refund')), hex(refundTerms.refundPublicKey))
  assert.notEqual(hex(alice.htlcPublicKey(refundSwap, 'claim')), hex(refundTerms.claimPublicKey))
  step('a second wallet instance of the same seed derives the same HTLC keys')

  /** Funds one HTLC through the native-operation path; returns the funding outpoint. */
  const fund = async (swapId: string, terms: XecHtlcTerms) => {
    const address = xecHtlcAddress(CHAIN, terms)
    assert.match(address, /^ecregtest:p/)
    const operationId = xecHtlcLockOperationId(swapId)
    const operation = await alice.prepareNativeOperation({
      operationId,
      recipient: { raw: address },
      value: xecHtlcFundingValue(PRINCIPAL),
    })
    assert.equal(operation.intent.recipient, address)
    const sent = await alice.submitNativeOperation(operationId)
    await xec.mine(1)
    const tx = await minedTx(sent.txHash)
    // minedTx asserts it is in the tip block: confirmed.
    const outputs = tx.vout.filter(o => o.scriptPubKey.hex === hex(xecHtlcOutputScript(terms)))
    assert.equal(outputs.length, 1)
    assert.equal(BigInt(Math.round(outputs[0].value * 100)), PRINCIPAL + XEC_HTLC_SPEND_FEE_SATS)
    step(`funded ${address} with ${PRINCIPAL + XEC_HTLC_SPEND_FEE_SATS} sats via native operation ${operationId}`)
    return { txid: sent.txHash, vout: outputs[0].n }
  }
  const claimFunding = await fund(claimSwap, claimTerms)
  const refundFunding = await fund(refundSwap, refundTerms)

  // 2. Wrong preimages. Replacing push #2 keeps the signature valid (scriptSig is not signed),
  // so only the script's own checks refuse these.
  const claim = bob.signHtlcSpend({
    swapId: claimSwap,
    terms: claimTerms,
    funding: claimFunding,
    principalSats: PRINCIPAL,
    branch: 'claim',
    preimage,
  })
  const parsed = parseTransaction(bytes(claim.rawTx), XEC_REGTEST)
  assert.ok(parsed.ok)
  const withScriptSig = (tx: Transaction, scriptSig: Uint8Array) => {
    const out = serializeTransaction({ ...tx, inputs: [{ ...tx.inputs[0], scriptSig }] }, XEC_REGTEST)
    assert.ok(out.ok)
    return hex(out.value)
  }
  const pushes = (script: Uint8Array) => {
    // sig, preimage, OP_1, redeem; each a direct push (<= 75 bytes) except the redeem (PUSHDATA1).
    const sigLen = script[0]
    const sig = script.slice(1, 1 + sigLen)
    const pre = script.slice(2 + sigLen, 2 + sigLen + script[1 + sigLen])
    const rest = script.slice(2 + sigLen + pre.length)
    return { sig, pre, rest }
  }
  const claimScript = parsed.value.inputs[0].scriptSig
  const { sig, pre, rest } = pushes(claimScript)
  assert.equal(hex(pre), hex(preimage))
  const wrong = new Uint8Array(randomBytes(32))
  await rejected(
    'claim with a wrong 32-byte preimage',
    withScriptSig(parsed.value, Uint8Array.from([sig.length, ...sig, 32, ...wrong, ...rest])),
    /mandatory-script-verify-flag-failed/,
    claimFunding,
  )

  // Wrong-length preimages: HTLCs whose hash lock is over a 31- or 33-byte value. Spent with that
  // exact value, only OP_SIZE <0x20> OP_EQUALVERIFY can refuse them. Signed here with a disposable
  // test key (the wallet builder refuses to sign a preimage that is not 32 bytes).
  const testKey = new Uint8Array(randomBytes(32))
  for (const length of [31, 33]) {
    const value = new Uint8Array(randomBytes(length))
    const terms: XecHtlcTerms = {
      hashLock: sha256(value),
      claimPublicKey: secp256k1.getPublicKey(testKey, true),
      refundPublicKey: refundTerms.refundPublicKey,
      refundTime: now + 100_000,
    }
    const txid = await xec.fund(xecHtlcAddress(CHAIN, terms), xecHtlcFundingValue(PRINCIPAL))
    const vout = (await minedTx(txid)).vout.find(o => o.scriptPubKey.hex === hex(xecHtlcOutputScript(terms)))!.n
    const redeem = xecHtlcRedeemScript(terms)
    const display = displayTxidFromBytes(bytes(txid))
    assert.ok(display.ok)
    const unsigned: Transaction = {
      version: 2,
      inputs: [
        {
          prevout: { txid: internalHashFromDisplay(display.value), vout },
          scriptSig: new Uint8Array(),
          sequence: 0xffffffff,
        },
      ],
      outputs: [
        {
          value: PRINCIPAL,
          scriptPubKey: parsed.value.outputs[0].scriptPubKey,
        },
      ],
      locktime: 0,
    }
    const digest = sighash(unsigned, 0, XEC_REGTEST, 0x41, {
      algorithm: 'forkid',
      scriptCode: redeem,
      amount: xecHtlcFundingValue(PRINCIPAL),
    })
    assert.ok(digest.ok)
    const der = secp256k1.sign(digest.value, testKey, { lowS: true }).toDERRawBytes()
    const signature = Uint8Array.from([...der, 0x41])
    const scriptSig = Uint8Array.from([
      signature.length,
      ...signature,
      length,
      ...value,
      0x51,
      0x4c,
      redeem.length,
      ...redeem,
    ])
    await rejected(
      `claim with the matching ${length}-byte preimage (OP_SIZE check)`,
      withScriptSig(unsigned, scriptSig),
      /mandatory-script-verify-flag-failed/,
      { txid, vout },
    )
  }

  // 3. The right preimage: B's wallet claim is accepted and mined.
  const bobPrimary = bob.identity.address.raw
  assert.equal((await mempoolAccept(claim.rawTx)).allowed, true)
  assert.equal(await chronik.broadcastTx(claim.rawTx).then(r => r.txid), claim.txid)
  await xec.mine(1)
  const mined = await minedTx(claim.txid)
  assert.equal(mined.vout.length, 1)
  assert.equal(BigInt(Math.round(mined.vout[0].value * 100)), PRINCIPAL)
  const bobScript = (await chronik.tx(claim.txid)).outputs[0].outputScript
  assert.equal(bobScript, Address.fromCashAddress(bobPrimary).toScript().toHex())
  assert.equal(await xec.rpc('gettxout', [claimFunding.txid, claimFunding.vout, true]), null)
  step(
    `claim ${claim.txid} with the right preimage mined: exactly ${PRINCIPAL} sats to ${bobPrimary}, fee ${XEC_HTLC_SPEND_FEE_SATS}`,
  )

  // 4. Reveal through Chronik.
  const revealed = await waitFor('chronik spentBy', () => findXecHtlcPreimage(chronik, claimFunding, claimTerms))
  assert.equal(hex(revealed), hex(preimage))
  assert.equal(await findXecHtlcPreimage(chronik, refundFunding, refundTerms), undefined)
  step('preimage read back through Chronik (spentBy → push #2); unspent HTLC reveals nothing')

  // 5. Refund timing, and 6. the same txid from a second instance.
  const refundParams = {
    swapId: refundSwap,
    terms: refundTerms,
    funding: refundFunding,
    principalSats: PRINCIPAL,
    branch: 'refund' as const,
  }
  const refund = alice.signHtlcSpend(refundParams)
  assert.deepEqual(alice2.signHtlcSpend(refundParams), refund)
  step(`a second wallet instance of the same seed signs the identical refund ${refund.txid}`)
  assert.throws(() => bob.signHtlcSpend(refundParams), /does not hold the refund key/)

  assert.ok((await tip()).mediantime < refundTerms.refundTime)
  await rejected('refund while MTP < T_A', refund.rawTx, /bad-txns-nonfinal/, refundFunding)
  await moveMtp(refundTerms.refundTime)
  assert.equal((await tip()).mediantime, refundTerms.refundTime)
  await rejected('refund at MTP = T_A', refund.rawTx, /bad-txns-nonfinal/, refundFunding)
  await moveMtp(refundTerms.refundTime + 1)
  assert.equal((await mempoolAccept(refund.rawTx)).allowed, true)
  assert.equal(await chronik.broadcastTx(refund.rawTx).then(r => r.txid), refund.txid)
  await xec.mine(1)
  const refunded = await minedTx(refund.txid)
  assert.equal(BigInt(Math.round(refunded.vout[0].value * 100)), PRINCIPAL)
  assert.equal(refunded.vout.length, 1)
  assert.equal(
    refunded.vout[0].scriptPubKey.hex,
    Address.fromCashAddress(alice.identity.address.raw).toScript().toHex(),
  )
  const spentBy = await waitFor(
    'refund spentBy',
    async () => (await chronik.tx(refundFunding.txid)).outputs[refundFunding.vout].spentBy,
  )
  assert.equal(spentBy.txid, refund.txid)
  assert.equal(await findXecHtlcPreimage(chronik, refundFunding, refundTerms), undefined)
  step(`refund ${refund.txid} accepted once MTP > T_A and mined: exactly ${PRINCIPAL} sats to alice`)
  await xec.rpc('setmocktime', [0])
  return steps
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'frank-ecash-htlc-'))
  // Blocks only when the check asks: MTP must follow setmocktime, not a timer.
  const xec = await startEcashRegtest({
    stateDir,
    blockIntervalMs: 24 * 3600_000,
  })
  try {
    const steps = await ecashHtlcCheck(xec)
    console.log(`eCash HTLC regtest: OK (${steps.length} checks)`)
  } finally {
    await xec.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    err => {
      console.error(err)
      process.exit(1)
    },
  )
}
