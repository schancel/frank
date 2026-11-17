import {
  noteRelayUpstreamRateLimited,
  relayUpstreamCooldownLongestRemainingMs,
  resetRelayUpstreamCooldownsForTest,
} from "./relay-upstream-cooldown";

describe("relay upstream cooldown", () => {
  afterEach(() => resetRelayUpstreamCooldownsForTest());

  test("the longest remaining wait across routes, and none once every route has cleared", () => {
    expect(relayUpstreamCooldownLongestRemainingMs(1_000)).toBe(0);
    noteRelayUpstreamRateLimited("https://relay/a", { headers: {} }, 4_000, 1_000);
    noteRelayUpstreamRateLimited("https://relay/b", { headers: { "retry-after": "9" } }, 4_000, 1_000);
    expect(relayUpstreamCooldownLongestRemainingMs(2_000)).toBe(8_000);
    expect(relayUpstreamCooldownLongestRemainingMs(10_000)).toBe(0);
  });
});
