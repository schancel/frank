import { JsonRpcProvider } from 'ethers'

import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import { MonadHttpClient } from '@frank/wallet/monad-http'
import {
  MonadTopicPostClient,
  quoteMonadTopicBurnGasReserve,
} from '@frank/wallet/monad-topic-post-client'
import { fetchMonadTopicPostsSince } from '@frank/wallet/monad-topic-tally-client'
import { openMonadWalletBundle } from '@frank/wallet/storage/monad-wallet-bundle'
import { InMemoryStampAttemptJournal } from '@frank/wallet/storage/stamp-attempt-journal'
import { InMemoryStampPaymentJournal } from '@frank/wallet/storage/stamp-payment-journal'

import { loadConfig, loadIdentity, resolveDataDir } from '../config'
import {
  formatMonAndWei,
  outputError,
  outputResult,
  parseMonOrWei,
} from '../util'

export interface TopicPostOptions {
  burn?: string
  dataDir?: string
  password?: string
  json?: boolean
}

export interface TopicReadOptions {
  since?: string
  dataDir?: string
  json?: boolean
}

export async function topicPostCommand(
  topic: string,
  content: string,
  options: TopicPostOptions,
): Promise<void> {
  let bundle: Awaited<ReturnType<typeof openMonadWalletBundle>> | undefined

  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const burnValueWei = options.burn
      ? parseMonOrWei(options.burn)
      : 10000000000000000n // 0.01 MON default

    const { identity, mnemonic, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    const provider = new JsonRpcProvider(config.rpcUrl)
    const httpClient = new MonadHttpClient({ rpcUrl: config.rpcUrl })

    bundle = await openMonadWalletBundle({
      location: walletDir,
      seed: { mnemonic, passphrase: '' },
    })

    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: identity.toPrivateKeyHex(),
      provider,
      httpClient,
    })

    const gasReserveWei = await quoteMonadTopicBurnGasReserve({
      signer: mainAccountSigner,
      burnAddress: config.stampBurnAddress,
    })

    const preparation = await bundle.pool.prepareBurnAccount({
      mainAccountSigner,
      provider,
      burnValueWei,
      gasReserveWei,
    })
    const leaseIndex = preparation.index

    const network =
      config.networkTag === 'MONT'
        ? 'monad-testnet'
        : config.networkTag === 'MON1'
        ? 'monad-mainnet'
        : config.networkTag

    const client = new MonadTopicPostClient({
      pool: bundle.pool,
      leaseManager: bundle.leaseManager,
      provider,
      httpClient,
      changePool: bundle.changePool,
      stampPaymentJournal: new InMemoryStampPaymentJournal(),
      stampAttemptJournal: new InMemoryStampAttemptJournal(),
      walletState: bundle,
      relayBaseUrl: config.relayUrl,
      forumBurnAddress: config.stampBurnAddress,
      forumChainId: BigInt(config.chainId),
      cborNetwork: network,
    })

    const postResult = await client.submitTopicPost({
      topic,
      entries: [{ kind: 'post', message: content }],
      direction: 'up',
      burnAddress: config.stampBurnAddress,
      voteWeightWei: burnValueWei,
      leaseIndex,
    })

    const result = {
      topic,
      payloadHashHex: postResult.payloadHashHex,
      burnTxHash: postResult.txHash,
      burnWeightWei: burnValueWei.toString(),
      author: identity.displayAddress,
      status: 'delivered',
    }

    outputResult(
      result,
      () => {
        console.log(`Topic broadcast submitted successfully:`)
        console.log(`  Topic:         ${result.topic}`)
        console.log(`  Payload Hash:  ${result.payloadHashHex}`)
        console.log(`  Burn Tx Hash:  ${result.burnTxHash}`)
        console.log(`  Author:        ${result.author}`)
        console.log(`  Burn Weight:   ${formatMonAndWei(burnValueWei)}`)
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  } finally {
    try {
      await bundle?.close()
    } catch {}
  }
}

export async function topicReadCommand(
  topic: string,
  options: TopicReadOptions,
): Promise<void> {
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)

    const sinceMs = options.since ? parseInt(options.since, 10) : 0
    const network =
      config.networkTag === 'MONT'
        ? 'monad-testnet'
        : config.networkTag === 'MON1'
        ? 'monad-mainnet'
        : config.networkTag

    const posts = await fetchMonadTopicPostsSince({
      relayBaseUrl: config.relayUrl,
      topic,
      sinceMs,
      policy: {
        network,
        chainId: BigInt(config.chainId),
        burnAddress: config.stampBurnAddress,
      },
    })

    outputResult(
      posts,
      () => {
        if (posts.length === 0) {
          console.log(`No posts found for topic "${topic}".`)
          return
        }
        console.log(`Feed items for topic "${topic}" (${posts.length}):\n`)
        for (const post of posts) {
          const timestampStr =
            post.timestamp instanceof Date
              ? post.timestamp.toISOString()
              : String(post.timestamp)
          const messageContent = post.entries
            .filter(e => e.kind === 'post')
            .map(e => e.message || e.title || e.url || '')
            .join('\n')

          console.log(`[${timestampStr}] Author: ${post.poster}`)
          console.log(`  Digest:  ${post.payloadDigest}`)
          console.log(
            `  Weight:  ${formatMonAndWei(BigInt(post.voteWeightWei))}`,
          )
          console.log(`  Content: ${messageContent}\n`)
        }
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}
