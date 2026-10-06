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

  constructor(options: LoopGuardOptions) {
    this.selfAddress = options.selfAddress.toLowerCase();
    this.denylist = new Set(
      (options.denylist ?? []).map((a) => a.toLowerCase())
    );
    this.maxRepliesPerPeer = options.maxRepliesPerPeer ?? 20;
    this.windowMs = options.windowMs ?? 60 * 60 * 1000; // 1 hour
    this.now = options.now ?? (() => Date.now());
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
