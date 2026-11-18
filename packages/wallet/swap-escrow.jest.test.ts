import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import {
  decodeHtlcLock,
  encodeHtlcLock,
  encodeHtlcRefund,
  encodeHtlcWithdraw,
  evmHtlcInterface,
  htlcHashLock,
  htlcLockId,
  HTLC_NATIVE_TOKEN,
  decodeSolanaHtlcLockState,
  buildSolanaSwapLockInstruction,
  buildSolanaSwapWithdrawInstruction,
  buildSolanaSwapRefundInstruction,
  resolveHtlcContract,
} from "./swap-escrow";
import type { EvmHtlcTerms } from "./swap-escrow";
import GenericHTLCArtifact from "@frank/contracts/artifacts/GenericHTLC.json";
import { SOLANA_GENERIC_HTLC_PROGRAM_ID } from "./solana-game-escrow";
import { PROTOCOL_CHAINS } from "./chain/chains-registry";

describe("swap-escrow service & calldata builders", () => {

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

  describe("GenericHTLC v2 (EVM)", () => {
    it("a hash lock is sha256 of exactly 32 bytes, and nothing else is a preimage", () => {
      const preimage = new Uint8Array(32).fill(7);
      expect(htlcHashLock(preimage)).toBe(ethers.sha256(preimage));
      expect(htlcHashLock(ethers.hexlify(preimage))).toBe(ethers.sha256(preimage));
      expect(() => htlcHashLock(new Uint8Array(31))).toThrow(/32 bytes/);
      expect(() => htlcHashLock(ethers.hexlify(new Uint8Array(33)))).toThrow(/32 bytes/);
      expect(() => htlcHashLock("poker:table")).toThrow(/32 bytes/);
    });

    const htlc = "0x9999999999999999999999999999999999999999";
    const sender = "0x3333333333333333333333333333333333333333";
    const terms: EvmHtlcTerms = {
      recipient: "0x1111111111111111111111111111111111111111",
      refundAddress: "0x2222222222222222222222222222222222222222",
      token: HTLC_NATIVE_TOKEN,
      amount: ethers.parseEther("2.5"),
      hashLock: ethers.sha256("0x" + "44".repeat(32)),
      expiresAt: 1_800_000_000n,
    };
    const compiled = new ethers.Interface(GenericHTLCArtifact.abi);

    it("declares exactly the functions and events of the compiled contract", () => {
      // Input names are documentation; the selector fixes the input types. What a call
      // returns, field by field, must match too.
      const fn = (fragment: ethers.FunctionFragment) => ({
        signature: fragment.format("sighash"),
        stateMutability: fragment.stateMutability,
        outputs: fragment.outputs.map((output) => output.format("full")),
      });
      const functions = (i: ethers.Interface) => {
        const out: ReturnType<typeof fn>[] = [];
        i.forEachFunction((fragment) => out.push(fn(fragment)));
        return out.sort((a, b) => a.signature.localeCompare(b.signature));
      };
      const events = (i: ethers.Interface) => {
        const out: string[] = [];
        i.forEachEvent((fragment) => out.push(fragment.format("full")));
        return out.sort();
      };
      expect(functions(evmHtlcInterface)).toEqual(functions(compiled));
      expect(events(evmHtlcInterface)).toEqual(events(compiled));
    });

    it("computes the lock id the contract's lockIdOf gives", () => {
      const id = htlcLockId(sender, terms);
      expect(id).toBe(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "address", "address", "uint256", "bytes32", "uint64"],
            [sender, terms.recipient, terms.refundAddress, terms.token, terms.amount, terms.hashLock, terms.expiresAt]
          )
        )
      );
      // Every term and the sender are part of it.
      const other = "0x4444444444444444444444444444444444444444";
      for (const changed of [
        htlcLockId(other, terms),
        htlcLockId(sender, { ...terms, recipient: other }),
        htlcLockId(sender, { ...terms, refundAddress: other }),
        htlcLockId(sender, { ...terms, token: other }),
        htlcLockId(sender, { ...terms, amount: terms.amount + 1n }),
        htlcLockId(sender, { ...terms, hashLock: "0x" + "55".repeat(32) }),
        htlcLockId(sender, { ...terms, expiresAt: terms.expiresAt + 1n }),
      ]) {
        expect(changed).not.toBe(id);
      }
    });

    it("encodes lock, withdraw and refund for the v2 ABI", () => {
      const lockTx = encodeHtlcLock(htlc, terms);
      expect(lockTx.to).toBe(ethers.getAddress(htlc));
      expect(lockTx.value).toBe(terms.amount);
      const lock = compiled.parseTransaction({ data: lockTx.data, value: lockTx.value });
      expect(lock?.signature).toBe("lock(address,address,address,uint256,bytes32,uint64)");
      expect([...lock!.args]).toEqual([
        terms.recipient,
        terms.refundAddress,
        terms.token,
        terms.amount,
        terms.hashLock,
        terms.expiresAt,
      ]);

      // A token lock carries no value.
      const token = "0x7777777777777777777777777777777777777777";
      expect(encodeHtlcLock(htlc, { ...terms, token }).value).toBe(0n);

      const lockId = htlcLockId(sender, terms);
      const preimage = "0x" + "44".repeat(32);
      const withdraw = compiled.parseTransaction({
        data: encodeHtlcWithdraw(htlc, lockId, preimage).data,
      });
      expect(withdraw?.signature).toBe("withdraw(bytes32,bytes32)");
      expect([...withdraw!.args]).toEqual([lockId, preimage]);
      expect(encodeHtlcWithdraw(htlc, ethers.getBytes(lockId), ethers.getBytes(preimage)).data).toBe(
        encodeHtlcWithdraw(htlc, lockId, preimage).data
      );

      const refund = compiled.parseTransaction({ data: encodeHtlcRefund(htlc, lockId).data });
      expect(refund?.signature).toBe("refund(bytes32)");
      expect([...refund!.args]).toEqual([lockId]);
    });

    it("refuses terms and values the contract would refuse, or that are not what they claim", () => {
      const bad: [Partial<EvmHtlcTerms>, RegExp][] = [
        [{ recipient: ethers.ZeroAddress }, /recipient must not be the zero address/],
        [{ refundAddress: ethers.ZeroAddress }, /refund address must not be the zero address/],
        [{ refundAddress: undefined }, /refund address must be a 20-byte address/],
        [{ recipient: "0x1234" }, /recipient must be a 20-byte address/],
        [{ amount: 0n }, /amount must be a positive bigint/],
        [{ amount: 1 as unknown as bigint }, /amount must be a positive bigint/],
        [{ expiresAt: 0n }, /expiresAt must be a positive uint64/],
        [{ expiresAt: 1n << 64n }, /expiresAt must be a positive uint64/],
        [{ expiresAt: 1_800_000_000 as unknown as bigint }, /expiresAt must be a positive uint64/],
        [{ hashLock: "0x" + "33".repeat(31) }, /hash lock must be exactly 32 bytes/],
        [{ hashLock: "33".repeat(32) }, /hash lock must be exactly 32 bytes/],
        [{ hashLock: "swap-id" }, /hash lock must be exactly 32 bytes/],
      ];
      for (const [change, message] of bad) {
        expect(() => encodeHtlcLock(htlc, { ...terms, ...change })).toThrow(message);
        expect(() => htlcLockId(sender, { ...terms, ...change })).toThrow(message);
      }
      expect(() => encodeHtlcLock("0x99", terms)).toThrow(/contract must be a 20-byte address/);
      // Frank never opens a lock that pays the recipient either way; the contract permits one
      // (htlc-round locks to itself), so its id can still be computed.
      const selfLock = { ...terms, refundAddress: terms.recipient.toUpperCase().replace("0X", "0x") };
      expect(() => encodeHtlcLock(htlc, selfLock)).toThrow(/must not be its recipient/);
      expect(htlcLockId(sender, selfLock)).toMatch(/^0x[0-9a-f]{64}$/);
      expect(() => htlcLockId(ethers.ZeroAddress, terms)).toThrow(/sender must not be the zero/);

      const lockId = htlcLockId(sender, terms);
      // The preimage is exactly 32 bytes; nothing is hashed or padded into shape.
      for (const preimage of ["0x" + "44".repeat(31), "0x" + "44".repeat(33), "secret", new Uint8Array(31)]) {
        expect(() => encodeHtlcWithdraw(htlc, lockId, preimage)).toThrow(/preimage must be exactly 32 bytes/);
      }
      expect(() => encodeHtlcWithdraw(htlc, "swap-1", "0x" + "44".repeat(32))).toThrow(
        /lock id must be exactly 32 bytes/
      );
      expect(() => encodeHtlcRefund(htlc, new Uint8Array(33))).toThrow(/lock id must be exactly 32 bytes/);
    });

    it("decodes what locks(lockId) returns, as the compiled contract encodes it", () => {
      const lockId = htlcLockId(sender, terms);
      const encode = (state: number, preimage = ethers.ZeroHash, from = sender, refundAddress = terms.refundAddress) =>
        compiled.encodeFunctionResult("locks", [
          from,
          terms.recipient,
          refundAddress,
          terms.token,
          terms.hashLock,
          terms.amount,
          terms.expiresAt,
          state,
          preimage,
        ]);
      const base = {
        lockId,
        sender,
        recipient: terms.recipient,
        refundAddress: terms.refundAddress,
        token: terms.token,
        amount: terms.amount,
        hashLock: terms.hashLock,
        expiresAt: terms.expiresAt,
      };
      expect(decodeHtlcLock(lockId, encode(1))).toEqual({ ...base, state: "open", preimage: null });
      const preimage = "0x" + "44".repeat(32);
      expect(decodeHtlcLock(lockId, encode(2, preimage))).toEqual({ ...base, state: "withdrawn", preimage });
      expect(decodeHtlcLock(lockId, encode(3))).toEqual({ ...base, state: "refunded", preimage: null });

      const none = compiled.encodeFunctionResult("locks", [
        ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        ethers.ZeroHash, 0n, 0n, 0, ethers.ZeroHash,
      ]);
      expect(decodeHtlcLock(lockId, none)).toBeNull();
      expect(() => decodeHtlcLock(lockId, encode(4))).toThrow(/unknown state 4/);
      // A lock recorded under another sender is not this id: not GenericHTLC v2's answer.
      expect(() =>
        decodeHtlcLock(lockId, encode(1, ethers.ZeroHash, "0x5555555555555555555555555555555555555555"))
      ).toThrow(/does not match its recorded terms/);

      // A withdrawn lock's preimage must open its hash lock.
      expect(() => decodeHtlcLock(lockId, encode(2, "0x" + "45".repeat(32)))).toThrow(
        /preimage that does not match/
      );

      // A genuine lock whose refund address is its recipient (as htlc-round makes) decodes.
      const selfTerms = { ...terms, refundAddress: terms.recipient };
      const selfId = htlcLockId(sender, selfTerms);
      expect(decodeHtlcLock(selfId, encode(2, preimage, sender, terms.recipient))).toEqual({
        ...base,
        lockId: selfId,
        refundAddress: terms.recipient,
        state: "withdrawn",
        preimage,
      });
    });
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
    expect(solanaLock?.lockId).toBe("0x" + "07".repeat(32));

    // Ids and hash locks are exactly 32 bytes: text is refused, never hashed into shape.
    await expect(
      buildSolanaSwapRefundInstruction({ caller: sender, lockId: "swap-id" })
    ).rejects.toThrow("generic-htlc lock id must be exactly 32 bytes");
    await expect(
      buildSolanaSwapLockInstruction({
        sender,
        recipient,
        lockId,
        hashLock: new Uint8Array(31),
        amountLamports: 1n,
        durationSeconds: 1,
      })
    ).rejects.toThrow("generic-htlc hash lock must be exactly 32 bytes");
  });
});
