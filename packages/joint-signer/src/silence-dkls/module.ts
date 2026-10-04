/**
 * The part of our forked DKLs23 WebAssembly module
 * (`third_party/silent-shard-dkls23-ll`, node and web builds) this backend
 * uses, as structural types. The backend takes the loaded module as a value
 * and never imports a build itself.
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

/** A signing session bound to one digest. */
export interface DklsSignSession {
  free(): void
  toBytes(): Uint8Array
  createFirstMessage(): DklsMessage
  handleMessages(messages: DklsMessage[], seed?: Uint8Array): DklsMessage[]
  /** This party's partial signature for the session's digest. */
  lastMessage(): DklsMessage
  /** Consumes the session. Returns [r, s], 32 bytes each. */
  combine(messages: DklsMessage[]): unknown[]
}

/** A pre-signing session bound to one digest and one lock. */
export interface DklsAdaptorSignSession {
  free(): void
  toBytes(): Uint8Array
  readonly lockPoint: Uint8Array
  createFirstMessage(): DklsMessage
  handleMessages(messages: DklsMessage[], seed?: Uint8Array): DklsMessage[]
  lastMessage(): DklsMessage
  /** Consumes the session. Returns the 162-byte encrypted signature. */
  combine(messages: DklsMessage[]): Uint8Array
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
      messageHash: Uint8Array,
      context: Uint8Array,
      seed?: Uint8Array,
    ): DklsSignSession
    fromBytes(bytes: Uint8Array): DklsSignSession
  }
  readonly AdaptorSignSession: {
    /**
     * Consumes the key share object. Throws unless every proof of the lock
     * verifies for `keyId` and `proverId`, and, when `localId` is
     * `proverId`, unless `opening` opens the lock.
     */
    create(
      keyshare: DklsKeyshare,
      chainPath: string,
      messageHash: Uint8Array,
      lock: Uint8Array,
      keyId: Uint8Array,
      proverId: Uint8Array,
      verifierId: Uint8Array,
      localId: Uint8Array,
      opening?: Uint8Array,
      seed?: Uint8Array,
    ): DklsAdaptorSignSession
    fromBytes(bytes: Uint8Array): DklsAdaptorSignSession
  }
  readonly Keyshare: {
    fromBytes(bytes: Uint8Array): DklsKeyshare
  }
  readonly Message: {
    new (payload: Uint8Array, from: number, to?: number): DklsMessage
  }
  /** Verifies a lock's proofs and returns its 33-byte lock point. */
  verifyLock(
    lock: Uint8Array,
    keyId: Uint8Array,
    proverId: Uint8Array,
  ): Uint8Array
}
