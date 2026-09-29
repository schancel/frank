/**
 * Ticket #8: live end-to-end demo, criteria 2-4 -- "send a stamped message relay-to-relay on
 * Monad testnet", confirm it round-trips through the relay, and leave a real broadcast tx hash
 * behind for independent on-chain verification (see `verify-onchain-tx.livecheck.ts`).
 *
 * Unlike every other `*.livecheck.ts` in this directory, this one deliberately DOES hit the real
 * network: real Alchemy-backed Monad testnet RPC calls (funding + the stamp payment itself), and
 * a real HTTP call to a locally-running `cashweb-registry` server (see
 * `backend/cashweb/cashweb-registry/examples/e2e_demo_server.rs`). It costs real (testnet) MON
 * and only makes sense to run manually against a live setup -- exactly why it's a `.livecheck.ts`
 * rather than a `*.jest.test.ts` (this app's `jest.config.js` `testMatch` doesn't pick up
 * `.livecheck.ts` files at all, so it never runs under `yarn test:unit:ci`).
 *
 * See `backend/cashweb/cashweb-registry/examples/README.md` for the full runbook this is one step
 * of.
 *
 * ## What this proves
 *
 * - A real sub-account is HD-derived (`MonadHdKeyring`/`MonadSubAccountPool`, #14/#34) and funded
 *   from the real, pre-funded main testnet account via a real, broadcast-and-confirmed Monad
 *   transaction (`fanOutFundSubAccounts`, #14).
 * - `MonadStampClient.submitStampedMessage` (#13) leases that sub-account, builds + locally signs
 *   a real EIP-1559 payment committing to `SHA256(encrypted_payload)`, and `PUT`s it to
 *   the relay's live `PUT /message/monad` route.
 * - The relay (`process_monad_message`/`broadcast_and_verify_stamp`, #16/#19/#27) broadcasts that
 *   *exact* raw transaction itself via its own `eth_sendRawTransaction` call against the same real
 *   Alchemy endpoint, polls for its receipt, verifies the payment commitment/value, and only then
 *   stores the message -- so a 2xx response here means a real stamp payment is confirmed on live
 *   Monad testnet.
 * - The correlated successful `PUT` response proves the exact message was retained; this demo does
 *   not depend on or advertise a public exact-message `GET` surface.
 *
 * ## Content encryption is out of scope here
 *
 * `MonadStampedMessage.encrypted_payload` is opaque to every layer this ticket touches (relay,
 * stamp client) -- see that field's doc comment in `proto/monad_message.proto`. No Monad-side
 * message-content encryption scheme has landed in this codebase yet (checked: no
 * ecies/encrypt/decrypt module anywhere under `app/src/cashweb/wallet`), so this demo sends a
 * plain UTF-8 JSON blob as a stand-in for "already encrypted for the recipient" -- proving the
 * payment/relay/verify/store pipeline, not a content-confidentiality property nothing in this
 * codebase implements yet for Monad.
 *
 * ## Usage (from `app/`)
 *
 *   node_modules/.bin/tsc --module commonjs --target es2019 --esModuleInterop \
 *     --resolveJsonModule --skipLibCheck --outDir /tmp/monad-e2e-demo \
 *     src/cashweb/wallet/monad-http.ts src/cashweb/wallet/monad-account-tx.ts \
 *     src/cashweb/wallet/monad-hd-keyring.ts src/cashweb/wallet/monad-account-pool.ts \
 *     src/cashweb/wallet/monad-account-lease.ts src/cashweb/wallet/monad-stamp-client.ts \
 *     src/cashweb/wallet/monad_message_pb.js \
 *     src/cashweb/wallet/storage/sub-account-pool-storage.ts \
 *     src/cashweb/wallet/monad-e2e-demo.livecheck.ts
 *   node /tmp/monad-e2e-demo/monad-e2e-demo.livecheck.js
 *
 * Required env (see repo-root `.env`, gitignored): `MONAD_TESTNET_HTTP_RPC_URL`,
 * `MONAD_STAMP_BURN_ADDRESS`, `CASHWEB_STAMP_MIN_BURN_VALUE_WEI`. Also:
 *   - `E2E_DEMO_RELAY_URL` (default `http://127.0.0.1:8098`) -- the running `e2e_demo_server`.
 *   - `E2E_DEMO_MAIN_WALLET_JSON` (default
 *     `../frank-worktrees/spike-demo/spike/data/chain-wallet.json`, relative to `app/`) -- the
 *     pre-funded Monad testnet account's `{ address, privateKey }` JSON file.
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

import { JsonRpcProvider, Transaction, hexlify } from 'ethers'

import { MonadHttpClient } from './monad-http'
import { MonadAccountTxSigner } from './monad-account-tx'
import { MonadStampClient } from './monad-stamp-client'
import { MonadIdentity, registerMonadIdentity } from './monad-identity'
import { createMonadStampWalletHandle } from './monad-wallet-handle'
import { openMonadWalletBundle } from './storage/monad-wallet-bundle'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required env var ${name} -- see this file's header for the full list, and ` +
        'backend/cashweb/cashweb-registry/examples/README.md for how to source it from .env'
    )
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForConfirmation(
  signer: MonadAccountTxSigner,
  txHash: string,
  label: string
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await signer.getStatus(txHash)
    console.log(`  [${label}] status = ${status} (attempt ${attempt + 1})`)
    if (status === 'confirmed') return
    if (status === 'failed') {
      throw new Error(`${label} (${txHash}) failed on-chain`)
    }
    await sleep(2000)
  }
  throw new Error(`${label} (${txHash}) did not confirm within the poll budget`)
}

async function main() {
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const minStampValueWei = BigInt(
    requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI')
  )
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const walletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json'
  )

  console.log(
    '== Ticket #8 e2e demo: stamped message relay-to-relay on Monad testnet =='
  )
  console.log(`RPC:          ${rpcUrl}`)
  console.log(`Min stamp:    ${minStampValueWei} wei`)
  console.log(`Relay:        ${relayBaseUrl}`)
  console.log(`Main wallet:  ${walletJsonPath}`)

  const mainWallet = JSON.parse(readFileSync(walletJsonPath, 'utf8')) as {
    address: string
    privateKey: string
  }
  console.log(`Main funding account: ${mainWallet.address}`)
  const recipientIdentity = MonadIdentity.fromPrivateKeyHex(
    mainWallet.privateKey
  )
  await registerMonadIdentity({ relayBaseUrl, identity: recipientIdentity })
  console.log(`Recipient identity: ${recipientIdentity.address.raw}`)

  const provider = new JsonRpcProvider(rpcUrl)
  const httpClient = new MonadHttpClient({ rpcUrl })

  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: mainWallet.privateKey,
    provider,
    httpClient,
  })

  // --- 1. Atomically create/reopen one durable complete wallet bundle. ---
  const walletState = await openMonadWalletBundle({
    location: resolve(
      process.cwd(),
      process.env.E2E_DEMO_WALLET_STATE ?? '.monad-e2e-wallet'
    ),
    createSeedIfEmpty: true,
  })
  try {
    const { pool } = walletState
    const stampClient = new MonadStampClient(
      createMonadStampWalletHandle({
        walletState,
        provider,
        httpClient,
        relayBaseUrl,
      })
    )
    await stampClient.reconcileOrThrow()

    const gasReserve = BigInt('20000000000000000') // 0.02 MON headroom for gas fees
    console.log('\n== Preparing durable stamp inventory ==')
    const preparation = await pool.prepareStampInventory({
      mainAccountSigner,
      provider,
      stampValueWei: minStampValueWei,
      gasReserveWei: gasReserve,
    })
    console.log(
      `Inventory ready; funding txs: ${preparation.fundingTxHashes.join(', ')}`
    )

    // --- 2. Build the (opaque, unencrypted-for-this-demo -- see file header) message payload. ---
    const message = {
      from: mainWallet.address,
      to: recipientIdentity.address.raw,
      demo: 'ticket-8-e2e-demo',
      text: 'Hello over Monad testnet via a real Stamp payment + cashweb-registry relay.',
      sentAt: new Date().toISOString(),
    }
    const encryptedPayload = new TextEncoder().encode(JSON.stringify(message))

    // --- 3. Stamp + relay the message. ---
    console.log('\n== Submitting the stamped message to the relay ==')
    const result = await stampClient.submitStampedMessage({
      encryptedPayload,
      recipientPublicKey: recipientIdentity.compressedPubKey,
      stampValueWei: minStampValueWei,
    })

    console.log('Relay accepted the message.')
    console.log(`  payload_hash: ${result.payloadHashHex}`)
    console.log(`  stamp tx hashes: ${result.txHashes.join(', ')}`)
    console.log(
      `  sub-accounts leased: ${result.leaseIndices.join(
        ', '
      )} (now 'spent', never reused)`
    )

    // The successful PUT response itself carries the exact retained message authority. The public
    // relay intentionally has no payload-hash GET endpoint; crash recovery replays these exact bytes.
    const retainedMessage = result.stored.message
    if (retainedMessage === undefined) {
      throw new Error('relay success omitted the retained stamped message')
    }
    const retainedText = new TextDecoder().decode(
      retainedMessage.encryptedPayload
    )
    console.log(
      `Retained payload matches: ${retainedText === JSON.stringify(message)}`
    )
    const retainedTxHashes = retainedMessage.stampPayments.map(
      (payment) => Transaction.from(hexlify(payment.rawTx)).hash
    )
    const retainedDestinations = retainedMessage.stampPayments.map(
      (payment) => Transaction.from(hexlify(payment.rawTx)).to
    )
    console.log(
      `Retained stamp tx hashes match: ${
        JSON.stringify(retainedTxHashes) === JSON.stringify(result.txHashes)
      }`
    )

    // --- Hand off the broadcast tx hash for independent, separate-process on-chain verification. ---
    const handoffPath = resolve(process.cwd(), '/tmp/e2e-demo-stamp-tx.json')
    writeFileSync(
      handoffPath,
      JSON.stringify(
        {
          txHash: result.txHashes[0],
          payloadHashHex: result.payloadHashHex,
          paymentDestinations: retainedDestinations,
        },
        null,
        2
      )
    )
    console.log(
      `\nWrote handoff file for independent verification: ${handoffPath}`
    )
    console.log(
      'Run: node /tmp/monad-e2e-demo/verify-onchain-tx.livecheck.js ' +
        result.txHashes[0]
    )
    console.log('\nAll steps completed.')
  } finally {
    await walletState.close()
  }
}

main().catch((err) => {
  console.error('\nE2E DEMO FAILED:', err)
  process.exit(1)
})
