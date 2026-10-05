/* tslint:disable */
/* eslint-disable */
/**
* Verifies a lock (see `VerifiedLock::verify`) and returns its 33-byte lock
* point. Throws if any proof fails.
* @param {Uint8Array} lock
* @param {Uint8Array} key_id
* @param {Uint8Array} prover_id
* @returns {Uint8Array}
*/
export function verifyLock(lock: Uint8Array, key_id: Uint8Array, prover_id: Uint8Array): Uint8Array;
/**
* A two-party adaptor pre-signing session for one digest and one lock.
*/
export class AdaptorSignSession {
  free(): void;
/**
* Deserialize session from array of bytes.
* @param {Uint8Array} bytes
* @returns {AdaptorSignSession}
*/
  static fromBytes(bytes: Uint8Array): AdaptorSignSession;
/**
* Returns the last message: this party's partial signature and its
* response to the joint proof challenge.
* @returns {Message}
*/
  lastMessage(): Message;
/**
* Handle a batch of messages and return the messages to send.
* Any error leaves the session failed for good.
* @param {(Message)[]} msgs
* @param {Uint8Array | undefined} [seed]
* @returns {(Message)[]}
*/
  handleMessages(msgs: (Message)[], seed?: Uint8Array): (Message)[];
/**
* Create the first message.
* @returns {Message}
*/
  createFirstMessage(): Message;
/**
* Creates a session. Throws if the lock's proofs do not verify for
* `key_id` and `prover_id`, or if this party is the lock's holder
* (`local_id` equals `prover_id`) and `opening` does not open the lock.
*
* `opening` is `t` (32 bytes) for a point lock or `s || v` (32 + 4
* bytes, `v` big-endian) for a commitment lock. The holder must pass
* it; the other party must not.
* @param {Keyshare} keyshare
* @param {string} chain_path
* @param {Uint8Array} message_hash
* @param {Uint8Array} lock
* @param {Uint8Array} key_id
* @param {Uint8Array} prover_id
* @param {Uint8Array} verifier_id
* @param {Uint8Array} local_id
* @param {Uint8Array | undefined} [opening]
* @param {Uint8Array | undefined} [seed]
* @returns {AdaptorSignSession}
*/
  static create(keyshare: Keyshare, chain_path: string, message_hash: Uint8Array, lock: Uint8Array, key_id: Uint8Array, prover_id: Uint8Array, verifier_id: Uint8Array, local_id: Uint8Array, opening?: Uint8Array, seed?: Uint8Array): AdaptorSignSession;
/**
* Combine the last messages and return the 162-byte encrypted
* signature `R || R_a || s_a || b || c`, verified. Never returns an
* ordinary signature. Consumes the session.
* @param {(Message)[]} msgs
* @returns {Uint8Array}
*/
  combine(msgs: (Message)[]): Uint8Array;
/**
* Serialize session into array of bytes.
* @returns {Uint8Array}
*/
  toBytes(): Uint8Array;
/**
* The lock point `T`, 33 bytes.
*/
  readonly lockPoint: Uint8Array;
}
/**
*/
export class KeygenSession {
  free(): void;
/**
* @param {Uint8Array} bytes
* @returns {KeygenSession}
*/
  static fromBytes(bytes: Uint8Array): KeygenSession;
/**
* @param {(Message)[]} msgs
* @param {Array<any> | undefined} [commitments]
* @param {Uint8Array | undefined} [seed]
* @returns {(Message)[]}
*/
  handleMessages(msgs: (Message)[], commitments?: Array<any>, seed?: Uint8Array): (Message)[];
/**
* @param {Keyshare} oldshare
* @param {Uint8Array} lost_shares
* @param {Uint8Array | undefined} [seed]
* @returns {KeygenSession}
*/
  static initKeyRecovery(oldshare: Keyshare, lost_shares: Uint8Array, seed?: Uint8Array): KeygenSession;
/**
* @param {Keyshare} oldshare
* @param {Uint8Array | undefined} [seed]
* @returns {KeygenSession}
*/
  static initKeyRotation(oldshare: Keyshare, seed?: Uint8Array): KeygenSession;
/**
* @returns {Message}
*/
  createFirstMessage(): Message;
/**
* @returns {Uint8Array}
*/
  calculateChainCodeCommitment(): Uint8Array;
/**
* @param {number} participants
* @param {number} threshold
* @param {number} party_id
* @param {Uint8Array} pk
* @param {Uint8Array} lost_shares
* @param {Uint8Array | undefined} [seed]
* @returns {KeygenSession}
*/
  static initLostShareRecovery(participants: number, threshold: number, party_id: number, pk: Uint8Array, lost_shares: Uint8Array, seed?: Uint8Array): KeygenSession;
/**
* @param {number} participants
* @param {number} threshold
* @param {number} party_id
* @param {Uint8Array | undefined} [seed]
*/
  constructor(participants: number, threshold: number, party_id: number, seed?: Uint8Array);
/**
* @returns {Error | undefined}
*/
  error(): Error | undefined;
/**
* Finish key generation session and return resulting key share.
* This nethod consumes the session and deallocates it in any
* case, even if the session is not finished and key share is
* not avialable or an error occured before.
* @returns {Keyshare}
*/
  keyshare(): Keyshare;
/**
* @returns {Uint8Array}
*/
  toBytes(): Uint8Array;
}
/**
*/
export class Keyshare {
  free(): void;
/**
* Create an instance of keyshare from passed array of bytes.
* @param {Uint8Array} bytes
* @returns {Keyshare}
*/
  static fromBytes(bytes: Uint8Array): Keyshare;
/**
* Depricated method, the method does nothing.
* It exists for backward compatibility only
* @param {Keyshare} _oldshare
*/
  finishKeyRotation(_oldshare: Keyshare): void;
/**
* Serialize keyshare into array of bytes.
* @returns {Uint8Array}
*/
  toBytes(): Uint8Array;
/**
*/
  readonly participants: number;
/**
*/
  readonly partyId: number;
/**
*/
  readonly publicKey: Uint8Array;
/**
*/
  readonly threshold: number;
}
/**
*/
export class Message {
  free(): void;
/**
* @returns {Message}
*/
  clone(): Message;
/**
* @param {Uint8Array} payload
* @param {number} from
* @param {number | undefined} [to]
*/
  constructor(payload: Uint8Array, from: number, to?: number);
/**
* Source party ID
*/
  from_id: number;
/**
* Payload
*/
  readonly payload: Uint8Array;
/**
* Destination party ID or undefined for broadcast messages
*/
  to_id?: number;
}
/**
*/
export class SignSession {
  free(): void;
/**
* Deserialize session from array of bytes.
* @param {Uint8Array} bytes
* @returns {SignSession}
*/
  static fromBytes(bytes: Uint8Array): SignSession;
/**
* Returns the last message: this party's partial signature for the
* digest the session was created with.
*
* Changed by the Frank fork (2026-10-04): upstream took the digest
* here.
* @returns {Message}
*/
  lastMessage(): Message;
/**
* Handle a batch of messages.
* Decode, process and return an array messages to send to other parties.
* @param {(Message)[]} msgs
* @param {Uint8Array | undefined} [seed]
* @returns {(Message)[]}
*/
  handleMessages(msgs: (Message)[], seed?: Uint8Array): (Message)[];
/**
* Create a fist message and change session state from Init to WaitMg1.
* @returns {Message}
*/
  createFirstMessage(): Message;
/**
* Combine last messages and return signature as [R, S].
* R, S are 32 byte UintArray.
*
* This method consumes the session and deallocates all
* internal data.
* @param {(Message)[]} msgs
* @returns {Array<any>}
*/
  combine(msgs: (Message)[]): Array<any>;
/**
* Create a new session.
*
* Changed by the Frank fork (2026-10-04): the 32-byte digest to sign
* and a context both parties agree on (any bytes, may be empty) are
* given here and bound into the session. The session can sign nothing
* else, and two parties that disagree on either stop in round 2.
* @param {Keyshare} keyshare
* @param {string} chain_path
* @param {Uint8Array} message_hash
* @param {Uint8Array} context
* @param {Uint8Array | undefined} [seed]
*/
  constructor(keyshare: Keyshare, chain_path: string, message_hash: Uint8Array, context: Uint8Array, seed?: Uint8Array);
/**
* Return an error message, if any.
* @returns {Error | undefined}
*/
  error(): Error | undefined;
/**
* Serialize session into array of bytes.
* @returns {Uint8Array}
*/
  toBytes(): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_keygensession_free: (a: number) => void;
  readonly keygensession_calculateChainCodeCommitment: (a: number, b: number) => void;
  readonly keygensession_createFirstMessage: (a: number, b: number) => void;
  readonly keygensession_error: (a: number) => number;
  readonly keygensession_fromBytes: (a: number, b: number) => number;
  readonly keygensession_handleMessages: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly keygensession_initKeyRecovery: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly keygensession_initKeyRotation: (a: number, b: number, c: number, d: number) => void;
  readonly keygensession_initLostShareRecovery: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
  readonly keygensession_keyshare: (a: number, b: number) => void;
  readonly keygensession_new: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly keygensession_toBytes: (a: number, b: number) => void;
  readonly __wbg_signsession_free: (a: number) => void;
  readonly signsession_combine: (a: number, b: number, c: number, d: number) => void;
  readonly signsession_createFirstMessage: (a: number, b: number) => void;
  readonly signsession_error: (a: number) => number;
  readonly signsession_fromBytes: (a: number, b: number) => number;
  readonly signsession_handleMessages: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly signsession_lastMessage: (a: number, b: number) => void;
  readonly signsession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
  readonly signsession_toBytes: (a: number, b: number) => void;
  readonly __wbg_adaptorsignsession_free: (a: number) => void;
  readonly adaptorsignsession_combine: (a: number, b: number, c: number, d: number) => void;
  readonly adaptorsignsession_create: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number) => void;
  readonly adaptorsignsession_createFirstMessage: (a: number, b: number) => void;
  readonly adaptorsignsession_fromBytes: (a: number, b: number, c: number) => void;
  readonly adaptorsignsession_handleMessages: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly adaptorsignsession_lastMessage: (a: number, b: number) => void;
  readonly adaptorsignsession_lockPoint: (a: number) => number;
  readonly adaptorsignsession_toBytes: (a: number, b: number) => void;
  readonly verifyLock: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly __wbg_keyshare_free: (a: number) => void;
  readonly keyshare_finishKeyRotation: (a: number, b: number) => void;
  readonly keyshare_fromBytes: (a: number, b: number, c: number) => void;
  readonly keyshare_participants: (a: number) => number;
  readonly keyshare_partyId: (a: number) => number;
  readonly keyshare_publicKey: (a: number) => number;
  readonly keyshare_threshold: (a: number) => number;
  readonly keyshare_toBytes: (a: number, b: number) => void;
  readonly __wbg_get_message_from_id: (a: number) => number;
  readonly __wbg_get_message_to_id: (a: number) => number;
  readonly __wbg_message_free: (a: number) => void;
  readonly __wbg_set_message_from_id: (a: number, b: number) => void;
  readonly __wbg_set_message_to_id: (a: number, b: number) => void;
  readonly message_clone: (a: number) => number;
  readonly message_create: (a: number, b: number, c: number) => number;
  readonly message_payload: (a: number) => number;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
