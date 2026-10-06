import { PeerLaneQueue } from "../src/peer-queue";

describe("PeerLaneQueue", () => {
  it("serializes operations for the same peer", async () => {
    const queue = new PeerLaneQueue();
    const peer = "0x1111111111111111111111111111111111111111";
    const order: number[] = [];

    const t1 = queue.enqueue(peer, async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
      return 1;
    });

    const t2 = queue.enqueue(peer, async () => {
      order.push(2);
      return 2;
    });

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual([1, 2]);
  });

  it("allows concurrent execution across different peers", async () => {
    const queue = new PeerLaneQueue();
    const peerA = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const peerB = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const finished: string[] = [];

    const pA = queue.enqueue(peerA, async () => {
      await new Promise((r) => setTimeout(r, 40));
      finished.push("A");
    });

    const pB = queue.enqueue(peerB, async () => {
      await new Promise((r) => setTimeout(r, 10));
      finished.push("B");
    });

    await Promise.all([pA, pB]);
    // Peer B should finish first because lanes are independent
    expect(finished).toEqual(["B", "A"]);
  });
});
