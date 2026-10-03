import type {
  ChainDescriptor,
  DisplayUnit,
  HeaderShape,
  PolicyAmount,
  ScriptRules,
  SighashFamily,
} from './types.js'

export const UNPINNED_POLICY: PolicyAmount = Object.freeze({
  status: 'unpinned',
  reason:
    'Policy, not consensus. The old library constants of 546 satoshis and 100000 satoshis per kilobyte are not copied onto every chain.',
})

export const COIN_100_000_000: DisplayUnit = Object.freeze({
  status: 'pinned',
  name: 'coin',
  satoshisPerUnit: 100_000_000n,
  source:
    'Bitcoin Core and Bitcoin Cash Node genesis construction uses 50 * COIN, and the chainparams comment prints that output as 50.00000000. Display scale is 1e8 satoshis.',
})

export const FORKID_ZERO = (source: string): SighashFamily =>
  Object.freeze({
    kind: 'forkid',
    forkId: 0 as const,
    source,
  })

export const BITCOIN_80: HeaderShape = Object.freeze({ kind: 'bitcoin-80' })

const HD_MAIN_PUB = 0x0488b21e
const HD_MAIN_PRIV = 0x0488ade4
const HD_TEST_PUB = 0x043587cf
const HD_TEST_PRIV = 0x04358394

export function chain(
  fields: Omit<
    ChainDescriptor,
    'protocolId' | 'proxyFamily' | 'allowedProxyCapabilities' | 'identityProbes'
  >,
): ChainDescriptor {
  return Object.freeze({
    ...fields,
    protocolId: `${fields.family}-${fields.network}`,
    proxyFamily: 'bitcoin' as const,
    allowedProxyCapabilities: Object.freeze([
      'json-rpc' as const,
      'chronik' as const,
    ]),
    identityProbes: Object.freeze([
      Object.freeze({
        kind: 'operator-block-checkpoint' as const,
        capability: 'json-rpc' as const,
      }),
      Object.freeze({
        kind: 'operator-block-checkpoint' as const,
        capability: 'chronik' as const,
      }),
    ]),
    alsoDocumentsSlip44: Object.freeze([...fields.alsoDocumentsSlip44]),
    sources: Object.freeze([...fields.sources]),
  })
}

export function btcLikeVersions(network: 'mainnet' | 'testnet' | 'regtest'): {
  pubkeyHashVersion: number
  scriptHashVersion: number
  wifVersion: number
  hdPublicVersion: number
  hdPrivateVersion: number
} {
  if (network === 'mainnet') {
    return {
      pubkeyHashVersion: 0,
      scriptHashVersion: 5,
      wifVersion: 128,
      hdPublicVersion: HD_MAIN_PUB,
      hdPrivateVersion: HD_MAIN_PRIV,
    }
  }
  return {
    pubkeyHashVersion: 111,
    scriptHashVersion: 196,
    wifVersion: 239,
    hdPublicVersion: HD_TEST_PUB,
    hdPrivateVersion: HD_TEST_PRIV,
  }
}

const PRE_VM_LIMITS = {
  maxElementBytes: 520,
  maxOps: 201,
  maxScriptBytes: 10000,
  maxStackItems: 1000,
  maxScriptNumBytes: 4,
} as const

const STANDARD_FLAGS = {
  tapscript: 'rejected',
  schnorr: 'rejected',
  p2sh: true,
  sigPushOnly: true,
  minimalData: true,
  minimalIf: true,
  cleanStack: true,
  nullDummy: true,
  nullFail: true,
  lowS: true,
  derSig: true,
  strictEnc: true,
  checkLockTime: true,
  checkSequence: true,
  discourageNops: true,
} as const

function scriptRules(
  fields: Omit<
    ScriptRules,
    | 'tapscript'
    | 'schnorr'
    | 'p2sh'
    | 'sigPushOnly'
    | 'minimalData'
    | 'minimalIf'
    | 'cleanStack'
    | 'nullDummy'
    | 'nullFail'
    | 'lowS'
    | 'derSig'
    | 'strictEnc'
    | 'checkLockTime'
    | 'checkSequence'
    | 'discourageNops'
    | 'maxElementBytes'
    | 'maxOps'
    | 'maxScriptBytes'
    | 'maxStackItems'
    | 'maxScriptNumBytes'
  >,
): ScriptRules {
  return Object.freeze({
    ...STANDARD_FLAGS,
    ...PRE_VM_LIMITS,
    ...fields,
  })
}

