import { secp256k1 } from '@noble/curves/secp256k1'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { sha256 } from '@noble/hashes/sha256'

import {
  BTC_MAINNET,
  BTC_TESTNET,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  createPsbt,
  encodeAddress,
  extractPsbtTransaction,
  finalizePsbt,
  internalHashFromBytes,
  lockingScript,
  parsePsbt,
  parseTransaction,
  privateKeyFromBytes,
  psbtToBase64,
  psbtToHex,
  pubkeyHashFromBytes,
  publicFromPrivate,
  serializePsbt,
  serializeTransaction,
  sighash,
  signPsbt,
  signingKey,
  transactionId,
  type InternalHash,
  type SigningKey,
  type Transaction,
} from '../src/index.js'

function hash160(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(ripemd160(sha256(bytes)))
}

function makeSigner(
  secretByte: number,
  compressed = true,
): {
  signer: SigningKey
  pubkey: Uint8Array
  pubkeyHash: Uint8Array
  p2wpkhScript: Uint8Array
  p2pkhScript: Uint8Array
  btcAddress: string
} {
  const secret = new Uint8Array(32).fill(secretByte)
  const priv = privateKeyFromBytes(secret, compressed)
  if (!priv.ok) throw new Error('Failed to create private key')
  const signerRes = signingKey('ecdsa', priv.value)
  if (!signerRes.ok) throw new Error('Failed to create signing key')
  const pubRes = publicFromPrivate(priv.value)
  if (!pubRes.ok) throw new Error('Failed to derive public key')
  const pubkey = compressed
    ? pubRes.value.compressed
    : pubRes.value.uncompressed
  const pkHashBytes = hash160(pubkey)
  const pkHash = pubkeyHashFromBytes(pkHashBytes)
  if (!pkHash.ok) throw new Error('Failed to create pubkey hash')
  const p2wpkhScript = lockingScript({ kind: 'p2wpkh', hash: pkHash.value })
  const p2pkhScript = lockingScript({ kind: 'p2pkh', hash: pkHash.value })
  const addrRes = encodeAddress(
    { kind: 'p2wpkh', hash: pkHash.value },
    BTC_TESTNET,
    'bech32',
  )
  const btcAddress = addrRes.ok ? addrRes.value : ''
  return {
    signer: signerRes.value,
    pubkey,
    pubkeyHash: pkHashBytes,
    p2wpkhScript,
    p2pkhScript,
    btcAddress,
  }
}

function makePrevTx(
  outputs: ReadonlyArray<{ value: bigint; scriptPubKey: Uint8Array }>,
): { tx: Transaction; txid: InternalHash } {
  const fakePrev = internalHashFromBytes(new Uint8Array(32).fill(0xaa))
  if (!fakePrev.ok) throw new Error('bad hash')
  const tx: Transaction = {
    version: 2,
    inputs: [
      {
        prevout: { txid: fakePrev.value, vout: 0 },
        scriptSig: new Uint8Array(0),
        sequence: 0xffffffff,
      },
    ],
    outputs,
    locktime: 0,
  }
  const id = transactionId(tx, BTC_MAINNET)
  if (!id.ok) throw new Error('bad txid')
  return { tx, txid: id.value }
}

