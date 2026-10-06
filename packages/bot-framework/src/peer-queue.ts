/**
 * Serializes async message processing per peer address (actor-like lane queue)
 * so rapid concurrent incoming messages never race state transitions or financial nonces.
 */
export class PeerLaneQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  enqueue<T>(peerAddress: string, task: () => Promise<T>): Promise<T> {
    const key = peerAddress.toLowerCase();
    const previous = this.queues.get(key) ?? Promise.resolve();

    const current = previous.then(task, task);
    this.queues.set(
      key,
      current.then(
        () => {
          if (this.queues.get(key) === current) {
            this.queues.delete(key);
          }
        },
        () => {
          if (this.queues.get(key) === current) {
            this.queues.delete(key);
          }
        }
      )
    );

    return current;
  }
}