export const BTC_SCRIPT: ScriptRules = scriptRules({
  era: 'btc-core-standard',
  cat: false,
  bitwise: false,
  divMod: false,
  num2bin: false,
  checkDataSig: false,
  reverseBytes: false,
  introspection: false,
  source:
    'bitcoin/bitcoin src/script/interpreter.cpp standard flags before tapscript. Witness programs are rejected, not evaluated as legacy. Disabled opcodes are OP_CAT, OP_SUBSTR/OP_SPLIT, OP_LEFT/OP_NUM2BIN, OP_RIGHT/OP_BIN2NUM, OP_INVERT, OP_AND, OP_OR, OP_XOR, OP_2MUL, OP_2DIV, OP_MUL, OP_DIV, OP_MOD, OP_LSHIFT, and OP_RSHIFT. Limits are 520-byte elements, 201 counted opcodes, 10000-byte scripts, 1000 stack items, and 4-byte script numbers.',
})

export const BCH_SCRIPT: ScriptRules = scriptRules({
  era: 'bch-2022-05-15',
  cat: true,
  bitwise: true,
  divMod: true,
  num2bin: true,
  checkDataSig: true,
  reverseBytes: true,
  introspection: true,
  source:
    'documentation.cash script opcode table: OP_CAT, OP_SPLIT, OP_AND, OP_OR, OP_XOR, OP_DIV, OP_MOD, OP_NUM2BIN, OP_BIN2NUM, OP_CHECKDATASIG, OP_REVERSEBYTES, and introspection OP_INPUTINDEX at 0xc0 through OP_OUTPUTBYTECODE at 0xcd. Token codepoints 0xce-0xd3 fail closed. OP_MUL, OP_INVERT, OP_2MUL, OP_2DIV, OP_LSHIFT, and OP_RSHIFT stay disabled. This era keeps the pre-May-2025 limits (520, 201, 10000, 1000, 4-byte numbers), not the May 2025 density costs. Schnorr is rejected until issue 249.',
})

export const XEC_SCRIPT: ScriptRules = scriptRules({
  era: 'xec-pre-introspection',
  cat: true,
  bitwise: true,
  divMod: true,
  num2bin: true,
  checkDataSig: true,
  reverseBytes: true,
  introspection: false,
  source:
    'Bitcoin ABC had OP_CAT, OP_SPLIT, bitwise ops, OP_DIV, OP_MOD, OP_NUM2BIN, OP_BIN2NUM, OP_CHECKDATASIG, and OP_REVERSEBYTES before the 2020 split. BCH introspection at 0xc0 is not enabled on this descriptor, so those bytes are not a success. Schnorr is rejected until issue 249.',
})

export const XPI_SCRIPT: ScriptRules = scriptRules({
  era: 'xpi-old-interpreter',
  cat: true,
  bitwise: true,
  divMod: true,
  num2bin: true,
  checkDataSig: true,
  reverseBytes: true,
  introspection: false,
  source:
    'bitcore-lib-xpi lib/script/interpreter.js isOpcodeDisabled enables CAT, SPLIT, AND, OR, XOR, DIV, MOD, BIN2NUM, and NUM2BIN, and the interpreter implements CHECKDATASIG and REVERSEBYTES. MUL, INVERT, LSHIFT, RSHIFT, 2MUL, and 2DIV stay disabled. lotusd was not quoted for an opcode past OP_REVERSEBYTES, so bytes at 0xc0 and above are not OP_NOP. CHECKSIG uses lotus when the algorithm mask is 0x60, and BIP143 fork-id with Ruth replay when the mask is 0x40.',
})

/** Legacy base58 version byte. The chain argument is required. */
export function addressVersionBytes(
  descriptor: ChainDescriptor,
  kind: 'pubkeyhash' | 'scripthash' | 'wif',
): number {
  switch (kind) {
    case 'pubkeyhash':
      return descriptor.pubkeyHashVersion
    case 'scripthash':
      return descriptor.scriptHashVersion
    case 'wif':
      return descriptor.wifVersion
  }
}
