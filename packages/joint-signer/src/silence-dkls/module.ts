/**
 * The part of `@silencelaboratories/dkls-wasm-ll-*` 1.2.0 this backend uses,
 * as structural types. The node, web and bundler builds all satisfy it, so the
 * backend takes the loaded module as a value and never imports a build itself.
 */

export interface DklsMessage {
  free(): void
  readonly payload: Uint8Array
}

export interface DklsKeyshare {
  free(): void
  toBytes(): Uint8Array
  readonly publicKey: Uint8Array
  readonly partyId: number
  readonly participants: number
  readonly threshold: number
}

export interface DklsKeygenSession {
  free(): void
  toBytes(): Uint8Array
  createFirstMessage(): DklsMessage
  calculateChainCodeCommitment(): Uint8Array
  handleMessages(
    messages: DklsMessage[],
    commitments?: Uint8Array[],
    seed?: Uint8Array,
  ): DklsMessage[]
  /** Consumes the session. */
  keyshare(): DklsKeyshare
}

export interface DklsSignSession {
  free(): void
  toBytes(): Uint8Array
  createFirstMessage(): DklsMessage
  handleMessages(messages: DklsMessage[], seed?: Uint8Array): DklsMessage[]
  lastMessage(messageHash: Uint8Array): DklsMessage
  /** Consumes the session. Returns [r, s], 32 bytes each. */
  combine(messages: DklsMessage[]): unknown[]
}

export interface SilenceDklsModule {
  readonly KeygenSession: {
    new (
      participants: number,
      threshold: number,
      partyId: number,
      seed?: Uint8Array,
    ): DklsKeygenSession
    fromBytes(bytes: Uint8Array): DklsKeygenSession
  }
  readonly SignSession: {
    /** Consumes the key share object. */
    new (
      keyshare: DklsKeyshare,
      chainPath: string,
      seed?: Uint8Array,
    ): DklsSignSession
    fromBytes(bytes: Uint8Array): DklsSignSession
  }
  readonly Keyshare: {
    fromBytes(bytes: Uint8Array): DklsKeyshare
  }
  readonly Message: {
    new (payload: Uint8Array, from: number, to?: number): DklsMessage
  }
}
