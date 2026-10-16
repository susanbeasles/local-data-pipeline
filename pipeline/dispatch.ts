type Entry<T, R> = {
  value: T;
  resolve: (result: R) => void;
  reject: (error: unknown) => void;
};
/** One bounded shared wait queue; available worker slots are assigned immediately. */
export class Dispatch<T, R> {
  private waiting: Entry<T, R>[] = [];
  private active: number[];
  private workers: ((value: T) => Promise<R>)[];
  private capacity: number;
  private limit: number;
  constructor(
    workers: ((value: T) => Promise<R>)[],
    capacity: number,
    limit: number,
  ) {
    this.workers = workers;
    this.capacity = capacity;
    this.limit = limit;
    if (
      !workers.length ||
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      !Number.isInteger(limit) ||
      limit < 1
    )
      throw Error("invalid dispatch bounds");
    this.active = workers.map(() => 0);
  }
  get queued() {
    return this.waiting.length;
  }
  submit(value: T): Promise<R> {
    if (this.waiting.length >= this.limit)
      return Promise.reject(Error("scheduler queue capacity exceeded"));
    return new Promise((resolve, reject) => {
      this.waiting.push({ value, resolve, reject });
      this.drain();
    });
  }
  private drain() {
    while (this.waiting.length) {
      let index = -1;
      for (let i = 0; i < this.active.length; i++)
        if (
          this.active[i] < this.capacity &&
          (index < 0 || this.active[i] < this.active[index])
        )
          index = i;
      if (index < 0) return;
      const entry = this.waiting.shift()!;
      this.active[index]++;
      Promise.resolve()
        .then(() => this.workers[index](entry.value))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active[index]--;
          this.drain();
        });
    }
  }
}