describe('BIP-174 PSBT v0 codec, signing, finalization, and extraction', () => {
  test('round-trips createPsbt -> serializePsbt -> parsePsbt (bytes, hex, base64) and preserves unknown key-values', () => {
    const alice = makeSigner(1)
    const bob = makeSigner(2)
    const prev = makePrevTx([
      { value: 50_000n, scriptPubKey: alice.p2wpkhScript },
    ])

    const unsignedTx: Transaction = {
      version: 2,
      inputs: [
        {
          prevout: { txid: prev.txid, vout: 0 },
          scriptSig: new Uint8Array(0),
          sequence: 0xfffffffe,
        },
      ],
      outputs: [{ value: 49_000n, scriptPubKey: bob.p2wpkhScript }],
      locktime: 100,
    }

    const basePsbt = createPsbt({
      unsignedTx,
      inputs: [
        {
          witnessUtxo: { value: 50_000n, script: alice.p2wpkhScript },
          nonWitnessUtxo: prev.tx,
          sighashType: SIGHASH_ALL,
          redeemScript: Uint8Array.of(0x51),
          witnessScript: Uint8Array.of(0x52),
        },
      ],
    })

    // Add unknown global, input, and output key-values plus bip32Derivation and tapKeySig
    const baseInput0 = basePsbt.inputs[0]
    if (!baseInput0) throw new Error('missing input 0')
    const psbtWithExtras = {
      ...basePsbt,
      globalUnknownKeyVals: [
        {
          keyType: 0xfb,
          keyData: Uint8Array.of(1, 2),
          value: Uint8Array.of(3, 4, 5),
        },
      ],
      inputs: [
        {
          ...baseInput0,
          bip32Derivations: [
            [
              alice.pubkey,
              Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x80),
            ] as const,
          ],
          tapKeySig: new Uint8Array(64).fill(0x77),
          unknownKeyVals: [
            {
              keyType: 0xfe,
              keyData: Uint8Array.of(9),
              value: Uint8Array.of(10, 11),
            },
          ],
        },
      ],
      outputs: [
        {
          unknownKeyVals: [
            {
              keyType: 0xfd,
              keyData: Uint8Array.of(6),
              value: Uint8Array.of(7, 8),
            },
          ],
        },
      ],
    }

    const rawBytes = serializePsbt(psbtWithExtras)
    expect(Array.from(rawBytes.slice(0, 5))).toEqual([
      0x70, 0x73, 0x62, 0x74, 0xff,
    ])

    const hexStr = psbtToHex(psbtWithExtras)
    const base64Str = psbtToBase64(psbtWithExtras)

    const fromBytes = parsePsbt(rawBytes)
    const fromHex = parsePsbt(hexStr)
    const fromBase64 = parsePsbt(base64Str)

    expect(psbtToHex(fromBytes)).toBe(hexStr)
    expect(psbtToHex(fromHex)).toBe(hexStr)
    expect(psbtToBase64(fromBase64)).toBe(base64Str)

    expect(fromHex.unsignedTx.version).toBe(2)
    expect(fromHex.unsignedTx.locktime).toBe(100)
    expect(fromHex.inputs[0]?.witnessUtxo?.value).toBe(50_000n)
    expect(fromHex.inputs[0]?.witnessUtxo?.script).toEqual(alice.p2wpkhScript)
    expect(fromHex.inputs[0]?.sighashType).toBe(SIGHASH_ALL)
    expect(fromHex.inputs[0]?.redeemScript).toEqual(Uint8Array.of(0x51))
    expect(fromHex.inputs[0]?.witnessScript).toEqual(Uint8Array.of(0x52))
    expect(fromHex.inputs[0]?.bip32Derivations).toHaveLength(1)
    expect(fromHex.inputs[0]?.tapKeySig).toEqual(new Uint8Array(64).fill(0x77))
    expect(fromHex.globalUnknownKeyVals).toEqual(
      psbtWithExtras.globalUnknownKeyVals,
    )
    expect(fromHex.inputs[0]?.unknownKeyVals).toEqual(
      psbtWithExtras.inputs[0]?.unknownKeyVals,
    )
    expect(fromHex.outputs[0]?.unknownKeyVals).toEqual(
      psbtWithExtras.outputs[0]?.unknownKeyVals,
    )
  })

  test('signs, finalizes, and extracts a single-input P2WPKH PSBT with valid BIP-143 signature', () => {
    const alice = makeSigner(10)
    const bob = makeSigner(20)
    const prev = makePrevTx([
      { value: 100_000n, scriptPubKey: alice.p2wpkhScript },
    ])

    const unsignedTx: Transaction = {
      version: 2,
      inputs: [
        {
          prevout: { txid: prev.txid, vout: 0 },
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
        },
      ],
      outputs: [{ value: 99_000n, scriptPubKey: bob.p2wpkhScript }],
      locktime: 0,
    }

    const psbt = createPsbt({
      unsignedTx,
      inputs: [
        { witnessUtxo: { value: 100_000n, script: alice.p2wpkhScript } },
      ],
    })

    const signed = signPsbt(psbt, [alice.signer])
    expect(signed.inputs[0]?.partialSigs).toHaveLength(1)
    const firstPartial = signed.inputs[0]?.partialSigs[0]
    if (!firstPartial) throw new Error('missing partial sig')
    const [sigPubkey, sigBytes] = firstPartial
    expect(sigPubkey).toEqual(alice.pubkey)
    expect(sigBytes[sigBytes.length - 1]).toBe(SIGHASH_ALL)

    // Verify BIP-143 digest against partial signature
    const digest = sighash(unsignedTx, 0, BTC_MAINNET, SIGHASH_ALL, {
      algorithm: 'bip143',
      scriptCode: alice.p2pkhScript,
      amount: 100_000n,
    })
    if (!digest.ok) throw new Error('sighash failed')
    const parsedSig = secp256k1.Signature.fromDER(sigBytes.slice(0, -1))
    expect(secp256k1.verify(parsedSig, digest.value, alice.pubkey)).toBe(true)

    // Round-trip signed PSBT before finalization
    const roundTripped = parsePsbt(psbtToBase64(signed))
    expect(roundTripped.inputs[0]?.partialSigs).toHaveLength(1)

    const finalized = finalizePsbt(roundTripped)
    expect(finalized.inputs[0]?.partialSigs).toHaveLength(0)
    expect(finalized.inputs[0]?.finalScriptWitness).toBeDefined()

    const extracted = extractPsbtTransaction(finalized)
    expect(extracted.inputs[0]?.scriptSig).toHaveLength(0)
    expect(extracted.inputs[0]?.witness).toEqual([sigBytes, alice.pubkey])

    const serialized = serializeTransaction(extracted, BTC_MAINNET)
    expect(serialized.ok).toBe(true)
    if (serialized.ok) {
      const reparsed = parseTransaction(serialized.value, BTC_MAINNET)
      expect(reparsed.ok).toBe(true)
    }
  })

  test('signs, finalizes, and extracts a single-input P2PKH PSBT with nonWitnessUtxo', () => {
    const alice = makeSigner(11)
    const bob = makeSigner(21)
    const prev = makePrevTx([
      { value: 25_000n, scriptPubKey: bob.p2pkhScript },
      { value: 75_000n, scriptPubKey: alice.p2pkhScript },
    ])

    const unsignedTx: Transaction = {
      version: 2,
      inputs: [
        {
          prevout: { txid: prev.txid, vout: 1 },
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
        },
      ],
      outputs: [{ value: 74_000n, scriptPubKey: bob.p2pkhScript }],
      locktime: 0,
    }

    const psbt = createPsbt({
      unsignedTx,
      inputs: [{ nonWitnessUtxo: prev.tx }],
    })

    const signed = signPsbt(psbt, [alice.signer], { autoFinalized: true })
    expect(signed.inputs[0]?.partialSigs).toHaveLength(0)
    expect(signed.inputs[0]?.finalScriptSig).toBeDefined()

    const extracted = extractPsbtTransaction(signed)
    const extractedInput0 = extracted.inputs[0]
    if (!extractedInput0) throw new Error('missing extracted input 0')
    const scriptSig = extractedInput0.scriptSig
    expect(scriptSig.length).toBeGreaterThan(35)
    expect(extracted.inputs[0]?.witness).toBeUndefined()

    const sigLen = scriptSig[0] ?? 0
    const sigWithHashtype = scriptSig.slice(1, 1 + sigLen)
    const pubLen = scriptSig[1 + sigLen] ?? 0
    const pubkey = scriptSig.slice(2 + sigLen, 2 + sigLen + pubLen)
    expect(pubkey).toEqual(alice.pubkey)

    const digest = sighash(unsignedTx, 0, BTC_MAINNET, SIGHASH_ALL, {
      algorithm: 'legacy',
      scriptCode: alice.p2pkhScript,
    })
    if (!digest.ok) throw new Error('legacy sighash failed')
    const parsedSig = secp256k1.Signature.fromDER(sigWithHashtype.slice(0, -1))
    expect(secp256k1.verify(parsedSig, digest.value, alice.pubkey)).toBe(true)
  })

  test('signs multi-input mixed P2WPKH + P2PKH PSBT and respects toSignInputs filtering', () => {
    const alice = makeSigner(31)
    const bob = makeSigner(32)
    const carol = makeSigner(33)

    const prev0 = makePrevTx([
      { value: 40_000n, scriptPubKey: alice.p2wpkhScript },
    ])
    const prev1 = makePrevTx([
      { value: 60_000n, scriptPubKey: bob.p2pkhScript },
    ])
    const prev2 = makePrevTx([
      { value: 80_000n, scriptPubKey: carol.p2wpkhScript },
    ])

    const unsignedTx: Transaction = {
      version: 2,
      inputs: [
        {
          prevout: { txid: prev0.txid, vout: 0 },
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
        },
        {
          prevout: { txid: prev1.txid, vout: 0 },
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
        },
        {
          prevout: { txid: prev2.txid, vout: 0 },
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
        },
      ],
      outputs: [{ value: 175_000n, scriptPubKey: alice.p2wpkhScript }],
      locktime: 0,
    }

    const psbt = createPsbt({
      unsignedTx,
      inputs: [
        { witnessUtxo: { value: 40_000n, script: alice.p2wpkhScript } },
        {
          nonWitnessUtxo: prev1.tx,
          sighashType: SIGHASH_ALL | SIGHASH_ANYONECANPAY,
        },
        { witnessUtxo: { value: 80_000n, script: carol.p2wpkhScript } },
      ],
    })

    const alicePubHex = Buffer.from(alice.pubkey).toString('hex')

    // First pass: only sign input 0 (by publicKeyHex) and input 2 (by address), skipping input 1
    const step1 = signPsbt(psbt, [alice.signer, bob.signer, carol.signer], {
      chain: BTC_TESTNET,
      toSignInputs: [
        { index: 0, publicKeyHex: alicePubHex },
        { index: 2, address: carol.btcAddress },
      ],
    })

    expect(step1.inputs[0]?.partialSigs).toHaveLength(1)
    expect(step1.inputs[1]?.partialSigs).toHaveLength(0)
    expect(step1.inputs[2]?.partialSigs).toHaveLength(1)

    // Unfinalized extraction should fail
    expect(() => extractPsbtTransaction(step1)).toThrow(/not finalized/)

    // Second pass: sign input 1 with matching sighashTypes filter
    const step2 = signPsbt(step1, [bob.signer], {
      toSignInputs: [
        { index: 1, sighashTypes: [SIGHASH_ALL | SIGHASH_ANYONECANPAY] },
      ],
    })
    expect(step2.inputs[1]?.partialSigs).toHaveLength(1)
    expect(step2.inputs[1]?.partialSigs[0]?.[1]?.slice(-1)[0]).toBe(
      SIGHASH_ALL | SIGHASH_ANYONECANPAY,
    )

    const finalized = finalizePsbt(step2)
    const tx = extractPsbtTransaction(finalized)
    expect(tx.inputs[0]?.witness).toHaveLength(2)
    expect(tx.inputs[1]?.scriptSig.length).toBeGreaterThan(0)
    expect(tx.inputs[2]?.witness).toHaveLength(2)
  })

  test('rejects invalid magic header, duplicate keys, non-empty unsigned scriptSig, and mismatched nonWitnessUtxo txid', () => {
    const alice = makeSigner(41)
    const prev = makePrevTx([
      { value: 10_000n, scriptPubKey: alice.p2wpkhScript },
    ])
    const wrongPrev = makePrevTx([
      { value: 99_999n, scriptPubKey: alice.p2wpkhScript },
    ])

    // Invalid magic header
    expect(() => parsePsbt('001122334455')).toThrow(/Invalid PSBT magic header/)

    // Mismatched nonWitnessUtxo txid in createPsbt
    const unsignedTx: Transaction = {
      version: 2,
      inputs: [
        {
          prevout: { txid: prev.txid, vout: 0 },
          scriptSig: new Uint8Array(0),
          sequence: 0xffffffff,
        },
      ],
      outputs: [{ value: 9_000n, scriptPubKey: alice.p2wpkhScript }],
      locktime: 0,
    }
    expect(() =>
      createPsbt({
        unsignedTx,
        inputs: [{ nonWitnessUtxo: wrongPrev.tx }],
      }),
    ).toThrow(/nonWitnessUtxo txid does not match/)

    // Non-empty scriptSig in unsignedTx
    const signedInputTx: Transaction = {
      ...unsignedTx,
      inputs: [
        {
          prevout: { txid: prev.txid, vout: 0 },
          scriptSig: Uint8Array.of(0x01, 0x01),
          sequence: 0xffffffff,
        },
      ],
    }
    expect(() => createPsbt({ unsignedTx: signedInputTx })).toThrow(
      /non-empty scriptSig/,
    )

    // Duplicate key in global map
    const validBytes = serializePsbt(createPsbt({ unsignedTx }))
    // Construct a PSBT with duplicate unknown key 0x01 0xfb 0x01 0xaa in global map before separator
    const dupGlobal = Uint8Array.of(
      0x70,
      0x73,
      0x62,
      0x74,
      0xff,
      0x01,
      0xfb,
      0x01,
      0xaa,
      0x01,
      0xfb,
      0x01,
      0xbb,
      0x00,
    )
    expect(() => parsePsbt(dupGlobal)).toThrow(/Duplicate key in PSBT map/)

    // Missing PSBT_GLOBAL_UNSIGNED_TX
    const missingUnsigned = Uint8Array.of(
      0x70,
      0x73,
      0x62,
      0x74,
      0xff,
      0x01,
      0xfb,
      0x01,
      0xaa,
      0x00,
    )
    expect(() => parsePsbt(missingUnsigned)).toThrow(
      /Missing required PSBT_GLOBAL_UNSIGNED_TX/,
    )

    // Trailing bytes after output maps
    const withTrailing = new Uint8Array(validBytes.length + 1)
    withTrailing.set(validBytes, 0)
    withTrailing[validBytes.length] = 0x00
    expect(() => parsePsbt(withTrailing)).toThrow(/Trailing bytes/)
  })
})
