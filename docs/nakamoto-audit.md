# Nakamoto audit (Phase 0)

Audit of `packages/bitcore-lib-xpi` and of the encryption and stamp-attribution code that a replacement has to respect. No production code was changed for this document. Benchmarks were run outside the repo, in a throwaway directory, on this machine.

Scope of the replacement, decided here and tracked as tickets:

- `packages/nakamoto` (`@frank/nakamoto`) is the chain library.
- `packages/crypto-box` (`@frank/crypto-box`) stays a separate package. Encryption review is a different surface from consensus code, and the relay can migrate later without pulling script and transaction code into every consumer. Folding it into `@frank/nakamoto` was the other option; it is rejected for that reason and recorded as a decision ticket.
- `packages/bitcore-lib-xpi` is not modified. Nothing in `app/` or other `packages/` is rewired in this work.
- Consensus bytes (transaction and block serialization, sighash, script results, address bytes, WIF, signature bytes) must match the chain's own vectors. API shape, errors, and defaults may change. Each deliberate behavior change is a ticket.

BitPay's MIT license and copyright notices stay with anything derived from bitcore-lib. New public names do not use "bitcore" except in attribution.

`docs/protocol/cbor/README.md` is in this tree. S2b defines the version-1 signature algorithm, key-type, and length pairings. S2c reserves encryption-suite identifier `65535` for opaque proof-vector ciphertext and says a production writer MUST NOT emit it. Production suites are allocated only with their nonce, key-agreement, authentication/deniability, and failure rules; version 1 allocates no production encryption suite. The codec does not infer a suite from nonce length. The encryption-suite ticket must cite that file and must not invent a production suite id.

## 1. What the old package is

`packages/bitcore-lib-xpi` version `8.25.31`, `private: true`, `"main": "index.js"`. Description says "Lotus"; `repository.url` still points at BitPay `bitcore-lib-cash`. About 14,500 lines under `lib/` plus `index.js` (measured by `wc -l` on the `lib/**/*.js` sources: the interpreter alone is 2,107 lines, `transaction.js` 1,363, `script.js` 1,174).

Runtime dependencies (`package.json`):

| Package | Pin | Role |
| --- | --- | --- |
| `@abcpros/bitcore-lib` | `^8.25.31` | Declared, not required by `lib/` sources read for this audit |
| `bn.js` | `=4.11.8` | All big integers, including script numbers and private keys |
| `bs58` | `^4.0.1` | Base58 |
| `buffer-compare` | `=1.1.1` | Fallback only. `transaction.js` uses `Buffer.compare \|\| require('buffer-compare')`. On Node, `Buffer.compare` wins |
| `elliptic` | `^6.5.3` | secp256k1 (`lib/crypto/point.js` constructs `new EC('secp256k1')`) |
| `inherits` | `=2.0.1` | Prototype classes |
| `lodash` | `^4.17.20` | Iteration, sorting, cloning, type tests. No `_.isEqual` on secrets was found under `lib/` |

Node `crypto` is required directly by `lib/crypto/hash.js` (`createHash`) and `lib/crypto/random.js` (`randomBytes`). That is Node-only. The browser branch of `Random` uses `window.crypto.getRandomValues` and checks `process.browser`.

Dev tooling: gulp, karma, bower, chai, sinon, `@abcpros/bitcore-build`, `brfs`. Tests are 68 files under `test/`, mocha, including Bitcoin Core JSON vectors (`tx_valid.json`, `tx_invalid.json`, `script_tests.json`, `base58_keys_*.json`) and Lotus fixtures (`test/data/xaddr.json`, `test/data/lotusd/lotus_addresses_valid.json`).

### Module inventory and public exports

`index.js` installs a process-global singleton, then exports:

```
bitcore.versionGuard(global._bitcoreLotus)
global._bitcoreLotus = bitcore.version
```

The guard throws `Error('More than one instance of bitcore-lib-cash found...')` if `global._bitcoreLotus` is already set. The message still says `bitcore-lib-cash`. A second copy of the package in the same process, including a Jest isolate that loads it twice, crashes. Consumers work around that; those workarounds go away only in the deletion ticket.

| Export | Source | Notes |
| --- | --- | --- |
| `version`, `versionGuard` | `index.js` | Global guard |
| `crypto.BN` | `lib/crypto/bn.js` | bn.js subclass |
| `crypto.ECDSA` | `lib/crypto/ecdsa.js` | RFC 6979, low-S, recovery id |
| `crypto.Schnorr` | `lib/crypto/schnorr.js` | BCH-style Schnorr over a digest, not BIP340 tagged hashes |
| `crypto.Hash` | `lib/crypto/hash.js` | Node `createHash` |
| `crypto.Random` | `lib/crypto/random.js` | CSPRNG plus `Math.random` helper |
| `crypto.Point` | `lib/crypto/point.js` | elliptic point |
| `crypto.Signature` | `lib/crypto/signature.js` | DER, compact, tx format |
| `encoding.Base58`, `Base58Check`, `BufferReader`, `BufferWriter`, `Varint` | `lib/encoding/*` | |
| `util.buffer`, `util.js`, `util.preconditions`, `util.base32`, `util.convertBits` | `lib/util/*` | |
| `errors` | `lib/errors/index.js` + `spec.js` | Tree of error constructors, `message` strings, bitcore.io doc links |
| `Address` | `lib/address.js` | CashAddr (BCH alphabet and polymod) plus legacy base58 |
| `XAddress` | `lib/xaddress.js` | Separate Lotus string format. Not a thin wrapper over `Address` |
| `Block`, `MerkleBlock`, `BlockHeader` | `lib/block/*` | 80-byte Bitcoin-shaped header |
| `HDPrivateKey`, `HDPublicKey` | `lib/hdprivatekey.js`, `hdpublickey.js` | BIP32, HMAC-SHA512 key `"Bitcoin seed"` |
| `Networks` | `lib/networks.js` | Mutable global registry. One live network |
| `Opcode` | `lib/opcode.js` | Includes `OP_CHECKDATASIG` (186), `OP_CHECKDATASIGVERIFY` (187), `OP_REVERSEBYTES` (188). No native-introspection range |
| `PrivateKey`, `PublicKey` | `lib/privatekey.js`, `publickey.js` | |
| `Script` | `lib/script/script.js` | Builder, classifier, ASM |
| `Transaction` | `lib/transaction/index.js` | Also `Transaction.sighash` from `lib/transaction/sighash.js` |
| `URI` | `lib/uri.js` | BIP21-style, lodash |
| `Unit` | `lib/unit.js` | BTC, mBTC, bits, satoshis. Factors assume 1e8 |
| `deps.bnjs`, `deps.bs58`, `deps.Buffer`, `deps.elliptic`, `deps._` | `index.js` | Library internals re-exported |

`Script` also exports the interpreter (`lib/script/interpreter.js`) from `lib/script/index.js`. Transaction input classes (`Input`, `PublicKeyHash`, `PublicKey`, `MultiSig`, `MultiSigScriptHash`) are hung off `Transaction.Input`.

There is no `lib/message.js`. The `Message` class in `types.d.ts` is not a runtime export.

### Consumers

Direct `from 'bitcore-lib-xpi'` imports, 29 files. Package dependency declarations: `app/package.json`, `packages/cashweb/package.json`, `packages/wallet/package.json`. TypeScript projects pull in `packages/bitcore-lib-xpi/types.d.ts` from `app/tsconfig.json`, `packages/cashweb/tsconfig.json`, `packages/wallet/tsconfig.json`, `packages/bot/tsconfig.json`. `app/quasar.config.js` aliases the package and pins the nested `bn.js` so the "more than one instance" guard and the exact `bn.js@4.11.8` pin do not fork the singleton.

What they actually call (migration surface, not changed here):

