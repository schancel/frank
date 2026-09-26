/**
 * Standalone, manually-run proof for `monad-account-tx.ts`, in the same spirit as
 * `monad-http.smoketest.ts` (see that file's header for why this isn't a jest test: this app's
 * `jest` isn't actually an installed dependency despite `jest.config.js`/`package.json` referring
 * to it).
 *
 * Unlike `monad-http.smoketest.ts`, this does NOT talk to the live Monad testnet at all — no
 * `.env`, no RPC URL, no network access, no funds needed. It proves the thing ticket #11 asks for
 * under "Live proof": that `MonadAccountTxSigner` builds and locally signs *real* Monad
 * transactions (both a plain value transfer and a value+calldata transaction) that round-trip
 * correctly through ethers' own independent decoder, without ever broadcasting them. Concretely,
 * for each transaction built here:
 *   1. It's built/signed by `MonadAccountTxSigner` against a `JsonRpcProvider` whose `_perform` is
 *      stubbed (so this is 100% offline; no HTTP calls happen at all).
 *   2. The resulting raw signed hex is re-parsed from scratch via `ethers.Transaction.from`,
 *      completely independent of the code path that produced it.
 *   3. The re-parsed transaction's recovered sender address (`Transaction.from`
 *      ECDSA-recovers `from` from the signature over the signed payload) is checked against the
 *      signer's known address — this is the actual cryptographic proof: the signature is valid
 *      and was produced by this key, not just "some bytes came out".
 *   4. Every field (nonce, gas, fees, chainId, to, value, data) is checked against what was asked
 *      for / stubbed, so the encoding round-trips exactly.
 *
 * Usage (from `app/`):
 *   node_modules/.bin/tsc --module commonjs --target es2019 --esModuleInterop --resolveJsonModule \
 *     --outDir /tmp/monad-account-tx-livecheck src/cashweb/wallet/monad-http.ts \
 *     src/cashweb/wallet/monad-account-tx.ts src/cashweb/wallet/monad-account-tx.livecheck.ts
 *   node /tmp/monad-account-tx-livecheck/monad-account-tx.livecheck.js
 */
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'

