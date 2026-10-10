import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import {
  deriveSwapSecret,
  encodeEvmHtlcLock,
  encodeEvmHtlcRefund,
  encodeEvmHtlcWithdraw,
  decodeEvmHtlcLockState,
  decodeSolanaHtlcLockState,
  buildSolanaSwapLockInstruction,
  buildSolanaSwapWithdrawInstruction,
  buildSolanaSwapRefundInstruction,
  evaluateSwapStepPhase,
  resolveHtlcContract,
  to32ByteHash,
  toBytes32Hex,
  EVM_GENERIC_HTLC_ABI,
} from "./swap-escrow";
import type { SwapLockRecord } from "./swap-escrow";
import { SOLANA_GENERIC_HTLC_PROGRAM_ID } from "./solana-game-escrow";
import { PROTOCOL_CHAINS } from "./chain/chains-registry";

describe("swap-escrow service & calldata builders", () => {
  const iface = new ethers.Interface(EVM_GENERIC_HTLC_ABI);

  it("derives deterministic preimage and hashlock", () => {
    const swapId = "swap-12345-abcde";
    const secret1 = deriveSwapSecret({ swapId });
    const secret2 = deriveSwapSecret({ swapId });

    expect(secret1.preimage.length).toBe(32);
    expect(secret1.hashLock.length).toBe(32);
    expect(secret1.preimageHex).toBe(secret2.preimageHex);
    expect(secret1.hashLockHex).toBe(secret2.hashLockHex);

    // Verify sha256(preimage) === hashLock
    const manualHash = ethers.sha256(secret1.preimage);
    expect(manualHash).toBe(secret1.hashLockHex);
  });

  it("normalizes lockIds and hashes into 32-byte hex buffers", () => {
    const hash32 = "0x" + "aa".repeat(32);
    expect(toBytes32Hex(hash32)).toBe(hash32);

    const shortStr = "swap-id";
    const normalized = toBytes32Hex(shortStr);
    expect(normalized.startsWith("0x")).toBe(true);
    expect(normalized.length).toBe(66);
  });

  it("resolves the HTLC of a network from the registry, and refuses instead of defaulting", () => {
    for (const id of ["monad-testnet", "monad-mainnet", "ethereum-sepolia"]) {
      const htlc = PROTOCOL_CHAINS[id].contracts?.htlc;
      if (htlc) {
        expect(resolveHtlcContract(id)).toEqual({
          family: "evm",
          contractAddress: htlc,
        });
      } else {
        expect(() => resolveHtlcContract(id)).toThrow(
          `GenericHTLC is not deployed on ${id}`
        );
      }
    }

    // An unknown identifier is not treated as an EVM chain.
    expect(() => resolveHtlcContract("nonexistent")).toThrow(
      'Unknown chain identifier "nonexistent"'
    );
    expect(() => resolveHtlcContract("evm")).toThrow(
      'Unknown chain identifier "evm"'
    );
    expect(() => resolveHtlcContract("xec-mainnet")).toThrow(
      "HTLC swaps are not supported on xec-mainnet"
    );

    // Solana still resolves to a placeholder program id; no program is deployed.
    const solanaConfig = resolveHtlcContract("solana-testnet");
    expect(solanaConfig.family).toBe("solana");
    expect(solanaConfig.contractAddress).toBe(SOLANA_GENERIC_HTLC_PROGRAM_ID);
  });

  it("encodes EVM lock, withdraw, and refund calldata correctly", () => {
    const lockId = "0x" + "11".repeat(32);
    const recipient = "0x1111111111111111111111111111111111111111";
    const refund = "0x2222222222222222222222222222222222222222";
    const hashLock = "0x" + "33".repeat(32);
    const duration = 3600;
    const amount = ethers.parseEther("2.5");

    // 1. Lock
    const htlc = "0x9999999999999999999999999999999999999999";
    const lockTx = encodeEvmHtlcLock({
      contractAddress: htlc,
      lockId,
      recipient,
      refundAddress: refund,
      hashLock,
      durationSeconds: duration,
      amountWei: amount,
    });
    expect(lockTx.value).toBe(amount);
    expect(lockTx.to).toBe(htlc);
    const parsedLock = iface.parseTransaction({ data: lockTx.data });
    expect(parsedLock?.name).toBe("lock");
    expect(parsedLock?.args[0]).toBe(lockId);
    expect(parsedLock?.args[1].toLowerCase()).toBe(recipient.toLowerCase());
    expect(parsedLock?.args[2].toLowerCase()).toBe(refund.toLowerCase());
    expect(parsedLock?.args[3]).toBe(hashLock);
    expect(parsedLock?.args[4]).toBe(BigInt(duration));

    // 2. Withdraw
    const preimage = "0x" + "44".repeat(32);
    const withdrawTx = encodeEvmHtlcWithdraw({
      contractAddress: htlc,
      lockId,
      preimage,
    });
    expect(withdrawTx.to).toBe(htlc);
    const parsedWithdraw = iface.parseTransaction({ data: withdrawTx.data });
    expect(parsedWithdraw?.name).toBe("withdraw");
    expect(parsedWithdraw?.args[0]).toBe(lockId);
    expect(parsedWithdraw?.args[1]).toBe(preimage);

    // 3. Refund
    const refundTx = encodeEvmHtlcRefund({
      contractAddress: htlc,
      lockId,
    });
    expect(refundTx.to).toBe(htlc);
    const parsedRefund = iface.parseTransaction({ data: refundTx.data });
    expect(parsedRefund?.name).toBe("refund");
    expect(parsedRefund?.args[0]).toBe(lockId);
  });

  it("decodes EVM lock state tuples into SwapLockRecord", () => {
    const lockId = "0x" + "55".repeat(32);
    const sender = "0x3333333333333333333333333333333333333333";
    const recipient = "0x4444444444444444444444444444444444444444";
    const refund = "0x5555555555555555555555555555555555555555";
    const hashLock = "0x" + "66".repeat(32);
    const amount = 5_000_000_000_000_000_000n;
    const expiresAt = 1_800_000_000n;

    // Active locked
    const active = decodeEvmHtlcLockState({
      lockId,
      result: [
        sender,
        recipient,
        refund,
        hashLock,
        amount,
        expiresAt,
        false,
        false,
      ],
      currentTimestampSec: 1_700_000_000,
    });
    expect(active.status).toBe("locked");
    expect(active.isExpired).toBe(false);
    expect(active.amount).toBe(amount);

    // Withdrawn
    const withdrawn = decodeEvmHtlcLockState({
      lockId,
      result: [
        sender,
        recipient,
        refund,
        hashLock,
        amount,
        expiresAt,
        true,
        false,
      ],
      currentTimestampSec: 1_700_000_000,
    });
    expect(withdrawn.status).toBe("withdrawn");

    // Expired
    const expired = decodeEvmHtlcLockState({
      lockId,
      result: [
        sender,
        recipient,
        refund,
        hashLock,
        amount,
        expiresAt,
        false,
        false,
      ],
      currentTimestampSec: 1_900_000_000,
    });
    expect(expired.status).toBe("expired");
    expect(expired.isExpired).toBe(true);

    // Unfunded
    const zeroAddr = "0x0000000000000000000000000000000000000000";
    const unfunded = decodeEvmHtlcLockState({
      lockId,
      result: [
        zeroAddr,
        zeroAddr,
        zeroAddr,
        "0x" + "00".repeat(32),
        0n,
        0n,
        false,
        false,
      ],
    });
    expect(unfunded.status).toBe("unfunded");
  });

  it("builds and decodes Solana generic-htlc instructions and binary state", async () => {
    const sender = new PublicKey(new Uint8Array(32).fill(1));
    const recipient = new PublicKey(new Uint8Array(32).fill(2));
    const lockId = new Uint8Array(32).fill(7);
    const hashLock = new Uint8Array(32).fill(8);
    const preimage = new Uint8Array(32).fill(9);

    // 1. Build Solana Lock
    const lockIx = await buildSolanaSwapLockInstruction({
      sender,
      recipient,
      lockId,
      hashLock,
      amountLamports: 1_000_000_000n,
      durationSeconds: 3600,
    });
    expect(lockIx.programId.toBase58()).toBe(SOLANA_GENERIC_HTLC_PROGRAM_ID);
    expect(lockIx.data[0]).toBe(0); // Lock tag

    // 2. Build Solana Withdraw
    const withdrawIx = await buildSolanaSwapWithdrawInstruction({
      caller: recipient,
      recipient,
      lockId,
      preimage,
    });
    expect(withdrawIx.data[0]).toBe(1); // Withdraw tag

    // 3. Build Solana Refund
    const refundIx = await buildSolanaSwapRefundInstruction({
      caller: sender,
      lockId,
    });
    expect(refundIx.data[0]).toBe(4); // Refund tag

    // 4. Decode binary Solana state
    const rawBuffer = new Uint8Array(180);
    rawBuffer[0] = 1; // is_initialized = true
    rawBuffer.set(lockId, 1);
    rawBuffer.set(sender.toBytes(), 33);
    rawBuffer.set(recipient.toBytes(), 65);
    rawBuffer.set(sender.toBytes(), 97); // refund
    rawBuffer.set(hashLock, 129);

    const view = new DataView(rawBuffer.buffer);
    view.setBigUint64(161, 1_000_000_000n, true); // amount
    view.setBigInt64(169, 1_800_000_000n, true); // expires_at
    rawBuffer[177] = 0; // withdrawn
    rawBuffer[178] = 0; // refunded

    const solanaLock = decodeSolanaHtlcLockState({
      lockId,
      accountData: rawBuffer,
      currentTimestampSec: 1_700_000_000,
    });
    expect(solanaLock).not.toBeNull();
    expect(solanaLock?.status).toBe("locked");
    expect(solanaLock?.amount).toBe(1_000_000_000n);
    expect(solanaLock?.recipient).toBe(recipient.toBase58());
  });

  it("evaluates lifecycle steps across cross-chain legs", () => {
    const mockLegA: SwapLockRecord = {
      lockId: "0x1",
      sender: "0xAlice",
      recipient: "0xBob",
      refundAddress: "0xAlice",
      hashLock: "0xHash",
      amount: 100n,
      expiresAt: 2_000_000_000,
      withdrawn: false,
      refunded: false,
      isExpired: false,
      status: "locked",
    };

    const mockLegB: SwapLockRecord = {
      lockId: "0x1",
      sender: "0xBob",
      recipient: "0xAlice",
      refundAddress: "0xBob",
      hashLock: "0xHash",
      amount: 50n,
      expiresAt: 1_900_000_000,
      withdrawn: false,
      refunded: false,
      isExpired: false,
      status: "locked",
    };

    // Phase 1: Maker needs to lock Leg A
    const p1 = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "pending",
      legALock: null,
      legBLock: null,
    });
    expect(p1.phase).toBe("maker_lock_needed");
    expect(p1.canLock).toBe(true);
    expect(p1.canClaim).toBe(false);

    // Phase 2: Maker locked, Taker needs to lock Leg B
    const p2Maker = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "accepted",
      legALock: mockLegA,
      legBLock: null,
    });
    expect(p2Maker.phase).toBe("taker_lock_needed");
    expect(p2Maker.canLock).toBe(false);

    const p2Taker = evaluateSwapStepPhase({
      isMaker: false,
      offerStatus: "accepted",
      legALock: mockLegA,
      legBLock: null,
    });
    expect(p2Taker.phase).toBe("taker_lock_needed");
    expect(p2Taker.canLock).toBe(true);

    // Phase 3: Both locked -> Maker claims Leg B
    const p3Maker = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "accepted",
      legALock: mockLegA,
      legBLock: mockLegB,
    });
    expect(p3Maker.phase).toBe("ready_to_claim");
    expect(p3Maker.canClaim).toBe(true);

    // Phase 4: Preimage revealed -> Taker claims Leg A
    const p4Taker = evaluateSwapStepPhase({
      isMaker: false,
      offerStatus: "accepted",
      legALock: mockLegA,
      legBLock: { ...mockLegB, status: "withdrawn", withdrawn: true },
    });
    expect(p4Taker.phase).toBe("preimage_revealed");
    expect(p4Taker.canClaim).toBe(true);

    // Phase 5: Both settled
    const p5 = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "settled",
      legALock: { ...mockLegA, status: "withdrawn", withdrawn: true },
      legBLock: { ...mockLegB, status: "withdrawn", withdrawn: true },
    });
    expect(p5.phase).toBe("settled");

    // Phase 6: Expired refund
    const p6 = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "accepted",
      legALock: { ...mockLegA, status: "expired", isExpired: true },
      legBLock: null,
    });
    expect(p6.phase).toBe("expired_refundable");
    expect(p6.canRefund).toBe(true);
  });
});
