/**
 * Converging per-peer stamp suggestions via geometric mean (Issues #819 & #820).
 *
 * Implements client-side geometric mean convergence between conversational peers:
 *   rawSuggestion = isqrt(mine * theirs)
 *
 * Subject to:
 * - Floor: max(peerAdvertisedMinimum, chainDefaultStampValue)
 * - Upward cap: increases above `mine` are bounded by cumulative net value received
 *   from that peer (preventing draining/griefing attacks). Decreases are uncapped.
 *
 * Zero external framework or Pinia dependencies -- safe for headless bots and browser alike.
 */

/**
 * Computes integer square root using Newton-Raphson: floor(sqrt(n)).
 */
export function isqrt(n: bigint): bigint {
  if (n < 0n) {
    throw new RangeError("Square root of negative number");
  }
  if (n < 2n) {
    return n;
  }
  const bitLength = n.toString(2).length;
  let x0 = 1n << BigInt(Math.ceil(bitLength / 2));
  let x1 = (x0 + n / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
}

export interface StampSuggestionParams {
  /** The last stamp value paid by this user to the peer (in base units / wei). */
  lastSentWei?: bigint;
  /** The last stamp value received by this user from the peer (in base units / wei). */
  lastReceivedWei?: bigint;
  /**
   * Cumulative net stamp value received from this peer:
   * sum(received stamps) - sum(sent stamps).
   * Used to bound automatic upward adjustments so the user cannot be drained.
   */
  netReceivedWei?: bigint;
  /** Default stamp value for the active chain (e.g. 10^16 wei / 0.01 MON). */
  defaultStampWei: bigint;
  /** Minimum acceptable stamp value (peer-advertised minimum or chain minimum). */
  minimumStampWei?: bigint;
}

/**
 * Computes the converged geometric mean stamp suggestion for a given peer.
 */
export function computeGeometricStampSuggestion(
  params: StampSuggestionParams
): bigint {
  const floor =
    params.minimumStampWei !== undefined &&
    params.minimumStampWei > params.defaultStampWei
      ? params.minimumStampWei
      : params.defaultStampWei;

  const mine = params.lastSentWei ?? params.defaultStampWei;
  const theirs = params.lastReceivedWei ?? params.defaultStampWei;

  // Calculate geometric mean: floor(sqrt(mine * theirs))
  const product = mine * theirs;
  const rawSuggestion = isqrt(product);

  let suggested = rawSuggestion;

  // Upward cap: Any increase above `mine` must be covered by positive net received value
  if (rawSuggestion > mine) {
    const net = params.netReceivedWei ?? 0n;
    const allowableIncrease = net > 0n ? net : 0n;
    const ceiling = mine + allowableIncrease;
    if (suggested > ceiling) {
      suggested = ceiling;
    }
  }

  // Floor constraint: cannot drop below the chain minimum or peer advertised minimum
  if (suggested < floor) {
    suggested = floor;
  }

  return suggested;
}

export interface PeerStampMetrics {
  lastSentWei?: bigint;
  lastReceivedWei?: bigint;
  netReceivedWei: bigint;
  sentCount: number;
  receivedCount: number;
}

/**
 * Extracts stamp value in wei (or base unit) from a message object.
 */
export function getMessageStampWei(msg: {
  stampValueWei?: bigint;
  outpoints?: Array<{ value?: number | string | bigint }>;
}): bigint {
  if (msg.stampValueWei !== undefined) {
    return msg.stampValueWei;
  }
  if (Array.isArray(msg.outpoints) && msg.outpoints.length > 0) {
    let sum = 0n;
    for (const utxo of msg.outpoints) {
      if (utxo?.value !== undefined) {
        sum += BigInt(utxo.value);
      }
    }
    return sum;
  }
  return 0n;
}

/**
 * Derives stamp metrics (last sent, last received, net balance) for a conversation.
 */
export function derivePeerStampMetrics(
  messages: Array<{
    outbound: boolean;
    stampValueWei?: bigint;
    outpoints?: Array<{ value?: number | string | bigint }>;
    status?: string;
  }>
): PeerStampMetrics {
  let lastSentWei: bigint | undefined;
  let lastReceivedWei: bigint | undefined;
  let totalReceivedWei = 0n;
  let totalSentWei = 0n;
  let sentCount = 0;
  let receivedCount = 0;

  for (const msg of messages) {
    if (msg.status === "error") {
      continue;
    }
    const stamp = getMessageStampWei(msg);
    if (stamp <= 0n) {
      continue;
    }
    if (msg.outbound) {
      lastSentWei = stamp;
      totalSentWei += stamp;
      sentCount++;
    } else {
      lastReceivedWei = stamp;
      totalReceivedWei += stamp;
      receivedCount++;
    }
  }

  return {
    lastSentWei,
    lastReceivedWei,
    netReceivedWei: totalReceivedWei - totalSentWei,
    sentCount,
    receivedCount,
  };
}