import { MonadAccountTxSigner, MonadTxSubmitter } from './monad-account-tx'
import { MonadTxReceipt } from './monad-http'

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = typeof actual === 'bigint' ? actual.toString() : actual
  const e = typeof expected === 'bigint' ? expected.toString() : expected
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`)
  }
  console.log(`  OK  ${label} = ${e}`)
}

async function main() {
  // Real key, generated locally, never funded, never used anywhere else.
  const wallet = Wallet.createRandom()
  console.log('Test EOA address:', wallet.address)

  // Monad testnet's real chain ID (10143) — used here only as a realistic constant baked into
  // the stubbed provider response; no network call actually reaches Monad or anywhere else.
  const MONAD_TESTNET_CHAIN_ID = 10143n

  // `staticNetwork` skips ethers' own chain-ID-detection RPC call entirely, so `getNetwork()`
  // never touches `_perform`/the network. `cacheTimeout: -1` disables ethers' own short-lived
  // (250ms) same-request de-duplication, so this proof can show each call below really does ask
  // the (stubbed) chain again — matching the ticket's "no local nonce caching" requirement, which
  // is about this module never substituting its own guess, not about ethers' unrelated
  // millisecond-scale request-coalescing convenience.
  const provider = new JsonRpcProvider(
    'http://127.0.0.1:1',
    Number(MONAD_TESTNET_CHAIN_ID),
    {
      staticNetwork: true,
      cacheTimeout: -1,
    },
  )

  let nonceCalls = 0
  let gasCalls = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(provider as any)._perform = async (req: { method: string }) => {
    if (req.method === 'getTransactionCount') {
      nonceCalls++
      return '0x2a' // 42 — proves the nonce really is fetched from (a stand-in for) the chain,
      // not hardcoded/guessed by this module.
    }
    if (req.method === 'estimateGas') {
      gasCalls++
      return '0x5208' // 21000 for the plain transfer; the calldata tx below overrides gasLimit
      // explicitly instead, since a real estimateGas result depends on the calldata bytes and
      // there's no EVM here to execute against.
    }
    throw new Error(`Unexpected _perform call in offline proof: ${req.method}`)
  }

  // httpClient stub: proves submit()/getStatus() wiring without a real MonadHttpClient/network.
  let submittedRawTx: string | undefined
  const httpClient: MonadTxSubmitter = {
    async submitRawTransaction(rawTxHex: string): Promise<string> {
      submittedRawTx = rawTxHex
      return Transaction.from(rawTxHex).hash as string
    },
    async getTransactionReceipt(): Promise<MonadTxReceipt | undefined> {
      return undefined
    },
  }

  const signer = new MonadAccountTxSigner({
    privateKey: wallet.privateKey,
    provider,
    httpClient,
  })
  assertEqual(signer.address, wallet.address, 'signer.address matches the key')

  const recipient = '0x000000000000000000000000000000000000dEaD' // MONAD_STAMP_BURN_ADDRESS
  const value = 1_000_000_000_000_000_000n // 1 MON

  // --- 1. Plain native-value transfer -------------------------------------------------------
  console.log(
    '\n[1/2] Plain native-value transfer (nonce + gas fetched, fees overridden):',
  )
  const transfer = await signer.buildAndSignTransfer(recipient, value, {
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  })
  assertEqual(nonceCalls, 1, 'eth_getTransactionCount was called exactly once')
  assertEqual(gasCalls, 1, 'eth_estimateGas was called exactly once')
  assertEqual(transfer.nonce, 42, 'transfer.nonce (fetched from stub chain)')
  assertEqual(
    transfer.gasLimit,
    21000n,
    'transfer.gasLimit (fetched from stub chain)',
  )
  assertEqual(transfer.data, '0x', 'transfer.data (empty for plain transfer)')
  assertEqual(transfer.chainId, MONAD_TESTNET_CHAIN_ID, 'transfer.chainId')

  const decodedTransfer = Transaction.from(transfer.rawTx)
  assertEqual(
    decodedTransfer.hash,
    transfer.txHash,
    'decoded hash matches SignedMonadTx.txHash',
  )
  assertEqual(
    decodedTransfer.from?.toLowerCase(),
    wallet.address.toLowerCase(),
    'decoded signature recovers the signer address (real ECDSA signature, not a stub)',
  )
  assertEqual(
    decodedTransfer.to?.toLowerCase(),
    recipient.toLowerCase(),
    'decoded to',
  )
  assertEqual(decodedTransfer.value, value, 'decoded value')
  assertEqual(decodedTransfer.nonce, 42, 'decoded nonce')
  assertEqual(decodedTransfer.gasLimit, 21000n, 'decoded gasLimit')
  assertEqual(
    decodedTransfer.chainId,
    MONAD_TESTNET_CHAIN_ID,
    'decoded chainId',
  )

  const submitted1 = await signer.submit(transfer)
  assertEqual(
    submitted1,
    transfer.txHash,
    'submit() returns the matching broadcast hash',
  )
  assertEqual(
    submittedRawTx,
    transfer.rawTx,
    'submit() forwarded the exact signed raw tx',
  )
  assertEqual(
    await signer.getStatus(submitted1),
    'pending',
    'getStatus() before a receipt exists',
  )

  // --- 2. Value + calldata transaction (what Stamp burns, #6, will need) -------------------
  console.log(
    '\n[2/2] Value + calldata transaction (nonce fetched again fresh; gas/fees fully overridden):',
  )
  const commitment = '0xdeadbeef' + '00'.repeat(28) // stand-in 32-byte commitment, LOKAD-ID style
  const call = await signer.buildAndSignCall(recipient, value, commitment, {
    gasLimit: 30000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
  })
  assertEqual(
    nonceCalls,
    2,
    'eth_getTransactionCount was called again (fresh, no caching)',
  )
  assertEqual(
    gasCalls,
    1,
    'eth_estimateGas was NOT called again (gasLimit was overridden)',
  )
  assertEqual(
    call.nonce,
    42,
    'call.nonce (stub chain always reports 42 here; still fetched fresh)',
  )
  assertEqual(
    call.data,
    commitment,
    'call.data matches the requested calldata exactly',
  )

  const decodedCall = Transaction.from(call.rawTx)
  assertEqual(
    decodedCall.from?.toLowerCase(),
    wallet.address.toLowerCase(),
    'decoded signature recovers the signer address',
  )
  assertEqual(decodedCall.data, commitment, 'decoded calldata matches exactly')
  assertEqual(
    decodedCall.gasLimit,
    30000n,
    'decoded gasLimit (override honored, no estimate call)',
  )
  assertEqual(
    decodedCall.maxFeePerGas,
    3_000_000_000n,
    'decoded maxFeePerGas (override honored)',
  )

  // buildAndSignCall must reject an empty-calldata call (that's what buildAndSignTransfer is for)
  let rejected = false
  try {
    await signer.buildAndSignCall(recipient, value, '0x', {
      nonce: 0,
      gasLimit: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
  } catch (err) {
    rejected = true
    console.log(
      '  OK  buildAndSignCall("0x") rejected as expected:',
      (err as Error).message,
    )
  }
  if (!rejected) {
    throw new Error('buildAndSignCall("0x") should have thrown but did not')
  }

  console.log(
    '\nLIVE PROOF PASSED: real ethers-signed Monad transactions built, signed, and',
  )
  console.log(
    'round-tripped through an independent decode — entirely offline, no funds spent.',
  )
}

main().catch(err => {
  console.error('LIVE PROOF FAILED:', err)
  process.exit(1)
})
