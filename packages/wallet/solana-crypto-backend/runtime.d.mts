export type Bytes32 = readonly number[];
export type TransferAsset =
  | { kind: "native" }
  | { kind: "spl"; mint: Bytes32; tokenProgram: Bytes32 };
export interface SenderIntent {
  chainIdentifier: string;
  asset: TransferAsset;
  recipient: Bytes32;
  operationId: Bytes32;
  memberIndex: number;
  messageContext: Bytes32;
  recipientAmount: string;
}
export interface PublicDescriptor extends SenderIntent {
  ephemeral: Bytes32;
}
export interface PublicDestination {
  descriptor: PublicDescriptor;
  publicKey: Bytes32;
}
export interface TransferSpend {
  chainIdentifier: string;
  asset: TransferAsset;
  owner: Bytes32;
  destination: Bytes32;
  amount: string;
  recentBlockhash: Bytes32;
  operationId: Bytes32;
  messageContext: Bytes32;
  decimals: number | null;
}
export interface TransferAuthorization {
  feeLamports: string;
  maxFeeLamports: string;
  rentLamports: string;
  maxRentLamports: string;
  maxNativeDebitLamports: string;
  createDestinationAta: boolean;
}
export interface SignedTransfer {
  readonly accountId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly message: Uint8Array;
}
export interface ExperimentalCustody {
  primaryPublicKey(): Uint8Array;
  deriveDestination(intent: SenderIntent): PublicDestination;
  signReceivedTransfer(
    received: PublicDestination,
    descriptor: PublicDescriptor,
    spend: TransferSpend,
    authorization: TransferAuthorization
  ): SignedTransfer;
  validateReceivedDescriptor(received: PublicDestination): Uint8Array;
  signPrimaryTransfer(
    descriptor: PublicDescriptor,
    spend: TransferSpend,
    authorization: TransferAuthorization
  ): SignedTransfer;
  close(): void;
}
export function openExperimentalRecipientCustody(options: {
  accountId: Uint8Array;
  chainIdentifier: string;
  seed: Uint8Array;
  wasm: URL | string;
  signal?: AbortSignal;
}): Promise<ExperimentalCustody>;

/** Structural public binding only; the existing signer attests private R/P and ownership. */
export interface UnsignedTransferRequest {
  descriptor: PublicDescriptor;
  spend: TransferSpend;
  authorization: TransferAuthorization;
  source:
    | { kind: "primary" }
    | { kind: "received"; received: PublicDestination };
}
/** Explicit estimation domain. A representative destination does not establish the final fee. */
export interface FeeProbeRequest {
  domain: "frank:solana-custody-fee-probe:v1";
  chainIdentifier: string;
  asset: TransferAsset;
  owner: Bytes32;
  destination: Bytes32;
  amount: string;
  recentBlockhash: Bytes32;
  decimals: number | null;
  createDestinationAta: boolean;
}
export type PublicBuilderWasm =
  | URL
  | string
  | BufferSource
  | WebAssembly.Module;
export function unsignedTransferMessage(
  request: UnsignedTransferRequest,
  wasm: PublicBuilderWasm
): Promise<Uint8Array>;
export function feeProbeMessage(
  request: FeeProbeRequest,
  wasm: PublicBuilderWasm
): Promise<Uint8Array>;
