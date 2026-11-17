/**
 * The shared rate-limit cooldown of relay RPC routes in this process: once the relay reports that
 * the provider behind a route throttled it (`rpc_upstream_rate_limited`), every read of that
 * route waits instead of each read retrying on its own. Written by the relay RPC connection in
 * `evm-provider.ts`; read by it and by callers that poll through a wallet, such as a bot waiting
 * for payment proof. A module of its own so such callers need not load the provider.
 */

/** The longest a throttled relay route is left alone by every read in this process. */
export const RELAY_UPSTREAM_COOLDOWN_MAX_MS = 60_000;
// Per relay route (one canonical chain's RPC on one relay): until when its upstream provider
// asked to be left alone. Shared by every connection to the route, so one 429 slows every read
// of that chain instead of each read retrying on its own.
const relayUpstreamCooldownUntil = new Map<string, number>();

/** How long reads of `route` still wait for its upstream's rate limit (0: none). */
export function relayUpstreamCooldownRemainingMs(route: string, now = Date.now()): number {
  const until = relayUpstreamCooldownUntil.get(route);
  if (until === undefined) return 0;
  if (now >= until) {
    relayUpstreamCooldownUntil.delete(route);
    return 0;
  }
  return until - now;
}

/** The longest any relay route in this process still waits for its upstream's rate limit (0:
 * none). For a caller that holds no route of its own and was just answered "rate limited" by a
 * read, such as a bot polling for payment proof: it waits this out instead of asking again. */
export function relayUpstreamCooldownLongestRemainingMs(now = Date.now()): number {
  let longest = 0;
  for (const route of [...relayUpstreamCooldownUntil.keys()])
    longest = Math.max(longest, relayUpstreamCooldownRemainingMs(route, now));
  return longest;
}

/** Records the relay's `rpc_upstream_rate_limited` for `route`: its Retry-After when given
 * (capped), else `fallbackMs`. Never shortens a cooldown already running. */
export function noteRelayUpstreamRateLimited(
  route: string,
  response: { readonly headers: Readonly<Record<string, string>> },
  fallbackMs: number,
  now = Date.now()
): void {
  const retryAfter = Number(response.headers["retry-after"]?.trim() ?? "");
  const waitMs = Math.min(
    RELAY_UPSTREAM_COOLDOWN_MAX_MS,
    Number.isFinite(retryAfter) && retryAfter >= 0 && response.headers["retry-after"]?.trim()
      ? retryAfter * 1000
      : fallbackMs
  );
  const until = now + waitMs;
  if ((relayUpstreamCooldownUntil.get(route) ?? 0) < until)
    relayUpstreamCooldownUntil.set(route, until);
}

/** Test hook: forget every route's cooldown. */
export function resetRelayUpstreamCooldownsForTest(): void {
  relayUpstreamCooldownUntil.clear();
}
