import { toHex } from '@frank/codec'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import type { Message } from '@frank/cashweb/types/messages'
import { accountSession } from '../accounts/session'
import { store } from '../adapters/level-message-store'
import { captureDirectoryPeer } from './directory-peer'

/** Presentation holds only a reference. The retained owner record grants spending authority. */
export async function captureOutgoingApplicationAuthorization(
  wallet: WalletHandle,
  address: string,
  message: Pick<
    Message,
    | 'applicationAuthorization'
    | 'sealedMessageId'
    | 'conversationId'
    | 'stampValueWei'
  >,
) {
  const reference = message.applicationAuthorization
  if (!reference) return undefined
  if (
    typeof reference.accountId !== 'string' ||
    !reference.accountId ||
    typeof reference.intentKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(reference.intentKey)
  )
    throw new Error('Invalid application delivery authorization reference')
  const account = accountSession.state.account
  const revision = accountSession.state.revision
  const chainIdentifier = activeChain.chainIdentifier
  const assertSession = () => {
    if (
      accountSession.state.status !== 'ready' ||
      accountSession.state.account !== account ||
      accountSession.state.revision !== revision ||
      account?.receipt.context.accountId !== reference.accountId ||
      accountSession.peekWallet() !== wallet ||
      activeChain.chainIdentifier !== chainIdentifier ||
      accountSession.peekWallet()?.chainIdentifier !== chainIdentifier
    )
      throw new Error('Application delivery session changed')
  }
  assertSession()
  const owner = await store
  assertSession()
  const record = await owner.outgoingApplicationMessage(reference)
  assertSession()
  if (
    !record ||
    record.phase !== 'signed' ||
    record.accountId !== reference.accountId ||
    record.intentKey !== reference.intentKey ||
    record.messagingChainIdentifier !== chainIdentifier ||
    record.messageId !== message.sealedMessageId ||
    record.conversationId !== message.conversationId ||
    BigInt(record.stampValueWei) !== message.stampValueWei
  )
    throw new Error(
      'Application delivery authorization unavailable or conflicts',
    )
  const peer = await captureDirectoryPeer(address)
  assertSession()
  if (toHex(peer.publicKey) !== record.recipientPublicKey)
    throw new Error('Application delivery recipient conflicts')
  const stampValue = BigInt(record.stampValueWei)
  return {
    stampValue,
    assertCurrent() {
      assertSession()
      peer.assertCurrent()
      if (
        message.applicationAuthorization !== reference ||
        reference.accountId !== record.accountId ||
        reference.intentKey !== record.intentKey ||
        message.sealedMessageId !== record.messageId ||
        message.conversationId !== record.conversationId ||
        message.stampValueWei !== stampValue
      )
        throw new Error('Application delivery presentation conflicts')
    },
  }
}