| Area | Files | Uses |
| --- | --- | --- |
| Legacy wallet signing | `packages/cashweb/legacy-wallet/index.ts` | `transaction.sign(signingKeys)` twice (around lines 444 and 604) |
| Script decode | `packages/cashweb/legacy-wallet/lotus-adapter.ts` | `Script` |
| Lotus identity | `packages/cashweb/legacy-wallet/lotus-identity.ts` | `PrivateKey`, `crypto.ECDSA.sign`. Comments document CashAddr vs a from-scratch Lotus encoder, and that `PrivateKey.fromBuffer` forces `compressed: false` |
| Registry | `packages/cashweb/registry/index.ts` | `crypto.Hash.sha256`, `crypto.ECDSA.sign` |
| Relay envelope | `packages/cashweb/relay/monad-message-envelope.ts` | `PrivateKey`, `PublicKey`, `crypto.Random`, `crypto.Hash.sha256hmac`, `PublicKey.point` |
| Relay crypto | `packages/cashweb/relay/crypto.ts` | ECDH via `point.mul`, AES-CBC via forge, stealth and stamp key tweak (`point.add`, `BN.add`) |
| Relay payloads | `relay/index.ts`, `constructors.ts`, `decode-entry.ts`, `encode-entry.ts`, `extension.ts` | `PublicKey`, `Transaction`, `HDPrivateKey`, `crypto.Hash`, `crypto.ECDSA.sign` |
| POP | `packages/cashweb/pop.ts` | `Transaction` |
| Types | `packages/cashweb/types/utxo.ts`, `user-interface.ts` | `PrivateKey`, `PublicKey` as type positions |
| Monad identity | `packages/wallet/monad-identity.ts` | `PrivateKey`, `crypto.ECDSA.sign` over a hash. Address is ethers, not bitcore |
| App | `stores/wallet.ts`, `stores/contacts.ts`, `workers/xpriv_generate.ts`, `pages/Setup.vue`, `pages/AddContact.vue`, `boot/network-prefix.ts`, `utils/formatting.ts`, `utils/address.ts`, `adapters/pinia-chain-adapter.ts`, `components/contacts/ContactItem.vue`, `app/test/jest/__tests__/crypto.test.js` | `HDPrivateKey`, `PublicKey`, `Address`, `Networks`, `crypto.Hash`, `PrivateKey` |

`packages/cashweb/legacy-wallet/lotus-identity.ts` already refuses to trust `Address` / `toCashAddress()` for Lotus and says the CashAddr encoder cannot be configured into the Lotus prefix. That matches `lib/networks.js`: the only live prefix is `'bitcoincash'`.

## 2. `types.d.ts` vs the runtime

`packages/bitcore-lib-xpi/types.d.ts` (390 lines) is an ambient `declare module 'bitcore-lib-xpi'` adapted from DefinitelyTyped bitcore-lib 0.15. It is included by path, not published as `"types"`. It type-checks a subset of what callers happen to use. It is wrong in the following ways. Line numbers refer to `types.d.ts`.

Declared, not exported at runtime:

- `Message` (lines 322-336). No module.

Exported at runtime, absent from the declaration:

- `XAddress` (the Lotus string type).
- `crypto.Schnorr`.
- `encoding` (`Base58`, `Base58Check`, `BufferReader`, `BufferWriter`, `Varint`).
- `errors`.
- `util.preconditions`, `util.js`, `util.base32`, `util.convertBits`. `Util` only types `buffer.reverse`.
- `Transaction.sighash` / sighash helpers.
- `Script` interpreter and its flag constants.
- `Networks.regtest`, `Networks.defaultNetwork`, `enableRegtest`, `disableRegtest`.
- `deps`.

Wrong shapes:

