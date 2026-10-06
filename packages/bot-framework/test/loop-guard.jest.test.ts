import { LoopGuard } from "../src/loop-guard";

describe("LoopGuard", () => {
  const selfAddress = "0x1111111111111111111111111111111111111111";
  const blockedAddress = "0x2222222222222222222222222222222222222222";
  const normalUser = "0x3333333333333333333333333333333333333333";

  let guard: LoopGuard;

  beforeEach(() => {
    guard = new LoopGuard({
      selfAddress,
      denylist: [blockedAddress],
      maxRepliesPerPeer: 2,
      windowMs: 1000,
    });
  });

  it("rejects own address echoes", () => {
    const dropReason = guard.shouldDrop(selfAddress);
    expect(dropReason).toBe("self-echo");
  });

  it("rejects denylisted addresses case-insensitively", () => {
    const dropReason = guard.shouldDrop(blockedAddress.toUpperCase());
    expect(dropReason).toBe("denylisted");
  });

  it("rejects known bot senders when peerIsBot is true", () => {
    const dropReason = guard.shouldDrop(normalUser, true);
    expect(dropReason).toBe("peer-is-bot");
  });

  it("accepts messages from normal users within rate limit and drops when limit exceeded", () => {
    expect(guard.shouldDrop(normalUser)).toBeNull();
    guard.recordReply(normalUser);

    expect(guard.shouldDrop(normalUser)).toBeNull();
    guard.recordReply(normalUser);

    expect(guard.shouldDrop(normalUser)).toBe("rate-limited");
  });
});
