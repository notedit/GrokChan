/** Unbounded single-consumer async queue: push() from callbacks, `for await` from the consumer. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private err: unknown = undefined;
  private failed = false;

  push(v: T): void {
    if (this.done) return;
    this.items.push(v);
    this.wake();
  }
  close(): void {
    this.done = true;
    this.wake();
  }
  fail(e: unknown): void {
    if (this.done) return;
    this.failed = true;
    this.err = e;
    this.done = true;
    this.wake();
  }
  /** Drop everything queued and end the stream (consumer sees a clean end). */
  discard(): void {
    this.items.length = 0;
    this.done = true;
    this.failed = false;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        for (;;) {
          if (this.items.length) return { value: this.items.shift()!, done: false };
          if (this.done) {
            if (this.failed) {
              this.failed = false;
              throw this.err;
            }
            return { value: undefined, done: true };
          }
          await new Promise<void>((r) => (this.waiter = r));
        }
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.discard();
        return { value: undefined, done: true };
      },
    };
  }
}
