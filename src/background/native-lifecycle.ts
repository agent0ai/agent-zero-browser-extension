import { NativeRequestError, type NativeConnectionSnapshot } from "./native-port";

export type NativeStateGuard = () => void;

class SupersededNativeState extends Error {}

/** Worker-local ordering only: this queue never grants browser authority. */
export class NativeLifecycleQueue {
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly currentConnection: () => NativeConnectionSnapshot) {}

  observe(
    connection: NativeConnectionSnapshot,
    initialize: (guard: NativeStateGuard) => Promise<void>,
    failed: () => void,
  ): void {
    // These notifications synchronously invalidate work from the previous port.
    // Connecting/negotiating/ready for one port otherwise share initialization.
    if (["connecting", "disconnected", "blocked"].includes(connection.state)) this.epoch += 1;
    const epoch = this.epoch;
    const guard = () => {
      if (this.epoch !== epoch) throw new SupersededNativeState();
    };
    const task = this.tail.then(async () => {
      guard();
      await initialize(guard);
      guard();
    });
    this.tail = task.catch((error) => {
      if (!(error instanceof SupersededNativeState) && this.epoch === epoch) failed();
    });
  }

  reconcile<T>(run: (guard: NativeStateGuard, connection: NativeConnectionSnapshot) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const connection = this.currentConnection();
    const guard = () => {
      const current = this.currentConnection();
      if (epoch !== this.epoch || connection.state !== "ready" || !connection.connectionId
        || current.state !== "ready" || current.connectionId !== connection.connectionId) {
        throw new NativeRequestError("The native connection changed during reconciliation.", "INVALID_STATE");
      }
    };
    // This is also the single initialization barrier: the ready-state callback
    // was enqueued synchronously before native requests could be dispatched.
    const task = this.tail.then(async () => {
      guard();
      const result = await run(guard, connection);
      guard();
      return result;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}
