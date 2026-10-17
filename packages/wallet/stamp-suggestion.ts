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

export interface StampHistoryPaymentEntry {
  valueWei?: bigint | string | number;
  receivedValueWei?: bigint | string | number;
  status?: "pending" | "received" | "not-received" | "failed";
}

export interface StampHistoryMessage {
  outbound: boolean;
  stampValueWei?: bigint;
  verifiedStampValueWei?: bigint | string | number;
  stampPaymentStatus?:
    | "none"
    | "pending"
    | "received"
    | "not-received"
    | "failed";
  stampPayments?: ReadonlyArray<StampHistoryPaymentEntry>;
  outpoints?: Array<{ value?: number | string | bigint }>;
  status?: string;
}

function parseNonNegativeWei(value: bigint | string | number | undefined): bigint {
  if (value === undefined) return 0n;
  try {
    const parsed = typeof value === "bigint" ? value : BigInt(value);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
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
 * Extracts only the verified on-chain received stamp value for an inbound message (#1249).
 * Unverified, pending, failed, or shortfall promised stamp values do not count toward
 * the upward suggestion cap (`netReceivedWei` / `lastReceivedWei`).
 */
export function getVerifiedReceivedMessageStampWei(
  msg: StampHistoryMessage
): bigint {
  if (msg.verifiedStampValueWei !== undefined) {
    return parseNonNegativeWei(msg.verifiedStampValueWei);
  }
  if (
    Array.isArray(msg.stampPayments) &&
    msg.stampPayments.some(
      (p) => p?.status !== undefined || p?.receivedValueWei !== undefined
    )
  ) {
    let verifiedSum = 0n;
    for (const p of msg.stampPayments) {
      if (!p) continue;
      if (p.status === "received") {
        verifiedSum += parseNonNegativeWei(p.receivedValueWei ?? p.valueWei);
      } else if (p.status === undefined && p.receivedValueWei !== undefined) {
        verifiedSum += parseNonNegativeWei(p.receivedValueWei);
      }
    }
    return verifiedSum;
  }
  if (
    msg.stampPaymentStatus !== undefined &&
    msg.stampPaymentStatus !== "received"
  ) {
    return 0n;
  }
  return getMessageStampWei(msg);
}

/**
 * Derives stamp metrics (last sent, last received, net balance) for a conversation.
 */
export function derivePeerStampMetrics(
  messages: ReadonlyArray<StampHistoryMessage>
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
    const stamp = msg.outbound
      ? getMessageStampWei(msg)
      : getVerifiedReceivedMessageStampWei(msg);
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

export interface PeerStampSuggestionResult extends PeerStampMetrics {
  /** Converged geometric stamp suggestion in base units (wei). */
  suggestedStampWei: bigint;
  /**
   * True when the converged suggestion exceeds the user's previous stamp to this peer
   * (or the default stamp if nothing was sent yet), so the UI can visibly mark an upward adjustment (#820).
   */
  isSuggestedIncrease: boolean;
}

/**
 * Pure helper shared by the app and headless bot clients (#820) that derives peer metrics
 * from conversation history and computes the converged geometric stamp suggestion.
 */
export function computePeerStampSuggestion(params: {
  messages: ReadonlyArray<StampHistoryMessage>;
  defaultStampWei: bigint;
  minimumStampWei?: bigint;
}): PeerStampSuggestionResult {
  const metrics = derivePeerStampMetrics(params.messages);
  const suggestedStampWei = computeGeometricStampSuggestion({
    defaultStampWei: params.defaultStampWei,
    minimumStampWei: params.minimumStampWei,
    lastSentWei: metrics.lastSentWei,
    lastReceivedWei: metrics.lastReceivedWei,
    netReceivedWei: metrics.netReceivedWei,
  });
  const previousBaselineWei = metrics.lastSentWei ?? params.defaultStampWei;
  return {
    ...metrics,
    suggestedStampWei,
    isSuggestedIncrease: suggestedStampWei > previousBaselineWei,
  };
}

