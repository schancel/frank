import {
  decodeRlp,
  encodeRlp,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  recoverAddress,
  type Signature,
} from "ethers";

/** Tempo's self-paid 0x76 transaction. These values are never native ETH balances. */
export interface TempoTransaction {
  chainId: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  calls: readonly { to: string; value: bigint; data: string }[];
  nonce: bigint;
  feeToken: string;
  nonceKey?: bigint;
  validBefore?: bigint;
  validAfter?: bigint;
}

const MAX_U256 = (1n << 256n) - 1n;
const MAX_U64 = (1n << 64n) - 1n;
const PATHUSD_DECIMAL_SCALE = 1_000_000_000_000n;

function unsigned(value: bigint, name: string, max = MAX_U256): string {
  if (value < 0n || value > max)
    throw new RangeError(`${name} is out of range`);
  if (value === 0n) return "0x";
  const hex = value.toString(16);
  return `0x${hex.length % 2 ? "0" : ""}${hex}`;
}

type RlpData = string | RlpData[];

function payload(tx: TempoTransaction): RlpData[] {
  if (tx.chainId === 0n || tx.gasLimit === 0n)
    throw new RangeError("Tempo chain and gas limit must be positive");
  if (tx.calls.length === 0)
    throw new RangeError("Tempo transaction has no calls");
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas)
    throw new RangeError("Tempo priority fee exceeds maximum fee");
  if ((tx.nonceKey ?? 0n) === MAX_U256 && (tx.validBefore ?? 0n) === 0n)
    throw new RangeError("Expiring Tempo nonce requires validBefore");
  return [
    unsigned(tx.chainId, "chainId"),
    unsigned(tx.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    unsigned(tx.maxFeePerGas, "maxFeePerGas"),
    unsigned(tx.gasLimit, "gasLimit", MAX_U64),
    tx.calls.map((call) => [
      getAddress(call.to),
      unsigned(call.value, "call value"),
      hexlify(getBytes(call.data)),
    ]),
    [],
    unsigned(tx.nonceKey ?? 0n, "nonceKey"),
    unsigned(tx.nonce, "nonce", MAX_U64),
    unsigned(tx.validBefore ?? 0n, "validBefore", MAX_U64),
    unsigned(tx.validAfter ?? 0n, "validAfter", MAX_U64),
    /^0x0{40}$/i.test(tx.feeToken) ? "0x" : getAddress(tx.feeToken),
    "0x", // Self-paid; no fee payer signature.
    [], // Authorization list.
  ];
}

/** Hash signed by a self-paid root secp256k1 key, per Tempo transaction spec. */
export function tempoSigningHash(tx: TempoTransaction): string {
  return keccak256(`0x76${encodeRlp(payload(tx)).slice(2)}`);
}

/** Encode an already signed transaction; custody keeps the private key. */
export function encodeSignedTempoTransaction(
  tx: TempoTransaction,
  signature: Pick<Signature, "r" | "s" | "yParity">,
  expectedSender: string
): { rawTransaction: string; transactionHash: string } {
  const hash = tempoSigningHash(tx);
  const envelope = hexlify(
    Uint8Array.from([
      ...getBytes(signature.r),
      ...getBytes(signature.s),
      signature.yParity,
    ])
  );
  if (getBytes(envelope).length !== 65 || signature.yParity > 1)
    throw new Error("Invalid Tempo secp256k1 signature");
  if (
    getAddress(recoverAddress(hash, signature)) !== getAddress(expectedSender)
  )
    throw new Error("Tempo signature does not match spending account");
  const rawTransaction = `0x76${encodeRlp([...payload(tx), envelope]).slice(
    2
  )}`;
  return { rawTransaction, transactionHash: keccak256(rawTransaction) };
}

/** Conservative fee hold in the same six decimal base units as pathUSD balanceOf. */
export function tempoPathUsdMaximumFee(
  gasLimit: bigint,
  maxFeePerGas: bigint
): bigint {
  if (
    gasLimit < 0n ||
    gasLimit > MAX_U64 ||
    maxFeePerGas < 0n ||
    maxFeePerGas > MAX_U256
  )
    throw new RangeError("Tempo fee input is out of range");
  const feeWei = gasLimit * maxFeePerGas;
  return (feeWei + PATHUSD_DECIMAL_SCALE - 1n) / PATHUSD_DECIMAL_SCALE;
}

