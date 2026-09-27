/**
 * Ticket #8: live end-to-end demo, criteria 2-4 -- "send a stamped message relay-to-relay on
 * Monad testnet", confirm it round-trips through the relay, and leave a real broadcast tx hash
 * behind for independent on-chain verification (see `verify-onchain-tx.livecheck.ts`).
 *
 * Unlike every other `*.livecheck.ts` in this directory, this one deliberately DOES hit the real
 * network: real Alchemy-backed Monad testnet RPC calls (funding + the stamp burn tx itself), and
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
 *   a real EIP-1559 burn transaction committing to `SHA256(encrypted_payload)`, and `PUT`s it to
 *   the relay's live `PUT /message/monad` route.
 * - The relay (`process_monad_message`/`broadcast_and_verify_stamp`, #16/#19/#27) broadcasts that
 *   *exact* raw transaction itself via its own `eth_sendRawTransaction` call against the same real
 *   Alchemy endpoint, polls for its receipt, verifies the burn commitment/value, and only then
 *   stores the message -- so a 2xx response here means a real burn tx is now confirmed on live
 *   Monad testnet.
 * - `GET /message/monad/:payload_hash` (right after) proves the stored message is retrievable --
 *   see this file's tail comment for what this does and does NOT prove about "delivery".
 *
 * ## Content encryption is out of scope here
 *
 * `MonadStampedMessage.encrypted_payload` is opaque to every layer this ticket touches (relay,
 * stamp client) -- see that field's doc comment in `proto/monad_message.proto`. No Monad-side
 * message-content encryption scheme has landed in this codebase yet (checked: no
 * ecies/encrypt/decrypt module anywhere under `app/src/cashweb/wallet`), so this demo sends a
 * plain UTF-8 JSON blob as a stand-in for "already encrypted for the recipient" -- proving the
 * burn/relay/verify/store pipeline, not a content-confidentiality property nothing in this
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

import { JsonRpcProvider } from 'ethers'

import { MonadHttpClient } from './monad-http'
import { MonadAccountTxSigner } from './monad-account-tx'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadStampClient } from './monad-stamp-client'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required env var ${name} -- see this file's header for the full list, and ` +
        'backend/cashweb/cashweb-registry/examples/README.md for how to source it from .env',
    )
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitForConfirmation(
  signer: MonadAccountTxSigner,
  txHash: string,
  label: string,
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
  const burnAddress = requiredEnv('MONAD_STAMP_BURN_ADDRESS')
  const minBurnValueWei = BigInt(
    requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'),
  )
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const walletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json',
  )

  console.log(
    '== Ticket #8 e2e demo: stamped message relay-to-relay on Monad testnet ==',
  )
  console.log(`RPC:          ${rpcUrl}`)
  console.log(`Burn address: ${burnAddress}`)
  console.log(`Min burn:     ${minBurnValueWei} wei`)
  console.log(`Relay:        ${relayBaseUrl}`)
  console.log(`Main wallet:  ${walletJsonPath}`)

  const mainWallet = JSON.parse(readFileSync(walletJsonPath, 'utf8')) as {
    address: string
    privateKey: string
  }
  console.log(`Main funding account: ${mainWallet.address}`)

  const provider = new JsonRpcProvider(rpcUrl)
  const httpClient = new MonadHttpClient({ rpcUrl })

  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: mainWallet.privateKey,
    provider,
    httpClient,
  })

  // --- 1. Derive + fund one fresh sub-account from the main funded account. ---
  const { keyring, mnemonic } = MonadHdKeyring.generate()
  console.log(
    `\nGenerated a fresh sub-account-pool mnemonic for this demo run: "${mnemonic}"`,
  )
  console.log('(ephemeral -- this pool is thrown away when this process exits)')

  const pool = new MonadSubAccountPool({ keyring })
  pool.ensureSize(1)

  const gasReserve = BigInt('20000000000000000') // 0.02 MON headroom for gas fees
  console.log('\n== Funding sub-account 0 from the main account ==')
  const [funded] = await pool.fundAll({
    mainAccountSigner,
    burnValue: minBurnValueWei,
    gasReserve,
  })
  console.log(
    `Funded ${funded.address} with ${funded.fundedValue} wei, tx ${funded.txHash}`,
  )
  await waitForConfirmation(mainAccountSigner, funded.txHash, 'funding tx')
  console.log('Funding tx confirmed on-chain.')

  // --- 2. Build the (opaque, unencrypted-for-this-demo -- see file header) message payload. ---
  const message = {
    from: mainWallet.address,
    demo: 'ticket-8-e2e-demo',
    text: 'Hello over Monad testnet via a real Stamp burn + cashweb-registry relay.',
    sentAt: new Date().toISOString(),
  }
  const encryptedPayload = new TextEncoder().encode(JSON.stringify(message))

  // --- 3. Stamp + relay the message. ---
  const leaseManager = new SubAccountLeaseManager(pool)
  const stampClient = new MonadStampClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl,
  })

  console.log('\n== Submitting the stamped message to the relay ==')
  const result = await stampClient.submitStampedMessage({
    encryptedPayload,
    burnAddress,
    burnValueWei: minBurnValueWei,
  })

  console.log('Relay accepted the message.')
  console.log(`  payload_hash: ${result.payloadHashHex}`)
  console.log(`  burn tx hash: ${result.txHash}`)
  console.log(
    `  sender (recovered on relay from raw_burn_tx): 0x${Buffer.from(
      result.stored.senderAddress,
    ).toString('hex')}`,
  )
  console.log(
    `  sub-account leased: index ${result.leaseIndex} (now 'spent', never reused)`,
  )

  // --- 4. Prove GET /message/monad/:payload_hash round-trips the same thing. ---
  console.log(
    '\n== Fetching the message back via GET /message/monad/:payload_hash ==',
  )
  const fetched = await stampClient.fetchStoredMessage(result.payloadHashHex)
  if (!fetched)
    throw new Error('expected the just-stored message to be fetchable')
  const fetchedText = new TextDecoder().decode(
    fetched.message?.encryptedPayload,
  )
  console.log(
    `Fetched payload matches: ${fetchedText === JSON.stringify(message)}`,
  )
  const fetchedTxHashHex = `0x${Buffer.from(fetched.txHash).toString('hex')}`
  console.log(
    `Fetched tx_hash matches: ${
      fetchedTxHashHex.toLowerCase() === result.txHash.toLowerCase()
    }`,
  )

  // --- Hand off the broadcast tx hash for independent, separate-process on-chain verification. ---
  const handoffPath = resolve(process.cwd(), '/tmp/e2e-demo-stamp-tx.json')
  writeFileSync(
    handoffPath,
    JSON.stringify(
      {
        txHash: result.txHash,
        payloadHashHex: result.payloadHashHex,
        burnAddress,
      },
      null,
      2,
    ),
  )
  console.log(
    `\nWrote handoff file for independent verification: ${handoffPath}`,
  )
  console.log(
    'Run: node /tmp/monad-e2e-demo/verify-onchain-tx.livecheck.js ' +
      result.txHash,
  )
  console.log('\nAll steps completed.')
}

main().catch(err => {
  console.error('\nE2E DEMO FAILED:', err)
  process.exit(1)
})
