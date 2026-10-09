import {
  DEFAULT_MAX_REPLIES_PER_PEER,
  GAME_MAX_REPLIES_PER_PEER,
  LoopGuard,
} from "../src/loop-guard";

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

  it("allows twenty replies per peer by default, and what it is configured with otherwise", () => {
    expect(DEFAULT_MAX_REPLIES_PER_PEER).toBe(20);
    expect(GAME_MAX_REPLIES_PER_PEER).toBe(300);
    const byDefault = new LoopGuard({ selfAddress });
    expect(byDefault.limit).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(byDefault.shouldDrop(normalUser)).toBeNull();
      byDefault.recordReply(normalUser);
    }
    expect(byDefault.shouldDrop(normalUser)).toBe("rate-limited");

    const game = new LoopGuard({
      selfAddress,
      maxRepliesPerPeer: GAME_MAX_REPLIES_PER_PEER,
    });
    for (let i = 0; i < 299; i++) game.recordReply(normalUser);
    expect(game.shouldDrop(normalUser)).toBeNull();
    game.recordReply(normalUser);
    expect(game.shouldDrop(normalUser)).toBe("rate-limited");

    const never = new LoopGuard({ selfAddress, maxRepliesPerPeer: 0 });
    expect(never.shouldDrop(normalUser)).toBe("rate-limited");
  });

  it("lets a rate limit be announced once per window for each peer", () => {
    let now = 1_000_000;
    const timed = new LoopGuard({
      selfAddress,
      maxRepliesPerPeer: 1,
      windowMs: 1000,
      now: () => now,
    });
    expect(timed.noticeDue(normalUser)).toBe(true);
    expect(timed.noticeDue(normalUser.toUpperCase().replace("0X", "0x"))).toBe(
      false
    );
    expect(timed.noticeDue(blockedAddress)).toBe(true);
    now += 999;
    expect(timed.noticeDue(normalUser)).toBe(false);
    now += 1;
    expect(timed.noticeDue(normalUser)).toBe(true);
    expect(timed.noticeDue(normalUser)).toBe(false);
  });
});