function scalar(value: RlpData, name: string, max = MAX_U256): bigint {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value))
    throw new Error(`Invalid Tempo ${name}`);
  if (value !== "0x" && getBytes(value)[0] === 0)
    throw new Error(`Noncanonical Tempo ${name}`);
  const parsed = value === "0x" ? 0n : BigInt(value);
  if (parsed > max) throw new RangeError(`Tempo ${name} is out of range`);
  return parsed;
}

function address(value: RlpData, name: string): string {
  if (typeof value !== "string" || getBytes(value).length !== 20)
    throw new Error(`Invalid Tempo ${name}`);
  return getAddress(value);
}

/** Parse and verify a self-paid 0x76 transaction for one expected chain. */
export function decodeSignedTempoTransaction(
  rawTransaction: string,
  expectedChainId: bigint
): {
  sender: string;
  transactionHash: string;
  transaction: TempoTransaction;
} {
  if (!rawTransaction.startsWith("0x76"))
    throw new Error("Not a Tempo transaction");
  const decoded = decodeRlp(`0x${rawTransaction.slice(4)}`);
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 14 ||
    typeof decoded[13] !== "string"
  )
    throw new Error("Invalid Tempo transaction payload");
  const calls = decoded[4];
  if (!Array.isArray(calls) || calls.length === 0)
    throw new Error("Invalid Tempo calls");
  if (
    !Array.isArray(decoded[5]) ||
    decoded[5].length !== 0 ||
    decoded[11] !== "0x" ||
    !Array.isArray(decoded[12]) ||
    decoded[12].length !== 0
  )
    throw new Error("Unsupported Tempo transaction variant");
  const feeTokenRaw = decoded[10];
  const transaction: TempoTransaction = {
    chainId: scalar(decoded[0], "chainId"),
    maxPriorityFeePerGas: scalar(decoded[1], "maxPriorityFeePerGas"),
    maxFeePerGas: scalar(decoded[2], "maxFeePerGas"),
    gasLimit: scalar(decoded[3], "gasLimit", MAX_U64),
    calls: calls.map((call, index) => {
      if (
        !Array.isArray(call) ||
        call.length !== 3 ||
        typeof call[2] !== "string"
      )
        throw new Error(`Invalid Tempo call ${index}`);
      return {
        to: address(call[0], `call ${index} target`),
        value: scalar(call[1], `call ${index} value`),
        data: hexlify(getBytes(call[2])),
      };
    }),
    nonceKey: scalar(decoded[6], "nonceKey"),
    nonce: scalar(decoded[7], "nonce", MAX_U64),
    validBefore: scalar(decoded[8], "validBefore", MAX_U64),
    validAfter: scalar(decoded[9], "validAfter", MAX_U64),
    feeToken:
      feeTokenRaw === "0x"
        ? "0x0000000000000000000000000000000000000000"
        : address(feeTokenRaw, "feeToken"),
  };
  if (transaction.chainId !== expectedChainId)
    throw new Error("Tempo transaction belongs to another chain");
  if (encodeRlp(payload(transaction)) !== encodeRlp(decoded.slice(0, 13)))
    throw new Error("Noncanonical Tempo transaction payload");
  const signatureBytes = getBytes(decoded[13]);
  if (signatureBytes.length !== 65 || signatureBytes[64]! > 1)
    throw new Error("Invalid Tempo transaction signature");
  const unsigned = `0x76${encodeRlp(decoded.slice(0, 13)).slice(2)}`;
  const sender = recoverAddress(keccak256(unsigned), {
    r: hexlify(signatureBytes.slice(0, 32)),
    s: hexlify(signatureBytes.slice(32, 64)),
    yParity: signatureBytes[64]! as 0 | 1,
  });
  return { sender, transactionHash: keccak256(rawTransaction), transaction };
}
