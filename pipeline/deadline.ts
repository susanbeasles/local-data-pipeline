/** Cumulative queue and execution budgets; lifecycle pulses never reset time. */
export class Deadline {
  private phase: "queued" | "admitted" = "queued";
  private at: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private remaining: Record<"queued" | "admitted", number>;
  private expire: (phase: string) => void;
  private now: () => number;
  constructor(
    remaining: Record<"queued" | "admitted", number>,
    expire: (phase: string) => void,
    now = () => performance.now(),
  ) {
    this.remaining = { ...remaining };
    this.expire = expire;
    this.now = now;
    this.at = now();
    this.arm();
  }
  private arm() {
    this.timer = setTimeout(() => {
      this.closed = true;
      this.expire(this.phase);
    }, this.remaining[this.phase]);
  }
  transition(phase: "queued" | "admitted") {
    if (this.closed || phase === this.phase) return;
    clearTimeout(this.timer);
    const now = this.now();
    this.remaining[this.phase] -= now - this.at;
    if (this.remaining[this.phase] <= 0) {
      this.closed = true;
      this.expire(this.phase);
      return;
    }
    this.phase = phase;
    this.at = now;
    this.arm();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