- `Networks.get` is declared to return `Network`. The implementation returns `undefined` when the argument misses (`lib/networks.js`).
- `Network` only has `name`, `alias`, `prefix`. Runtime objects also have `networkbyte`, `pubkeyhash`, `privatekey`, `scripthash`, `xpubkey`, `xprivkey`, `networkMagic` (a `Buffer`), `port`, `dnsSeeds`, and `prefixArray`.
- `crypto.BN` declares `fromBuffer`, `add`, `mod`. Runtime adds script-number encoding (`toScriptNumBuffer`, `toSM`), endian options on `toBuffer`, and the rest of bn.js.
- `crypto.Point` declares `pointToCompressed`, `getN`, `mul`, `add`. Runtime also has `fromX`, `getG`, `getX`, `getY`, `validate`, `hasSquare`, `isSquare`, and a constructor that returns an elliptic point rather than a `Point` instance (`Point.prototype` is patched onto elliptic's prototype).
- `crypto.Signature` declares `fromDER`, `fromString`, an instance field `SIGHASH_ALL`, `toCompact`. Runtime sighash flags are on the constructor (`SIGHASH_ALL`, `SIGHASH_FORKID`, ...). Also present: `fromCompact`, `fromTxFormat`, `toDER` (aliased to `toBuffer` and taking a signing method), `hasLowS`, `toTxFormat`.
- `crypto.ECDSA.sign` is declared `(message, key) => Signature`. Runtime is `(hashbuf, privkey, endian?)` and the third argument changes the digest endianness inside RFC 6979. `verify` matches more closely.
- `crypto.Hash` omits `hmac`. `sha256hmac(data, key)` is `(data, key)`, which is easy to swap.
- `PrivateKey.fromBuffer(data, network: string)` does not match the 32-byte path, which ignores compression and falls through to `Networks.defaultNetwork` (`lib/privatekey.js` `_transformBNBuffer`, `compressed: false`). The constructor is `(key?: string | BN, network?)`. Runtime also accepts buffers, WIF strings, objects, and `undefined` (random key).
- `PrivateKey.toAddress(networkName?: string)` and `PublicKey.toAddress(network: string)` hide the default-network fallback.
- `HDPrivateKey.fromSeed(o: unknown)` is `(hexa, network?)` and defaults the network.
- `Transaction.sign` is `(privateKey: PrivateKey | PrivateKey[] | string) => this`. Runtime is `(privateKey, sigtype?, signingMethod?)` with `signingMethod` defaulting to `"ecdsa"`.
- `Transaction.verify()` is declared `string | boolean`. Runtime returns `true` or a string. It does not return `false`.
- `Transaction.serialize()` is declared `string`. Callers also use `toBuffer()`.
- `Script.toAddress(network: string)` and several `build*` helpers under-type `opts` as `unknown` or `object`. `buildPublicKeyHashOut` accepts an address-like value and will construct an `Address`, which applies the default network.
- `Address` declares `toCashAddress`, `toXAddress`, `toBuffer`. It omits `toLegacyAddress`, `toString`, `isValid`, and the static constructors. `toString` is assigned from `toXAddress` (`lib/address.js` line 738), while the comment above it says the string form defaults to CashAddr.
- `Unit` has no XEC (2 decimal places, 100 satoshis per displayed unit) or XPI (6 decimal places) factors. The factors are BTC's 1e8.
- `Block` is a loose `{ hash, height, transactions, header: { time, prevHash } }`. The runtime header has version, prevHash, merkleRoot, time, bits, nonce.

`PublicKey.fromBuffer` is declared `(Buffer | Uint8Array)`. `PrivateKey` fields use `Buffer`. Call sites mix `Buffer`, `Uint8Array`, and hex strings because constructors classify with `instanceof`.

This file is not a spec for `@frank/nakamoto`. The new public API is branded types and smart constructors. A compile-time test must show that the mismatches above cannot be expressed.

## 3. Holes to fix up front

Each of these is reproduced by reading `lib/`. The new library does not keep them for compatibility.

### Silent default network

`Networks.defaultNetwork` is the livenet object (`lib/networks.js` line 259). Fallbacks of the form `Networks.get(x) || Networks.defaultNetwork`:

- `lib/address.js` (constructor classification, object form, multisig, several network arguments around lines 81, 155, 270, 447).
- `lib/xaddress.js` lines 44 and 97.
- `lib/privatekey.js` lines 89 and 182 (32-byte keys).
- `lib/hdprivatekey.js` `fromSeed` line 423.
- `lib/publickey.js` line 58.
- `lib/script/script.js` line 1071 (`toAddress`).

A missing or unrecognized network becomes Lotus/BCH-shaped mainnet. The new API takes a chain descriptor argument, or the value already carries one. Parsing a string may detect the chain from its prefix. A caller-supplied chain that disagrees is an error.

### Mutable global network registry

`lib/networks.js` keeps `networks[]` and `networkMaps{}` at module scope. `add` / `remove` mutate them. `get` without a key looks up `networkMaps[arg]`, so a pubkey-hash version byte, a WIF prefix, a port, or a prefix string can resolve to whichever network was registered last that indexed that value. `indexNetworkBy` skips object values but will alias distinct networks that share a numeric prefix (`pubkeyhash: 0` is both BTC and the current livenet entry). `enableRegtest` writes `testnet.regtestEnabled = true` onto the shared object.

There is one livenet. Its parameters are Lotus P2P values (see section 5) with `prefix: 'bitcoincash'`. BTC, BCH, and XEC are not representable at the same time.

### Polymorphic constructors

`Address`, `XAddress`, `PrivateKey`, `PublicKey`, `HDPrivateKey`, `HDPublicKey`, `Script`, `Transaction`, `Block`, `BlockHeader`, `MerkleBlock`, input classes, and `Signature` all accept some mix of string, `Buffer`, `Uint8Array`, object, and their own instance, then branch on `typeof` and `instanceof`. `Transaction.prototype.sign` wraps the argument in `new PrivateKey(privKey)`, so a string is parsed as WIF or hex by guessing.

New constructors are `fromBytes`, `fromHex`, `fromWif`, `fromString`, one input type each.

### `instanceof` singleton guard

The global `_bitcoreLotus` check is the "more than one instance" guard. `instanceof` against `PublicKey`, `Address`, `Script`, `Input`, and `Output` is also used as a behavior switch (`Transaction.prototype.from`, sighash blanking inputs, script classification). Two copies of the package make those checks fail closed or throw. The guard's error text still says `bitcore-lib-cash`.

### Comparisons

- `lib/util/buffer.js` `equals` returns on the first differing byte. It is used to decide whether a key signs a P2PKH input (`publickeyhash.js`). That compares public hashes, not secret key material, and it still leaks the matching prefix.
- `transaction.js` sorts with `Buffer.compare` (or `buffer-compare`). That is lexicographic ordering for BIP69, not a MAC compare. `buffer-compare` is not constant-time.
- `lib/crypto/hash.js` HMAC is a hand-rolled loop. The short-key branch is `else if (key < blocksize)`. A `Buffer` compared with `<` to a number is false (`Number(buffer)` is `NaN`). The branch never runs. For a key shorter than the block size, later `key[i]` reads are `undefined`, and `ipad ^ undefined` becomes `ipad ^ 0` because bitwise operators convert `undefined` to 0. Checked against Node `createHmac('sha256')` for 32-byte, 64-byte, and 80-byte keys: the digests matched. The match depends on that JavaScript coercion. It is not a property to keep. The loop is also not constant-time.
- No `_.isEqual` over secrets was found under `lib/`. Lodash is used for `clone`, `each`, `sortBy`, `isArray`, `pick`, `extend`.

### Validation

- `PrivateKey` 32-byte path does not reject 0 or scalars `>= n` at the constructor boundary in the code path read; range checks live later, inside signing.
- `Point` validates on construction (not infinity, both coordinates match `pointFromX`, `n*P` is infinity). `Point.prototype.validate` multiplies by `n` on every call, including construction.
- `PublicKey` accepts compressed and uncompressed through one type.
- Schnorr verification in `lib/crypto/schnorr.js` is a custom scheme (see section 6 of the signing notes). It is not BIP340.
- High-S policy exists (`Signature.prototype.hasLowS`) but is a method callers must remember to apply.
- `XAddress.getType` returns `'pubkeyhash'` for every type byte, including the `default` branch (`lib/xaddress.js` lines 145-151). `PayToScriptHash` is a named constant the decoder never produces.
- `XAddress.decode` accepts either the current checksum or `createChecksumLegacy`. Two checksum definitions verify the same string shape.
- `Address.toXAddress` passes `Script.fromAddress(this).toBuffer()` into `XAddress`, so the payload is a locking script, not a 20-byte hash (`lib/address.js` lines 727-730).
- Script numbers and signature encoding throw `new Error('...')` strings in many places (`lib/crypto/bn.js`, `lib/script/script.js`, `lib/encoding/base58check.js`). `errors/spec.js` exists for some transaction errors and is not the only error path.

### Encoding mix and shared state

- Public functions return Node `Buffer`. `util.buffer.isBuffer` treats `Buffer` and `Uint8Array` as the same, so a `Uint8Array` from a browser caller passes the check and later hits Buffer methods.
- `Hash.hmac` allocates and does not wipe key pads.
- `Random.getPseudoRandomBuffer` (`lib/crypto/random.js` lines 38-55) fills bytes with `Math.random`. Nothing else in `lib/` calls it. It is still a public export (`crypto.Random`). `getRandomBuffer` itself uses `crypto.randomBytes` on Node and `getRandomValues` in the browser. `process.browser` is the switch.
- `ECDSA.prototype.randomK` draws from `Random.getRandomBuffer` but signing uses `deterministicK` (RFC 6979). `randomK` remains public.
- `ECDSA.prototype.calci` logs recovery failures with `console.error`.
- `Interpreter` and `Networks` keep flag constants and the registry on the exported function object. `Transaction.DUST_AMOUNT = 546` and `Transaction.FEE_PER_KB = 100000` are mutable properties of the constructor.
- Sighash defaults to `SIGHASH_ALL | SIGHASH_FORKID` and `SCRIPT_ENABLE_SIGHASH_FORKID` (`lib/transaction/sighash.js` lines 22-23, and each input's `getSignatures`). A caller who passes a bare `SIGHASH_ALL` on a chain that is not Bitcoin still gets forkid behavior only when the flag bit is set; the default adds the bit. There is no chain argument.

### Deprecated or unsafe crypto

- `elliptic` 6.5.x is the sole secp256k1 implementation. It is pure JavaScript, not constant-time, and it is the library named in the known elliptic advisory history. The replacement must not use it on a secret path.
- `bn.js` 4.11.8 is exact-pinned because a second copy trips the guard and because red-mod internals are version-sensitive (`Point.prototype.isSquare` builds a red BN).
- AES-CBC lives in Frank, not in this package (section 7). The package still exposes raw `point.mul(privateScalar)` which is how that CBC key is derived.
- Hashing is Node `createHash`, including RIPEMD-160. Browsers and some WASM-only embeds do not offer RIPEMD-160. Capacitor's webview is in that set.

## 4. Signing behavior

`Transaction.prototype.sign` (`lib/transaction/transaction.js` lines 1199-1213):

1. Requires `hasAllUtxoInfo()`. Throws if any input lacks the previous output.
2. Defaults `signingMethod` to `"ecdsa"`.
3. If `privateKey` is an array, recursively calls `sign` on each element and returns.
4. Otherwise calls `getSignatures` and `applySignature` for each returned signature. An empty list applies nothing and returns `this`.

`getSignatures` (lines 1216-1230) wraps the key in `new PrivateKey(privKey)`, defaults `sigtype` to `SIGHASH_ALL | SIGHASH_FORKID`, computes `hash160(pubkey)` once, and calls `input.getSignatures` for every input. There is no input index argument and no map from key to input.

Input classes, chosen in `Transaction.prototype._fromNonP2SH` / `_fromMultisigUtxo` (lines 683-724):

| Class | When | `getSignatures` |
| --- | --- | --- |
| `PublicKeyHashInput` | Previous output script is P2PKH | Signs only if `hash160(pubkey)` equals `script.getPublicKeyHash()`. Otherwise returns `[]` (`publickeyhash.js` lines 40-50) |
| `PublicKeyInput` | Previous output script is P2PK | Signs only if `pubkey.toString()` equals `script.getPublicKey().toString('hex')`. Otherwise returns `[]` (`publickey.js` lines 36-46) |
| `MultiSigInput` | Previous output is bare multisig, and the caller passed `pubkeys` and `threshold` to `from` | Signs if `pubkey.toString()` equals one of the stored public keys. Otherwise returns `[]`. Compares full public-key strings, not hash160 |
| `MultiSigScriptHashInput` | Previous output is P2SH, and the caller passed keys and threshold | Same public-key string match. Checks that the built redeem script hashes to the P2SH output at construction time |
| `Input` (base) | Anything else, including P2SH without a redeem script | `getSignatures` throws `AbstractMethodInvoked` (`input.js` lines 163-167) |

Consequences, confirmed by the control flow:

- A key that matches no input adds no signature and raises no error.
- An array of keys can match a subset of inputs. The returned transaction is partially signed, and `sign` still returns `this`.
- `isFullySigned()` can be called afterwards, but `sign` does not call it.
- The caller cannot say "key K signs input i". Passing the right key for the wrong output is a silent no-op.
- UTXO script and satoshis must already be attached (`hasAllUtxoInfo`, and `getSignatures` reads `this.output`).
- Default sighash is forkid, on every input type above, including when the caller wanted legacy Bitcoin sighash.
- `signingMethod` `"schnorr"` selects `Schnorr.sign` inside `sighash.js`. `"ecdsa"` selects `ECDSA.sign`. Any other value falls off the end and returns `undefined`, and the caller then throws while reading the signature.

`addSignature` on the P2PKH and P2PK classes does reject an invalid signature. The silent path is the one that never produces a signature.

The replacement primitive is `signInput(tx, inputIndex, signer, { sighashType })`. `signAll` takes explicit assignments. A signer is `{ publicKey, sign(digest) }`. A mismatch with the previous-output script is an error. Partial signing is requested and reported.

## 5. Chain differences

Sources read for this table:

- SLIP-0044 registered coin types, `https://github.com/satoshilabs/slips/blob/master/slip-0044.md` (fetched 2026-09-29): BTC `0`, testnet `1`, BCH `145`, XEC `899`, "eCash token" `1899`, XPI Lotus `10605`.
- Bitcoin Cash address and script: cashaddr as implemented in Bitcoin ABC `src/cashaddr.cpp` (same polymod the old `address.js` uses) and the opcode list at `https://documentation.cash/protocol/blockchain/script.html` (introspection opcodes from `0xc0`).
- eCash address spec: `https://github.com/Bitcoin-ABC/bitcoin-abc/blob/master/doc/standards/cashaddr.md` (prefixes `ecash`, `ectest`, `ecregtest`). Token prefix `etoken` is the eCash token cashaddr prefix used beside that spec; the descriptor ticket must pin the version byte against Bitcoin ABC `cashaddrenc.cpp` rather than assume it.
- Lotus node `https://github.com/LotusiaStewardship/lotusd/blob/master/src/chainparams.cpp` (fetched 2026-09-29) and its `src/cashaddr.cpp`.
- Old package: `lib/networks.js`, `lib/xaddress.js`, `lib/transaction/sighash.js`, `lib/opcode.js`, `lib/script/interpreter.js`, `lib/unit.js`, `lib/transaction/transaction.js`.
- BIP143 (segwit v0 sighash), BIP340 (Schnorr), BIP341 (taproot), BIP173 (bech32), BIP350 (bech32m). The sighash ticket cites the BIP text and each node's tests; this table only names the algorithm.

| Topic | BTC | BCH | XEC | XPI (Lotus) |
| --- | --- | --- | --- | --- |
| Address encodings | Base58Check P2PKH/P2SH, bech32 (BIP173) witness v0, bech32m (BIP350) witness v1 | CashAddr prefix `bitcoincash` / `bchtest` / `bchreg`, plus legacy base58. Token-aware cashaddr is a BCH encoding (CashTokens), not a BTC one | CashAddr prefixes `ecash` / `ectest` / `ecregtest` per the ABC spec. `etoken` is the token prefix. Legacy base58 still decodes the same hash | Two stories, and they disagree. See below |
| P2P magic and port in the old livenet entry | Not this object | Not this object | Not this object | `networkMagic` `0xece7eff3`, port `10605`. Matches lotusd mainnet `netMagic` bytes `ec e7 ef f3` and `nDefaultPort = 10605` (`chainparams.cpp`) |
| CashAddr prefix in the old livenet entry | | | | `prefix: 'bitcoincash'`. lotusd `cashaddrPrefix` is `"ecash"` if `-ecash` / `-useecashprefix`, otherwise `"bitcoincash"`. Neither is the string `lotus` |
| XAddress | No | No | No | `lib/xaddress.js`: `prefix + networkChar + base58(typeByte \|\| payload \|\| 4-byte checksum)`. Default prefix `lotus`. Network character `_` / `T` / `R`. Checksum is `SHA256(prefix \|\| networkByte \|\| typeByte \|\| payload)` first 4 bytes, and a legacy varint-length checksum is also accepted. Decoder forces type pubkeyhash. This is not cashaddr |
| WIF / legacy version bytes | P2PKH `0x00`, P2SH `0x05`, WIF `0x80` mainnet; testnet P2PKH `0x6f`, WIF `0xef` | Same version bytes as BTC for legacy P2PKH/P2SH/WIF on mainnet. HD versions `0x0488b21e` / `0x0488ade4` (xpub/xprv) | Same legacy version bytes. HD versions in the old package match BIP32, not a distinct XEC pair | lotusd `base58Prefixes`: pubkey `0`, script `5`, secret `128`, ext pub `0488B21E`, ext secret `0488ADE4` (mainnet). Testnet pubkey `111`, script `196`, secret `239`, ext `043587CF` / `04358394`. The old `networks.js` matches these numbers and mislabels the cashaddr prefix |
| Transaction serialization | Version, inputs, outputs, locktime. Segwit marker and flag when witnesses are present | Bitcoin serialization without segwit. Forkid sighash is not a serialization change | Same as BCH for the pre-token transaction format. Token prefix on outputs is a consensus difference the script ticket has to take from ABC, not from this package | lotusd `CreateGenesisBlock` sets `nReserved`, `nHeaderVersion`, `hashExtendedMetadata`, `nHeight`, and `SetSize` on the block. Transaction format must be taken from lotusd's serializer in the serialization ticket. The old package serializes a Bitcoin-shaped transaction |
| Sighash | Legacy (including the SIGHASH_SINGLE bug the old code preserves) and BIP143 for witness v0. BIP341 tagged hashes for taproot | BIP143-shaped digest with `SIGHASH_FORKID`, fork id 0, amount committed. Spec is the UAHF / replay-protection writeup; the old `sighashForForkId` hardcodes `GetForkId() { return 0 }` | Same FORKID construction as the BCH chain it split from, unless an ABC upgrade changed the digest. The sighash ticket must diff ABC's `SignatureHash` against BCHN rather than assume they stayed identical | Old code uses the same forkid-0 digest. Lotus SDK commentary (not the node file fetched here) names `SIGHASH_LOTUS` as distinct from `SIGHASH_FORKID`. Treated as unverified until the sighash ticket quotes lotusd |
| Script | Bitcoin script. No `OP_CHECKDATASIG`, no `OP_CAT` / `OP_SPLIT` as consensus on mainnet. Tapscript is a separate version | `OP_CAT`, `OP_SPLIT`, `OP_CHECKDATASIG` / `VERIFY`, `OP_REVERSEBYTES`, native introspection from `0xc0` (`OP_INPUTINDEX`, `OP_ACTIVEBYTECODE`, ... per documentation.cash). May 2025 VM limits replace the 201-opcode and 520-byte rules on BCH | ABC script upgrades diverge from BCH after the 2020 split. CashTokens are not an XEC consensus feature. The script ticket cites ABC's opcode table per upgrade, not the BCH one | Old interpreter flags stop at `SCRIPT_ENABLE_SCHNORR_MULTISIG` and `OP_REVERSEBYTES`. lotusd's later upgrades (named exodus through secondKings in `chainparams.cpp`) are not represented |
| Signatures | ECDSA low-S. BIP340 Schnorr for taproot only | ECDSA and the BCH Schnorr encoding (64-byte, sighash byte optional). Not BIP340 | Same family as BCH Schnorr unless ABC says otherwise. Confirm in the primitives ticket | Old `Schnorr.sign(hashbuf, key, endian)` is digest Schnorr, not BIP340 tagged hashes |
| Dust and relay fee | Policy, not consensus. Bitcoin Core's dust threshold is a function of minimum relay fee | Policy. Old library constant is not BCH's | Policy. Display unit changed (below); dust in satoshis did not move just because the decimal point did | Policy. Old constants are not per chain |
| Old library dust / fee | `Transaction.DUST_AMOUNT = 546`, `Transaction.FEE_PER_KB = 100000` (100 sat/byte) for every use | same constants | same constants | same constants |
| Block header | 80 bytes: version, prev, merkle, time, bits, nonce | 80 bytes | 80 bytes | lotusd genesis construction includes `nReserved`, `nHeaderVersion`, `hashExtendedMetadata`, `nHeight`, and a block size field. Not the 80-byte header `lib/block/blockheader.js` implements |
| HD coin type | SLIP-44 `0`. Testnet `1` | SLIP-44 `145` | SLIP-44 `899` for XEC and `1899` for "eCash token". Wallets that forked BCH still derive account `145`. Both values are real. Default in the new descriptor is the registered `899`, and the coin type argument is explicit so a caller can pass `145` | SLIP-44 `10605`. Lotus SDK examples use `m/44'/10605'/0'/0/0`. The old HD code does not know a coin type; it only HMAC-SHA512s with `"Bitcoin seed"` |
| Display unit | 1 BTC = 1e8 satoshis | 1 BCH = 1e8 satoshis | 1 XEC = 100 satoshis (the 2021 rebase). Old `Unit` does not know this | Lotus SDK and xpi-p2p-ts document 1 XPI = 1e6 satoshis. Old `Unit` uses 1e8 |
| Message magic | Bitcoin Core: `Bitcoin Signed Message:\n` | Must be quoted from BCHN in the primitives ticket. Often still the Bitcoin string; do not assume | Trezor `coininfo.py` entry for Ecash: `eCash Signed Message:\n` (seen in the coininfo listing fetched for this audit) | Not in the files read. The primitives ticket quotes lotusd before picking a string |

### Lotus address, stated carefully

Three formats show up, and only one is implemented in the old library:

1. CashAddr with prefix `bitcoincash` or `ecash`, from lotusd `chainparams.cpp` `cashaddrPrefix` and a standard `cashaddr.cpp` (BCH polymod, charset `qpzry9x8gf2tvdw0s3jn54khce6mua7l`).
2. The old package's `XAddress`: base58 payload, prefix `lotus`, network character `_`/`T`/`R`, SHA-256 checksum (not double-SHA256 and not cashaddr's polymod), type byte forced to pubkeyhash on decode. Fixture: `test/data/xaddr.json` contains one vector, `lotus_16PSJLjLt4f5tQW5t3E1FKrH6WK4uzQLVvnSsdkqd`.
3. A Lotus SDK document (`lotus-sdk` `docs/TAPROOT_COMPLETE.md`) describes an XAddress with type byte 2 and a base32 payload for taproot. That is not what `lib/xaddress.js` does.

`bcProFoundation/xaddress` describes yet another decode (`payload` as a full script). The address ticket must generate and check vectors against lotusd's current encoder, and record which of these the node actually produces. Until that diff exists, `@frank/nakamoto` must not treat `lib/xaddress.js` as the spec. The behavior of the old function is still a test fixture for "what the old code did", clearly labeled as such.

### Sighash algorithms the new `sighash()` must name

- Legacy Bitcoin, including SIGHASH_SINGLE's out-of-range hash `0x01` (the old code returns that constant).
- BIP143, for BTC witness v0.
- BIP341, for BTC taproot key-path and script-path (the sighash is different; the ticket splits them).
- BCH/XEC FORKID: the old `sighashForForkId` commits version, hashPrevouts, hashSequence, outpoint, scriptCode, 8-byte value, sequence, hashOutputs, locktime, and the 32-bit sighash type. Fork id is 0 unless replay protection rewrites the high bytes (`SCRIPT_ENABLE_REPLAY_PROTECTION` xors the fork value with `0xdead` and forces `0xff0000`).
- Lotus: unimplemented as a distinct algorithm in this package. Do not ship forkid-0 and call it Lotus until lotusd's `SignatureHash` is quoted in the test.

`sighash(tx, inputIndex, chain, type)` is a pure function. Tests use official vectors and do not need a key.

## 6. Crypto backends

Constraints: hot paths stay synchronous (WebCrypto `subtle` is async and is not a drop-in). The same API runs in Node, the browser, and the Capacitor webview. Each backend sits behind a small internal interface. A faster backend is adopted only where a measurement says so.

### Recommendation

Use three backends behind one internal interface, selected by environment, with noble as the pure-JS fallback everywhere:

| Operation | Node | Browser and Capacitor | Fallback |
| --- | --- | --- | --- |
| SHA-256, SHA-256d, RIPEMD-160, HASH160 | `node:crypto` `createHash` | `hash-wasm` synchronous hasher (`createSHA256` / `createRIPEMD160` after init) | `@noble/hashes` |
| HMAC-SHA256 | `hash-wasm` or `@noble/hashes`. Node `createHmac` was slower in this run | `hash-wasm` | `@noble/hashes` |
| secp256k1 sign, verify, Schnorr, ECDH (`pointMultiply`) | `tiny-secp256k1` (libsecp256k1 compiled to WASM; the package API is synchronous after its context init) | same | `@noble/curves` `secp256k1` |
| Projective point add that does not need compressed bytes | `@noble/curves` `ProjectivePoint` | same | same |
| Base58, bech32, bech32m | `@scure/base` | same | same |
| BIP32 / BIP39 | `@scure/bip32`, `@scure/bip39` | same | same |

`@noble/ciphers` is the AES-GCM and ChaCha candidate for `@frank/crypto-box`, not for the chain library. It was installed for the survey and not micro-benchmarked; the suite ticket has to check its AES-GCM against the known-answer tests and against a second backend.

Do not use `elliptic` or `bn.js` in the new code. Do not use `node-forge`.

`@scure/btc-signer` is a good source of BTC sighash and taproot test vectors and a readable reference for BIP143/BIP341. Its public API is raw byte arrays, and it does not implement BCH FORKID, eCash, or Lotus. It is not the transaction layer.

`@bitauth/libauth` already targets BCH (and a good part of eCash) in TypeScript: cashaddr, script, transaction, secp256k1. Its functions pass `Uint8Array` at every boundary. That is the style this project is refusing. Reusing it as a dependency would either leak that style or wrap every call in branded constructors, and it still would not cover BTC taproot policy or Lotus headers and XAddress. The honest call is:

- Do not take libauth as a runtime dependency of `@frank/nakamoto`.
- Do copy or fetch its published test vectors, and Bitcoin Core / BCHN / Bitcoin ABC / lotusd vectors, and cite the file in the test.
- Keep the implementation under our branded types.

A later ticket can revisit wrapping libauth's script VM if the script ticket's own interpreter falls behind BCH upgrades. That is not the default.

`@bitcoinerlab/secp256k1` is a noble-curves build with a tiny-secp256k1-shaped API, not a libsecp256k1 WASM build. It was not timed separately. `tiny-secp256k1` is the WASM build that was timed.

HD and mnemonic libraries were not micro-benchmarked. They are not on the block-validation hot path. Correctness and audit matter more than their speed. `@scure/bip32` and `@scure/bip39` are the choice because they are typed, maintained, and already sit next to noble.

### Benchmarks

Machine: Node `v26.8.2`, `arm64`, `darwin`. Throwaway project `/tmp/nakamoto-bench` (not in the repo). Versions: `@noble/hashes@1.8.0`, `@noble/curves@1.9.1`, `@noble/ciphers@1.3.0` (installed, not timed), `@scure/base@1.2.5`, `@scure/btc-signer@1.6.0` (installed, not timed), `hash-wasm@4.12.0`, `tiny-secp256k1@2.2.3`, `elliptic@6.6.1` (newer than the old package's `^6.5.3`; the old code path is the same library).

Method: warmup, then a tight loop, `performance.now()`. Hash loops were 20,000 iterations except where noted. Sign/verify/ECDH loops were 300 to 400. Merkle was 200 runs of a 2,048-txid tree. Sanity check: `@noble/hashes` SHA-256d and RIPEMD-160 matched `node:crypto` on the sampled inputs.

Rates are operations per second. Higher is faster. These are single-core, single-process numbers on this laptop, not a CI baseline. The performance ticket should re-run the same shapes and keep the script. That script is `packages/nakamoto/scripts/hot-path-bench.mjs`. Run it with `yarn workspace @frank/nakamoto bench`. CI does not run it, and its output does not replace this table.

| Operation | node:crypto | @noble/hashes | hash-wasm (sync hasher) |
| --- | ---: | ---: | ---: |
| SHA-256d of an 80-byte header | 941,000 | 556,000 | 1,829,000 |
| RIPEMD-160 of 32 bytes | 1,928,000 | 1,079,000 | 2,578,000 |
| HASH160 of 33 bytes | 1,048,000 | 757,000 | not timed as a pair |
| HMAC-SHA256 | 155,000 (`createHmac`) | 440,000 | 808,000 |

| Operation | @noble/curves | elliptic (prebuilt key) | tiny-secp256k1 |
| --- | ---: | ---: | ---: |
| ECDSA sign | 4,200 to 5,700 | 1,900 to 2,600 | 6,800 |
| ECDSA verify | 820 to 970 | 1,000 to 1,120 | 5,200 |
| ECDH | 480 to 620 (`getSharedSecret`) | 1,370 to 1,540 (`derive` on a prebuilt public key) | 6,300 (`pointMultiply`) |
| Schnorr sign / verify | not isolated | not isolated | 3,800 / 5,000 |
| Point add | 360,000 to 486,000 (projective, no re-encode) | 29,000 to 31,000 (prebuilt points) | 27,000 (`pointAdd`, compressed bytes in and out) |

The two noble ranges are two runs of the same script. The second run was slower. The ordering did not change.

| Operation | Implementation | Rate |
| --- | --- | ---: |
| Base58-encode 21 bytes | `@scure/base` | 351,000 |
| CashAddr-style polymod encode | local implementation of the ABC polymod, not a library | 201,000 |
| Merkle root of 2,048 txids | `node:crypto` SHA-256d | 417 |
| Merkle root of 2,048 txids | `@noble/hashes` SHA-256d | 260 |

Reading:

- Hash-wasm wins SHA-256d and RIPEMD-160, including against Node's native hash, on this machine. Merkle of a full-looking transaction list is still hundreds per second in Node, so the absolute gap matters for batch verification more than for a single wallet signature.
- Node `createHmac` was the slow HMAC. Do not pick it only because it is "native".
- `tiny-secp256k1` is the secp256k1 win on sign, verify, Schnorr, and ECDH. Noble's advantage is the projective point API and a pure-JS fallback when WASM will not load. Elliptic loses sign and ECDH to both, and its verify rate is close to noble and far behind tiny-secp256k1.
- Noble point-add looks much faster because it does not serialize. A backend that has to return compressed bytes should be timed the way `pointAdd` was timed, not the way `ProjectivePoint.add` was.
- CashAddr encoding is cheap next to a signature. It does not justify a WASM base converter.
- WebCrypto was not timed. It cannot be called synchronously.

The first backend interface should expose exactly the operations above (hash, hmac, ecdsa sign/verify, schnorr sign/verify, ecdh, point add, point multiply for public data). Tests run every backend on the same vectors, including the old elliptic/bn.js package as a dev-only oracle for ECDSA and HASH160, and refuse to pass if two backends disagree.

## 7. Frank encryption today

Read: `packages/cashweb/relay/monad-message-envelope.ts`, `packages/cashweb/relay/crypto.ts`. Not modified.

### Version 2 (current writer)

`buildEnvelope` in `monad-message-envelope.ts`:

- secp256k1 ECDH: `PayloadConstructor.constructMergedKey` does `PublicKey.fromPoint(publicKey.point.mul(privateKey.toBigNumber()))`, then `toBuffer()` (compressed point, 33 bytes).
- HKDF-SHA256 inlined as two HMACs. Comment says RFC 5869 extract + one expand block: `PRK = HMAC(salt, IKM)`, `OKM = HMAC(PRK, info || 0x01)`. The code calls `Hash.sha256hmac(ecdhPoint, salt)` and the bitcore argument order is `(data, key)`, so this is `HMAC(key=salt, data=ecdhPoint)`. RFC 5869 extract is `HMAC(salt, IKM)`. Those match only if `sha256hmac`'s key argument is the salt. It is. Expand info is the ASCII string `frank:monad-dm-envelope:v2:identity-ecdh:aes-256-gcm` plus a `0x01` byte. Output is 32 bytes, one block, so the missing length-extension of HKDF does not matter for this single block.
- The HMAC implementation's short-key bug is accidentally compatible with Node for a 32-byte salt (section 3). The salt is the HMAC key and is 32 bytes, under the 64-byte SHA-256 block. Do not treat that as a reason to keep the hand-rolled HMAC.
- AES-256-GCM via `node-forge`, random 96-bit nonce, 16-byte tag. Fresh 32-byte salt per message, so the derived key changes per message even if the ECDH point does not.
- Associated data is `JSON.stringify([2, networkTag, from, to])` UTF-8. That binds version, network tag, sender address, and recipient address. It does not bind a numeric suite id (there is no suite field on the envelope) or the raw public keys. It binds the claimed `from` / `to` address strings. Those are EVM addresses, not the secp256k1 keys, except insofar as the caller passes the matching key.
- The GCM key is not committed by AES-GCM. A different key can theoretically produce a colliding tag for crafted inputs. The suite ticket should say so and not claim key commitment.
- No padding. Ciphertext length equals plaintext length. Length is visible.
- No forward secrecy against the recipient static key. The sender uses the long-lived identity private key as the ECDH private key (`fromPrivateKey`), not an ephemeral. Compromise of either static key decrypts recorded traffic for which the attacker also has the other side's public key and the salt (the salt is on the envelope).
- Tag check is forge's GCM `finish()`. This audit did not inspect forge's compare for constant time. The new suite must use the backend's constant-time verify and not forge.
- Deniability: both parties can compute the same ECDH point and the same AEAD key. Either can produce a tag the other will accept. There is no signature over the ciphertext. The file's own header says this. A forgeability test (recipient private key + sender public key produces a ciphertext the recipient accepts as "from the sender") must pass for the new suite, and it would pass for v2 for the same reason.

What v2 does not bind, and the new suite must:

- Sender key bytes, recipient key bytes, and a suite id, as associated data, not only the address strings.
- A context string chosen by the caller.

### Version 1 (read path only)

`decryptLegacyEnvelopeV1` calls `PayloadConstructor.constructSharedKey` and `decrypt`. `crypto.ts` `encrypt` / the matching decrypt use AES-CBC. The key is split into a 16-byte IV (`sharedKey.slice(0, 16)`) and the remaining bytes as the AES key. The shared key is `HMAC-SHA256(key=compressed_ecdh_point, data=salt)` via `sha256hmac(Buffer.from(salt), rawMergedKey)`. There is no MAC on the ciphertext beyond CBC padding behavior. The IV is not random; it is half of the derived key, and it is stable for a given salt and key pair. `buildEnvelope` never emits v1. The new package has no AES-CBC read path.

### Key separation

v2's HKDF info string separates the DM envelope key from other uses of the same ECDH point. v1 has no info string. Stealth and stamp derivation in `crypto.ts` use a different construction (`SHA256(compressed_ecdh)` as a scalar tweak, then `add` the destination key). Those are not AEAD keys. They still hash the raw ECDH point with SHA-256 and no domain separation beyond what the caller puts in the digest. The primitives ticket exposes `tweakAddPublicKey` / `tweakAddPrivateKey` and leaves Frank's domain strings in Frank.

## 8. Non-repudiation and linkability

The envelope's AEAD is deniable. Other layers are not, and the funding graph ties them to the identity.

Lotus `SignedPayload` (`backend/cashweb/cashweb-payload/src/verify.rs`): the payload carries a pubkey and a signature. Verification checks a Schnorr or ECDSA signature over the payload hash and builds the burn commitment as `SHA256(SHA256(pubkey) || payload_hash)`. That signature is non-repudiable for the holder of `pubkey`. This audit did not change it.

Monad `MonadStampedMessage` (`backend/cashweb/cashweb-registry/src/http/monad_message.rs` module docs, lines 56-61): there is no separate author signature. "The raw transaction signatures authenticate only disposable funding accounts, not the claimed message author." Each payment's calldata commits to `SHA256("frank:dm-stamp-payment:v1" || SHA256(encrypted_payload) || uint32_be(child_index))` (client: `packages/wallet/monad-stamp-client.ts`). The EVM signature on that transaction is non-repudiable for the funding account.

Those funding accounts are not independent of the identity:

- Identity key: `m/44'/60'/1'/0/0` (`MONAD_IDENTITY_DERIVATION_PATH` in `packages/wallet/monad-identity.ts`), same BIP-39 seed.
- Stamp accounts: `m/44'/60'/0'/0/i` (`packages/wallet/monad-hd-keyring.ts`).
- Change accounts: `m/44'/60'/0'/1/i`.
- `MonadSubAccountPool` funds stamp accounts from `mainAccountSigner`. The code path calls that signer the identity account ("If the identity account cannot afford two separate funding fees"). The funding transaction is an on-chain transfer from the identity address to the stamp address.

Anyone who sees that transfer learns that the identity funded the account that signed the payload-hash commitment. Anyone who knows the seed can derive all three branches. The stamp signature does not verify under the identity key, and the relay does not treat it as an author signature. The link is the HD tree plus the funding transaction, not the AEAD tag.

Relay receipt checks in `monad_message.rs` confirm the transaction receipt status. They do not add a second signature by the identity over the plaintext. Mailbox storage of the Monad message does not, in the code read here, attach an identity signature. The Lotus path does, via `SignedPayload`.

No change to the on-chain scheme is in scope. The finding is its own ticket.

## 9. What the new packages must not copy

- Global network, default network, `global._bitcoreLotus`.
- `inherits`, lodash, `bn.js` 4.11.8, `elliptic`, `buffer-compare`, `bs58` 4, gulp/karma/bower.
- `Math.random` on any path that can produce key material.
- AES-CBC, forge, and a v1 read path.
- Silent partial signing.
- `types.d.ts` as a source of truth.
- One `PublicKey` type that means both compressed and uncompressed, one `Uint8Array` that means txid-display order and internal hash order, one `string` error type.
- Adaptor signatures, in the first version.
- A custom DLEQ. BIP-374 only, with its vectors. Frank's stamp domain strings stay in Frank.
- Suite id `65535` as a produced identifier. It is reserved for proof vectors.

## 10. Ticket map

Native `blocked-by` edges are on the issues. A sentence here is not that edge. Decision issues do not block implementation; the reversible default in each one is what the port follows until an owner overrides it.

| Issue | What it is | Waits on |
| --- | --- | --- |
| [Publish the Phase 0 nakamoto audit](https://github.com/schancel/frank/issues/235) | This document | nothing |
| [Scaffold @frank/nakamoto and @frank/crypto-box](https://github.com/schancel/frank/issues/236) | Empty strict packages | nothing |
| [Replace the hand-written bitcore types with branded constructors](https://github.com/schancel/frank/issues/237) | Compile-time misuse tests | scaffold |
| [Add a crypto backend interface and differential tests](https://github.com/schancel/frank/issues/238) | Node, WASM, and pure-JS backends | scaffold |
| [Port encoding, buffer, and error leaves](https://github.com/schancel/frank/issues/239) | base58, varint, reader/writer, typed errors; SHA-256d from `@noble/hashes` 1.8.0 | scaffold, runtime |
| [Add explicit chain descriptors](https://github.com/schancel/frank/issues/240) | BTC, BCH, XEC, XPI, no default chain | scaffold |
| [Runtime constraints and a justified dependency list](https://github.com/schancel/frank/issues/264) | bigint, Uint8Array, per-chain entries, empty install list | scaffold, chains |
| [Destination and per-chain address codecs](https://github.com/schancel/frank/issues/243) | Destination vs encoding | chains, leaves |
| [Keys, WIF, and HD derivation](https://github.com/schancel/frank/issues/244) | Keys and BIP32 | backend, chains |
| [Per-chain sighash and transaction serialization](https://github.com/schancel/frank/issues/246) | Pure sighash | chains, leaves |
| [Explicit transaction signing](https://github.com/schancel/frank/issues/245) | `signInput` / `signAll`, no silent miss | keys, sighash |
| [Per-chain script rules](https://github.com/schancel/frank/issues/247) | Opcode sets and limits | sighash |
| [Block and merkle serialization per chain](https://github.com/schancel/frank/issues/248) | 80-byte headers vs Lotus | chains, leaves |
| [Typed ECDSA, Schnorr, ECDH, and BIP-374](https://github.com/schancel/frank/issues/249) | Primitives, no adaptors | backend, chains |
| [Versioned deniable encryption suites](https://github.com/schancel/frank/issues/254) | `@frank/crypto-box` | scaffold, primitives |
| [Re-run hot-path benchmarks before flipping a backend](https://github.com/schancel/frank/issues/255) | Do not switch backends on a guess | backend |
| [Migrate app and package consumers off bitcore-lib-xpi](https://github.com/schancel/frank/issues/257) | Future. Not this port | signing, addresses, keys, script, primitives |
| [Migrate relay encryption onto @frank/crypto-box](https://github.com/schancel/frank/issues/258) | Future. Not this port | suites |
| [Delete packages/bitcore-lib-xpi after consumers have moved](https://github.com/schancel/frank/issues/259) | Last. Do not perform it with the port | migrations, plus the audit, types, blocks, and benchmark tickets |
| [Handoff for the chain library and encryption suites](https://github.com/schancel/frank/issues/260) | Living status. Risk stays at the top | nothing |

Decisions, not blockers:

- [Which eCash HD coin type is the default](https://github.com/schancel/frank/issues/241). Default in use: coin type is a required argument.
- [Which Lotus address format is consensus](https://github.com/schancel/frank/issues/242). Default in use: do not emit XPI address strings until lotusd is quoted.
- [Adaptor signatures are not in the first version](https://github.com/schancel/frank/issues/250).
- [Private-use KEM id for secp256k1 HPKE](https://github.com/schancel/frank/issues/251). Default in use: RFC 9180 private-use range; the suite PR names the concrete id.
- [Forward secrecy for message encryption](https://github.com/schancel/frank/issues/252). Default in use: none against the recipient static key.
- [Keep encryption in @frank/crypto-box](https://github.com/schancel/frank/issues/253).

Finding, no code change: [Stamp funding accounts are linkable to the identity](https://github.com/schancel/frank/issues/256).

The handoff issue tracks Done, Open PRs, Decisions, Blocked, and New tickets. Risky items stay at the top of that issue.

## 11. Dependency budget

`packages/nakamoto/runtime-deps.json` and `packages/crypto-box/runtime-deps.json` are the lists the dependency check compares to `package.json`. Yarn 1 does not record a workspace package's own dependency map as a lockfile key, so those files are the install lists. `dependencies` must equal `allowed`. `optionalDependencies` must equal `optional`. A name in `planned` or `plannedOptional` must not be installed yet. Direct `bn.js`, `elliptic`, `bs58`, `buffer-compare`, `inherits`, `lodash`, `node-forge`, and `buffer` fail the check even if they are copied into `allowed`.

`@frank/crypto-box` `allowed` is empty. `@frank/nakamoto` `allowed` (installed) is `@noble/hashes` at `1.8.0`, installed for the base58check SHA-256d checksum. `@noble/curves` is an allowed exact version: `1.9.1`. It is not installed in this change, so it stays in `planned` until issue 249 installs that version and moves the row into the installed `allowed` list in the same commit. No other curves version is allowed. `@noble/ciphers` is an allowed exact version: `1.3.0`. It is not installed in this change, so it stays in `planned` until issue 254 installs that version and moves the row into the installed `allowed` list in the same commit. No other ciphers version is allowed. The other planned packages below are not installed and are not allowed. Moving another name into `allowed` or `optional` means editing this section in the same change, for the version that is actually installed. The recommendation in section 6 is the intended set. It is not permission to install early, except the `1.9.1` pin ([decision](https://github.com/schancel/frank/issues/339)) and this `1.3.0` pin ([decision](https://github.com/schancel/frank/issues/353)).

Integer math in the new packages is native `bigint`. Script-number encode and decode, and fixed-width unsigned big-endian conversion, live in `@frank/nakamoto` (`src/script-num.ts`, `src/integer.ts`). They are checked against the little-endian script-number vectors and against `bitcore-lib-xpi` from a test only. Encoding leaves import `src/integer.ts`. They do not carry a second script-number codec.

Shared source uses `Uint8Array`. It does not import Node built-ins. A Node accelerator, when one exists, lives under `src/backend/node/` and is not imported by shared code. That directory does not exist yet. `sideEffects` is false. The exports map is ESM, with types. CJS is not emitted. Chain entries are `btc`, `bch`, `xec`, and `xpi`. Feature entries are `integer`, `script-num`, `base58`, `base58check`, `varint`, `reader`, `convert-bits`, `base32`, and `encoding-error`. Bundling the BCH entry does not include the BTC mainnet magic or the XPI port. Checks across a package boundary use a `code` field.

`@frank/nakamoto` allowed:

| Package | Role | What was checked |
| --- | --- | --- |
| `@noble/hashes` | SHA-256d for the base58check checksum | MIT. Installed `1.8.0`, exact, not a range. README, read 2026-09-29: Cure53, January 2022, version 1.0.0, scope everything except blake3, sha3-addons, sha1, and argon2. SHA-256 is inside that scope. Changes after 1.0.0, including 1.8.0, are not in that report. The import is `@noble/hashes/sha256.js`. RIPEMD-160 and HMAC stay unused until the hash-backend ticket. |

`@frank/nakamoto` planned:

| Package | Role | What was checked |
| --- | --- | --- |
| `@noble/curves` | secp256k1 for issue 249 (ECDSA, BIP340 Schnorr, ECDH, point tweaks) and projective addition | MIT. Allowed exact version `1.9.1`, not a range, not installed in this change. npm, viewed 2026-09-30: `1.9.1` depends on `@noble/hashes` `1.8.0`. `2.3.0` depends on `@noble/hashes` `2.3.0`, which this section does not allow. README on main, read 2026-09-30: Trail of Bits, August 2026, version 2.3.0, scope everything; Cure53, September 2024, version 1.6.0, scope ed25519, ed448, BLS, bn254, and hash-to-curve, not secp256k1; Kudelski, September 2023, starknet-related abstract modules; Trail of Bits, February 2023, version 0.7.3, scope included secp256k1. The February 2023 report covers the 1.x line, not every later change. 1.9.1 is not 2.3.0. The August 2026 report does not cover 1.9.1. AI-assisted self-audits are not an audit. Issue 249 installs `1.9.1` only. |
| `@scure/base` | base58, bech32, bech32m | MIT. Survey install 1.2.5. Encoding leaves implement Bitcoin base58 and the cashaddr/bech32 charset in-tree, so this package is not installed. A later ticket that adds it cites an audit of that version. |
| `@scure/bip32` | HD derivation | MIT on npm 2.4.0, viewed 2026-09-29. Not in the benchmark tree and not microbenchmarked. The HD ticket cites an audit and re-checks the license of the version it adds. |
| `@scure/bip39` | mnemonics | MIT on npm 2.4.0, viewed 2026-09-29. Same rule as `@scure/bip32`. |

`@frank/nakamoto` planned optional accelerators. They stay optional, and the pure-JS package above still has to run:

| Package | Role | What was checked |
| --- | --- | --- |
| `hash-wasm` | synchronous hash and HMAC | MIT. Survey install 4.12.0. Its install scripts were not inspected. Do not add it until there is no required native build, or the native step is optional and `@noble/hashes` still runs. |
| `tiny-secp256k1` | WASM libsecp for sign, verify, Schnorr, and ECDH | MIT. Survey install 2.2.3. Same install-script rule. `@noble/curves` stays the fallback. |

`@frank/crypto-box` planned:

| Package | Role | What was checked |
| --- | --- | --- |
| `@noble/ciphers` | AES-256-GCM and XChaCha20-Poly1305 for issue 254 | MIT. Allowed exact version `1.3.0`, not a range, not installed in this change. npm, viewed 2026-09-30: `1.3.0` has no runtime dependencies, `sideEffects` false, and `.js` export paths. It does not set `"type": "module"`, the same shape as `@noble/hashes` `1.8.0`. `2.4.0` also has no runtime dependencies and is not allowed. Cure53, 1 September 2024, `audit-report_noble-crypto-libs.pdf`, read 2026-09-30: WP1 source is tag `0.6.0`, scope all modules. That report does not cover `1.0.0`, `1.3.0`, or `2.4.0`. README on main, read 2026-09-30, calls `1.0.0` the audited release; the PDF names `0.6.0`. Changelog `1.0.0` (2024-09-12) prohibits AES-GCM nonces shorter than 8 bytes and hides AES error detail. That changelog is not a re-audit. README still documents AES T-tables (NBL-04-001). AI-assisted self-audits are not an audit. AES-CBC stays unused. Issue 254 installs `1.3.0` only ([decision](https://github.com/schancel/frank/issues/353)) and still runs known-answer tests. |
| `@frank/nakamoto` | one ECDH implementation shared with the chain library | Workspace package, MIT. Added when a suite needs it. |

Not runtime dependencies:

- `esbuild` `~0.28.0` (locked at 0.28.2, MIT) builds the browser bundle check. `@frank/frank-codec` already uses that range. The install downloads a platform binary. Consumers do not depend on it.
- `bitcore-lib-xpi` is a devDependency of `@frank/nakamoto` so tests can compare script-number, base58, base58check, and varint bytes. Shared source does not import it.

The workflow `.github/workflows/nakamoto.yml` runs the package tests, the shared-import check, the dependency-list check, and a browser esbuild with no polyfills, then loads the emitted ESM in Node. The size of each entry is printed.
