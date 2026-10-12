import { SigningKey, Wallet, getAddress } from 'ethers'
import type { Bip32DomainRoot } from '../bip32-domain-root'
import { bip32MasterFromDomainRoot } from '../bip32-domain-root'
import { MONAD_IDENTITY_DERIVATION_PATH } from '../monad-identity'
import type { TempoReceiveItem } from './tempo-pathusd-receive'
import { TempoPathUsdReceiveScanner } from './tempo-pathusd-receive'
import {
  TempoPathUsdTransfers,
  type TempoPathUsdOperation,
  type TempoPathUsdRpc,
  type TempoPathUsdSigner,
  type TempoPathUsdFeeAsset,
  type TempoPathUsdQuote,
} from './tempo-pathusd-operation'

type TempoNetwork = 'tempo-testnet' | 'tempo-mainnet'

/** Tempo spends from the existing EVM main-account derivation; no second account/key is created. */
export class TempoPathUsdMainAccount implements TempoPathUsdSigner {
  readonly source: { readonly kind: 'main'; readonly address: string }
  private constructor(private readonly key: SigningKey) {
    this.source = { kind: 'main', address: getAddress(new Wallet(key.privateKey).address).toLowerCase() }
  }

  static fromDomainRoot(root: Bip32DomainRoot<'evm-wallet'>): TempoPathUsdMainAccount {
    const node = bip32MasterFromDomainRoot(root, 'evm-wallet').derivePath(MONAD_IDENTITY_DERIVATION_PATH)
    return new TempoPathUsdMainAccount(new SigningKey(node.privateKey))
  }

  async signDigest(digest: string): Promise<{ r: string; s: string; yParity: 0 | 1 }> {
    const signature = this.key.sign(digest)
    return { r: signature.r, s: signature.s, yParity: signature.yParity as 0 | 1 }
  }
}

/**
 * Disabled wallet-native seam. The host owns RPC endpoint, durable stores, and cross-context
 * locks. Incoming history is derived from the receive batch authority; live balance is read from
 * the verified PathUSD contract, so no second local balance owner can drift after a restart.
 */
export class TempoPathUsdWallet {
  /** Genesis is the only stable checkpoint shared by fresh and restored frontends. */
  readonly receiveStartBlock = 0n

  constructor(
    readonly chainIdentifier: TempoNetwork,
    readonly account: TempoPathUsdSigner,
    private readonly rpc: TempoPathUsdRpc,
    private readonly transfers: TempoPathUsdTransfers,
    private readonly receive: TempoPathUsdReceiveScanner,
  ) {
    if (transfers.chainIdentifier !== chainIdentifier || receive.chainIdentifier !== chainIdentifier)
      throw new Error('Tempo wallet components have different canonical chains')
  }

  get address(): string { return this.account.source.address }

  async balanceAtomic(): Promise<bigint> {
    await this.rpc.verifyChain(this.chainIdentifier)
    return this.rpc.getPathUsdBalance(this.address)
  }

  quote(recipient: string, amountAtomic: bigint): Promise<TempoPathUsdQuote> {
    return this.transfers.quote({ signer: this.account, recipient, amountAtomic })
  }

  prepare(params: {
    operationId: string
    recipient: string
    amountAtomic: bigint
    authorizedFeeAsset: TempoPathUsdFeeAsset
    authorizedFeeCeilingAtomic: bigint
    quotedNonce: bigint
  }): Promise<TempoPathUsdOperation> {
    return this.transfers.prepare({ ...params, signer: this.account })
  }

  submit(operationId: string): Promise<TempoPathUsdOperation> {
    return this.transfers.submit(operationId, this.account)
  }

  reconcile(operationId: string): Promise<TempoPathUsdOperation> {
    return this.transfers.reconcile(operationId)
  }

  replaceFee(operationId: string, authorizedFeeCeilingAtomic: bigint): Promise<TempoPathUsdOperation> {
    return this.transfers.replaceFee(operationId, this.account, authorizedFeeCeilingAtomic)
  }

  async syncReceived(): Promise<{ nextBlock: bigint; delivered: number }> {
    await this.rpc.verifyChain(this.chainIdentifier)
    // The durable batches themselves own incoming facts. Acknowledgement is only delivery to
    // this derived view, so a crash between callback and ACK cannot create a duplicate credit.
    return this.receive.syncOnce(this.address, this.receiveStartBlock, async () => undefined)
  }

  receivedItems(): TempoReceiveItem[] {
    return this.receive.receivedItems(this.address, this.receiveStartBlock)
  }
}
