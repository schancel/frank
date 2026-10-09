/** Replies to one peer per window when neither the operator nor the bot says otherwise. */
export const DEFAULT_MAX_REPLIES_PER_PEER = 20;
/** The budget a game bot declares. One blackjack hand is three to six dealer replies (accept or
 * challenge, deal, a card per hit, reveal), so 20 an hour ends play after about five hands; 300
 * is a hand every minute or so for the whole hour. A runaway exchange with another bot is still
 * cut off, 300 stamps later. */
export const GAME_MAX_REPLIES_PER_PEER = 300;

export interface LoopGuardOptions {
  selfAddress: string;
  denylist?: readonly string[];
  maxRepliesPerPeer?: number;
  windowMs?: number;
  now?: () => number;
}

export type MessageDropReason =
  | "self-echo"
  | "denylisted"
  | "peer-is-bot"
  | "rate-limited";

export class LoopGuard {
  private readonly selfAddress: string;
  private readonly denylist: Set<string>;
  private readonly maxRepliesPerPeer: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly peerReplyTimestamps = new Map<string, number[]>();
  private readonly noticedAt = new Map<string, number>();

  constructor(options: LoopGuardOptions) {
    this.selfAddress = options.selfAddress.toLowerCase();
    this.denylist = new Set(
      (options.denylist ?? []).map((a) => a.toLowerCase())
    );
    this.maxRepliesPerPeer =
      options.maxRepliesPerPeer ?? DEFAULT_MAX_REPLIES_PER_PEER;
    this.windowMs = options.windowMs ?? 60 * 60 * 1000; // 1 hour
    this.now = options.now ?? (() => Date.now());
  }

  /** Replies allowed to one peer per window. */
  get limit(): number {
    return this.maxRepliesPerPeer;
  }

  /** True once per window for each peer: the one time its rate limit may be announced. A second
   * call inside the window is false whatever happened to the first, so a notice can never be
   * what keeps two bots answering each other. */
  noticeDue(peerAddress: string): boolean {
    const peer = peerAddress.toLowerCase();
    const currentTime = this.now();
    const last = this.noticedAt.get(peer);
    if (last !== undefined && currentTime - last < this.windowMs) return false;
    this.noticedAt.set(peer, currentTime);
    return true;
  }

  shouldDrop(
    peerAddress: string,
    peerIsBot?: boolean
  ): MessageDropReason | null {
    const peer = peerAddress.toLowerCase();
    if (peer === this.selfAddress) return "self-echo";
    if (this.denylist.has(peer)) return "denylisted";
    if (peerIsBot) return "peer-is-bot";

    // Rate limiting check
    const currentTime = this.now();
    const history = this.peerReplyTimestamps.get(peer) ?? [];
    const valid = history.filter((ts) => currentTime - ts < this.windowMs);
    if (valid.length >= this.maxRepliesPerPeer) {
      return "rate-limited";
    }

    return null;
  }

  recordReply(peerAddress: string): void {
    const peer = peerAddress.toLowerCase();
    const currentTime = this.now();
    const history = this.peerReplyTimestamps.get(peer) ?? [];
    const valid = history.filter((ts) => currentTime - ts < this.windowMs);
    valid.push(currentTime);
    this.peerReplyTimestamps.set(peer, valid);
  }
}
