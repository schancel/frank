import {
  fetchOracleFeed,
  ORACLE_REFRESH_INTERVAL_MS,
} from "@frank/price-feeds";
import {
  computeOracleRates,
  unavailableOracleRates,
  type OracleRates,
} from "./price-oracle";

/** Headless host observation owner. Only the installed real relay is read; no price fallback. */
export function createRelayStampRateReader(options: {
  relayBaseUrl: string;
  now?: () => number;
  fetchFeed?: typeof fetchOracleFeed;
}): () => Promise<OracleRates> {
  let rates = unavailableOracleRates();
  let askedAt: number | undefined;
  let inFlight: Promise<OracleRates> | undefined;
  const now = options.now ?? Date.now;
  return () => {
    if (inFlight) return inFlight;
    const at = now();
    if (askedAt !== undefined && at - askedAt < ORACLE_REFRESH_INTERVAL_MS)
      return Promise.resolve(rates);
    askedAt = at;
    inFlight = (options.fetchFeed ?? fetchOracleFeed)(options.relayBaseUrl, {
      latest: true,
    })
      .then((answer) => {
        if (answer.status === "ok")
          rates = computeOracleRates(answer.feed, Math.floor(at / 1000));
        return rates;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
