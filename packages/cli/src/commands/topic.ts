import { createEvmChain } from '@frank/wallet/chain/evm-chain'
import { getChainRegistryByNetworkTag } from '@frank/wallet/chain/chains-registry'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { TopicPostClient } from '@frank/wallet/topic-post-client'
import { fetchMonadTopicPostsSince } from '@frank/wallet/evm-topic-tally-client'

import { loadConfig, loadIdentity, resolveDataDir, type SignetConfig } from '../config'
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

/** Resolve the saved CLI wire tag once; wallet state and RPC routing use its canonical ID. */
function resolveTopicPostNetwork(config: SignetConfig) {
  const network = getChainRegistryByNetworkTag(config.networkTag)
  if (!network || network.family !== 'evm' || network.nativeChainId === undefined)
    throw new Error(`Unsupported EVM Forum network tag: ${config.networkTag}`)
  if (!Number.isSafeInteger(config.chainId) || BigInt(config.chainId) !== BigInt(network.nativeChainId))
    throw new Error(`Saved chain ID does not match Forum network ${network.id}`)
  return network
}

export async function topicPostCommand(
  topic: string,
  content: string,
  options: TopicPostOptions,
): Promise<void> {
  let wallet: EvmChainWalletHandle | undefined

  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const network = resolveTopicPostNetwork(config)
    const burnValueWei = options.burn
      ? parseMonOrWei(options.burn)
      : 10000000000000000n // 0.01 MON default

    const { identity, mnemonic, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    const chain = createEvmChain({
      chainIdentifier: network.id,
      networkId: network.id,
      rpcChain: network.id,
      chainId: BigInt(network.nativeChainId!),
      spendSpacingBlocks: network.spendSpacingBlocks,
      reserveBalanceWei: network.reserveBalanceWei === undefined
        ? undefined : BigInt(network.reserveBalanceWei),
      paymentPollIntervalMs: network.paymentPollIntervalMs,
      defaultTopicVoteValueWei: burnValueWei,
      relayBaseUrl: config.relayUrl,
      networkTag: config.networkTag,
      stampBurnAddress: config.stampBurnAddress,
      walletStorageLocation: walletDir,
      subAccountPoolSize: 1,
    })
    wallet = (await chain.createWallet({
      mnemonic,
      passphrase: '',
    })) as EvmChainWalletHandle
    await wallet.getBalanceParts?.()
    const client = new TopicPostClient(wallet)

    const postResult = await client.submitTopicPost({
      topic,
      entries: [{ kind: 'post', message: content }],
      direction: 'up',
      amountAtomic: burnValueWei,
    })

    const result = {
      topic,
      payloadHashHex: postResult.payloadHashHex,
      burnTxHash: postResult.transactionHashes[0],
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
      await wallet?.close()
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
