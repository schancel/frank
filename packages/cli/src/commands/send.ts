import { computeAddress, getAddress, JsonRpcProvider } from 'ethers'

import { buildEnvelope } from '@frank/cashweb/relay/monad-message-envelope'
import { serializeMessageItems } from '@frank/wallet/chain/monad-chain'
import { MonadHttpClient } from '@frank/wallet/monad-http'
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import { fetchMonadProfile } from '@frank/wallet/monad-identity'
import {
  MonadStampClient,
  quoteMonadStampPaymentGasReserve,
} from '@frank/wallet/monad-stamp-client'
import { openMonadWalletBundle } from '@frank/wallet/storage/monad-wallet-bundle'
import { LevelStampAttemptJournal } from '@frank/wallet/storage/stamp-attempt-journal'
import { LevelStampPaymentJournal } from '@frank/wallet/storage/stamp-payment-journal'

import { loadConfig, loadIdentity, resolveDataDir } from '../config'
import {
  formatMonAndWei,
  outputError,
  outputResult,
  parseMonOrWei,
} from '../util'

export interface SendCommandOptions {
  stamp?: string
  relay?: string
  dataDir?: string
  password?: string
  json?: boolean
}

export async function sendCommand(
  recipientInput: string,
  message: string,
  options: SendCommandOptions,
): Promise<void> {
  let bundle: Awaited<ReturnType<typeof openMonadWalletBundle>> | undefined
  let attemptJournal: LevelStampAttemptJournal | undefined
  let paymentJournal: LevelStampPaymentJournal | undefined

  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const relayUrl = (options.relay ?? config.relayUrl).replace(/\/+$/, '')

    const stampValueWei = options.stamp
      ? parseMonOrWei(options.stamp)
      : 10000000000000000n // 0.01 MON default

    const { identity, mnemonic, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    // Resolve recipient: either 0x address or compressed pubkey hex
    let toAddress: string
    let toPubKey: Buffer

    const trimmedRecipient = recipientInput.trim()
    if (/^0x[0-9a-fA-F]{40}$/.test(trimmedRecipient)) {
      toAddress = getAddress(trimmedRecipient)
      const profile = await fetchMonadProfile({
        relayBaseUrl: relayUrl,
        address: { raw: toAddress },
      })
      if (!profile || !profile.pubKey || profile.pubKey.length === 0) {
        throw new Error(
          `Recipient ${toAddress} has no registered public key on relay ${relayUrl}. Recipient must be registered before sending direct messages.`,
        )
      }
      toPubKey = Buffer.from(profile.pubKey)
    } else if (/^(02|03)[0-9a-fA-F]{64}$/.test(trimmedRecipient)) {
      toPubKey = Buffer.from(trimmedRecipient, 'hex')
      toAddress = computeAddress('0x' + trimmedRecipient)
    } else {
      throw new Error(
        `Recipient must be an Ethereum/Monad address (0x...) or a 33-byte compressed hex public key (02.../03...), got: "${recipientInput}"`,
      )
    }

    const provider = new JsonRpcProvider(config.rpcUrl)
    const httpClient = new MonadHttpClient({ rpcUrl: config.rpcUrl })

    bundle = await openMonadWalletBundle({
      location: walletDir,
      seed: { mnemonic, passphrase: '' },
    })

    attemptJournal = new LevelStampAttemptJournal(walletDir)
    paymentJournal = new LevelStampPaymentJournal(walletDir)
    await Promise.all([attemptJournal.Open(), paymentJournal.Open()])

    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: identity.toPrivateKeyHex(),
      provider,
      httpClient,
    })

    const stampClient = new MonadStampClient({
      pool: bundle.pool,
      leaseManager: bundle.leaseManager,
      provider,
      httpClient,
      changePool: bundle.changePool,
      stampAttemptJournal: attemptJournal,
      stampPaymentJournal: paymentJournal,
      walletState: bundle,
      relayBaseUrl: relayUrl,
    })

    // Replay/resolve pending attempts before new send
    await stampClient.resumePendingAttempts()

    // Quote gas reserve and top up pool if necessary
    const gasReserveWei = await quoteMonadStampPaymentGasReserve({
      signer: mainAccountSigner,
      recipientPublicKey: toPubKey,
    })

    await bundle.pool.prepareStampInventory({
      mainAccountSigner,
      provider,
      stampValueWei,
      gasReserveWei,
    })

    // Build E2E encrypted envelope
    const envelope = buildEnvelope({
      fromAddress: identity.displayAddress,
      fromPrivateKey: identity.toNakamotoPrivateKey(),
      toAddress,
      toPubKey,
      plaintext: serializeMessageItems([{ type: 'text', text: message }]),
      networkTag: config.networkTag,
    })

    // Submit stamped direct message
    const sendResult = await stampClient.submitStampedMessage({
      encryptedPayload: envelope,
      recipientPublicKey: toPubKey,
      stampValueWei,
    })

    const result = {
      status: 'delivered',
      recipient: toAddress,
      sender: identity.displayAddress,
      payloadDigest: sendResult.payloadHashHex,
      stampValueWei: stampValueWei.toString(),
      txHashes: sendResult.txHashes,
      relayUrl,
    }

    outputResult(
      result,
      () => {
        console.log('Direct message sent successfully:')
        console.log(`  Payload Digest:  ${result.payloadDigest}`)
        console.log(`  Sender:          ${result.sender}`)
        console.log(`  Recipient:       ${result.recipient}`)
        console.log(`  Relay URL:       ${result.relayUrl}`)
        console.log(`  Stamp Value:     ${formatMonAndWei(stampValueWei)}`)
        console.log(`  Stamp Payment Transactions:`)
        for (const txHash of result.txHashes) {
          console.log(`    - ${txHash}`)
        }
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  } finally {
    try {
      await attemptJournal?.Close()
    } catch {}
    try {
      await paymentJournal?.Close()
    } catch {}
    try {
      await bundle?.close()
    } catch {}
  }
}
