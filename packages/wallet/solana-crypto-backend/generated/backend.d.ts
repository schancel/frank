/* tslint:disable */
/* eslint-disable */

/**
 * Experimental private host handle. No key material or arbitrary signing exports.
 */
export class RecipientCustody {
    free(): void;
    [Symbol.dispose](): void;
    close(): void;
    deriveDestination(intent: string): string;
    constructor(account_id: Uint8Array, chain_identifier: string, seed: Uint8Array);
    primaryPublicKey(): Uint8Array;
    signPrimaryTransfer(descriptor: string, spend: string, authorization: string): string;
    signReceivedTransfer(received: string, descriptor: string, spend: string, authorization: string): string;
    validateReceivedDescriptor(received: string): Uint8Array;
}

/**
 * Estimation only. Never an authorization or an attestation of the final fee.
 */
export function feeProbeMessage(request: string): Uint8Array;

/**
 * Public construction: no custody scope, secret material, signing or submission.
 */
export function unsignedTransferMessage(request: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_recipientcustody_free: (a: number, b: number) => void;
    readonly feeProbeMessage: (a: number, b: number) => [number, number, number, number];
    readonly recipientcustody_close: (a: number) => void;
    readonly recipientcustody_deriveDestination: (a: number, b: number, c: number) => [number, number, number, number];
    readonly recipientcustody_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly recipientcustody_primaryPublicKey: (a: number) => [number, number, number, number];
    readonly recipientcustody_signPrimaryTransfer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly recipientcustody_signReceivedTransfer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly recipientcustody_validateReceivedDescriptor: (a: number, b: number, c: number) => [number, number, number, number];
    readonly unsignedTransferMessage: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
