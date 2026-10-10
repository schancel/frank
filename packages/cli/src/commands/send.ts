import { computeAddress, getAddress } from 'ethers'

import { openCliAccount, type CliAccount } from '../account'
import { loadConfig, resolveDataDir } from '../config'
import {
  formatMonAndWei,
  outputError,
  outputResult,
  parseMonOrWei,
} from '../util'
import { mailSendCommand } from './mail'

export interface SendCommandOptions {
  stamp?: string
  relay?: string
  dataDir?: string
  password?: string
  json?: boolean
  subject?: string
  conversationId?: string
  inReplyTo?: string
  messageId?: string
  frankMessageId?: string
  gateway?: string
}

export async function sendCommand(
  recipientInput: string,
  message: string,
  options: SendCommandOptions,
): Promise<void> {
  let account: CliAccount | undefined

  try {
    const trimmedRecipient = recipientInput.trim()
    if (trimmedRecipient.includes('@')) {
      return await mailSendCommand(trimmedRecipient, message, options)
    }

    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const relayUrl = (options.relay ?? config.relayUrl).replace(/\/+$/, '')

    const stampValueWei = options.stamp
      ? parseMonOrWei(options.stamp)
      : 10000000000000000n // 0.01 MON default

    // The recipient is an account address, or the account's compressed public key.
    let toAddress: string
    if (/^0x[0-9a-fA-F]{40}$/.test(trimmedRecipient)) {
      toAddress = getAddress(trimmedRecipient)
    } else if (/^(02|03)[0-9a-fA-F]{64}$/.test(trimmedRecipient)) {
      toAddress = computeAddress('0x' + trimmedRecipient)
    } else {
      throw new Error(
        `Recipient must be an Ethereum/Monad address (0x...) or a 33-byte compressed hex public key (02.../03...), got: "${recipientInput}"`,
      )
    }

    account = await openCliAccount({ dataDir, config, relayUrl })
    let payloadDigest: string
    try {
      payloadDigest = await account.send(
        toAddress,
        [{ type: 'text', text: message }],
        stampValueWei,
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        stampValueWei > 0n
          ? `${reason}\nA paid message is paid from this account's own address ${account.mainAccount}: it must hold the stamp (${formatMonAndWei(stampValueWei)}) and its fee. Fund it, or send a free message with --stamp 0.`
          : reason,
      )
    }

    const result = {
      status: 'delivered',
      recipient: toAddress,
      sender: account.address,
      payloadDigest,
      stampValueWei: stampValueWei.toString(),
      relayUrl,
    }

    outputResult(
      result,
      () => {
        console.log('Direct message delivered:')
        console.log(`  Payload Digest:  ${result.payloadDigest}`)
        console.log(`  Sender:          ${result.sender}`)
        console.log(`  Recipient:       ${result.recipient}`)
        console.log(`  Relay URL:       ${result.relayUrl}`)
        console.log(`  Stamp Value:     ${formatMonAndWei(stampValueWei)}`)
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  } finally {
    try {
      await account?.close()
    } catch {}
  }
}
