// Sends remote-view input one event at a time, in order (concurrent POSTs could arrive out of
// order: an "up" before its "down"). Pointer moves are coalesced to animation frames and rate
// limited; wheel deltas add up per frame; the queue merges what it safely can (enqueueInput).
//
// Events can carry the user's Facebook password: nothing here logs them, and errors are reported
// without the event.
import { enqueueInput } from '@/lib/remote-input';
import type { RemoteInputEvent } from '@/shared/remote-view';

type Post = (event: RemoteInputEvent) => Promise<unknown>;

interface Wheel {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

export class InputSender {
  private queue: RemoteInputEvent[] = [];
  private sending = false;
  private disposed = false;
  private pendingMove: { readonly event: RemoteInputEvent; readonly minIntervalMs: number } | null = null;
  private moveFrame: number | null = null;
  private lastMoveAt = 0;
  private pendingWheel: Wheel | null = null;
  private wheelFrame: number | null = null;

  constructor(
    private readonly post: Post,
    private readonly onError: (error: unknown) => void,
    private readonly onSent: () => void,
  ) {}

  send(event: RemoteInputEvent): void {
    if (this.disposed) return;
    this.queue = enqueueInput(this.queue, event);
    void this.pump();
  }

  sendAll(events: readonly RemoteInputEvent[]): void {
    for (const event of events) this.send(event);
  }

  /** A pointer move, sent at most once per animation frame and per `minIntervalMs`. */
  move(event: RemoteInputEvent, minIntervalMs: number): void {
    this.pendingMove = { event, minIntervalMs };
    this.moveFrame ??= window.requestAnimationFrame(this.flushMove);
  }

  /** Drop a not-yet-sent move (a press or release carries its own position). */
  cancelMove(): void {
    this.pendingMove = null;
  }

  wheel(x: number, y: number, deltaX: number, deltaY: number): void {
    const previous = this.pendingWheel;
    this.pendingWheel = { x, y, deltaX: (previous?.deltaX ?? 0) + deltaX, deltaY: (previous?.deltaY ?? 0) + deltaY };
    this.wheelFrame ??= window.requestAnimationFrame(this.flushWheel);
  }

  /** (Re)activate after mount; React may stop and start the same instance (Strict Mode). */
  start(): void {
    this.disposed = false;
  }

  /** Stop sending: drop everything queued and pending. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.pendingMove = null;
    this.pendingWheel = null;
    if (this.moveFrame !== null) window.cancelAnimationFrame(this.moveFrame);
    if (this.wheelFrame !== null) window.cancelAnimationFrame(this.wheelFrame);
    this.moveFrame = null;
    this.wheelFrame = null;
  }

  private readonly flushMove = (time: number): void => {
    this.moveFrame = null;
    const pending = this.pendingMove;
    if (pending === null) return;
    if (time - this.lastMoveAt < pending.minIntervalMs) {
      this.moveFrame = window.requestAnimationFrame(this.flushMove);
      return;
    }
    this.pendingMove = null;
    this.lastMoveAt = time;
    this.send(pending.event);
  };

  private readonly flushWheel = (): void => {
    this.wheelFrame = null;
    const wheel = this.pendingWheel;
    this.pendingWheel = null;
    if (wheel === null || (wheel.deltaX === 0 && wheel.deltaY === 0)) return;
    this.send({ _tag: 'wheel', ...wheel });
  };

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let next = this.queue.shift(); next !== undefined && !this.disposed; next = this.queue.shift()) {
        try {
          await this.post(next);
          this.onSent();
        } catch (error) {
          // The view is gone or refusing input: drop what's queued rather than replaying it later.
          this.queue = [];
          this.onError(error);
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
