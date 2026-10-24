/** Test-only synthetic services. Real application stores, routing and rendering are untouched. */
import { reactive } from 'vue'
import type { AccountSessionState } from '../../../src/accounts/session.original'
import { getBytes } from 'ethers'
import { activeChain, createEvmChain } from '@frank/wallet/chain'
import type { EvmChainWalletHandle } from '@frank/wallet/chain'
import { fixedStampDefault } from '@frank/wallet/oracle/stamp-policy.testutil'
import vectors from '../../../../packages/domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '@frank/wallet/evm-wallet-material'

export const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
export const CONVERSATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const status = reactive<AccountSessionState>({
  status: 'loading',
  revision: 1,
  account: null,
  pending: null,
  pendingReady: false,
  pendingIdentityAddress: null,
  pendingError: null,
  error: null,
})
export const observations = {
  ready: false,
  sends: [] as {
    entered: number
    released?: number
    text: string
    itemTypes: string[]
  }[],
  errors: [] as string[],
}
let wallet: EvmChainWalletHandle | undefined
let opening: Promise<void> | undefined
const held = new Map<number, () => void>()
export const peekWallet = () => wallet
export const unsupported = (operation: string): never => {
  throw new Error(`Fixture does not implement ${operation}`)
}
export async function initialize(): Promise<void> {
  return (opening ??= (async () => {
    const output = vectors.vectors[0].outputs
    const domain = <
      P extends
        | 'evm-wallet'
        | 'identity-authentication'
        | 'messaging-encryption',
    >(
      purpose: P,
    ) => ({
      registry: 'frank-domain-roots-v1' as const,
      purpose,
      bytes: getBytes('0x' + output[purpose]),
    })
    const roots: MonadRootBundle = {
      evm: domain('evm-wallet'),
      authentication: domain('identity-authentication'),
      messaging: domain('messaging-encryption'),
    }
    const chain = createEvmChain({
      networkId: 'monad-testnet',
      rpcChain: 'monad-testnet',
      chainId: 10143,
      relayBaseUrl: location.origin + '/fixture',
      networkTag: 'MONT',
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      resolveDefaultStamp: fixedStampDefault(1000n),
      defaultTopicVoteValueWei: 1000n,
      subAccountPoolSize: 0,
      walletStorageLocation: false,
    })
    wallet = (await chain.createWallet(roots)) as EvmChainWalletHandle
    // Real deterministic signing material exists only in this disposable test account. The
    // send boundary below never constructs or broadcasts financial transactions.
    activeChain.nativeTransfers.getBalance = async () => 10n ** 18n
    activeChain.directMessages.defaultStampQuote = async () => ({
      status: 'available',
      chainIdentifier: 'monad-testnet',
      amount: 1000n,
      targetAmount: 1000n,
      minimumStamp: 1n,
    })
    activeChain.directMessages.minimumStamp = async () => 1n
    activeChain.directMessages.quoteStamp = async ({ stampValue }) => ({
      status: 'available',
      chainIdentifier: 'monad-testnet',
      stampValueAtomic: stampValue,
      spendableCapacityAtomic: 10n ** 18n,
      maximumNativeFeeAtomic: 1n,
    })
    activeChain.directMessages.chainHealth = () => ({ reachable: true })
    activeChain.directMessages.send = async params => {
      const slot = observations.sends.length
      observations.sends.push({
        entered: performance.now(),
        text: params.items
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join(' '),
        itemTypes: params.items.map(item => item.type),
      })
      await new Promise<void>(resolve => held.set(slot, resolve))
      observations.sends[slot].released = performance.now()
      return {
        payloadDigest: (slot + 1).toString(16).padStart(64, '0'),
        stampValueWei: params.stampValue ?? 1000n,
        stampPayments: [],
        preparationTxHashes: [],
      }
    }
    activeChain.directMessages.reconcileAttempts = async () => ({})
    activeChain.directMessages.attemptOf = async () => undefined
    activeChain.directMessages.unattributedAttempts = async () => []
    activeChain.topics.discoverTopics = async () => []
    activeChain.topics.fetchByTopic = async () => []
    activeChain.topics.reconcileOperations = async () => undefined
    status.account = {
      displayName: 'Synthetic sender',
      descriptor: 'test-only-synthetic-descriptor',
      fingerprint: 'test-only-fingerprint',
      receipt: {
        schema: 1,
        policy: 'browser-preview-aes-gcm-v1',
        previousRevision: 0,
        revision: 1,
        operationId: 'synthetic-browser-initialize',
        context: {
          accountId: 'synthetic-browser-baseline',
          creationId: 'synthetic-browser-initialize',
          recoveryFormat: 'codex32-master-v1',
          registry: 'frank-domain-roots-v1',
          purposes: [
            'evm-wallet',
            'identity-authentication',
            'messaging-encryption',
          ],
          custodyEpoch: 0,
          recoveryFingerprint: 'test-only-fingerprint',
          retirementContext: 'test-only',
        },
      },
    }
    status.status = 'ready'
  })())
}
export async function getWallet() {
  await initialize()
  if (!wallet) throw new Error('Fixture wallet missing')
  return wallet
}
export function release(slot: number) {
  const finish = held.get(slot)
  if (!finish) throw new Error('No pending synthetic send')
  held.delete(slot)
  finish()
}
