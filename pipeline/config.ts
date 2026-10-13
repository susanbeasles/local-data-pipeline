import type { Config } from "./run.ts";
import { bounds, type Model } from "./mlx.ts";
export type Settings = {
  workers: number;
  batchSize: number;
  prefillSize?: number;
  memoryBytes: number;
  budgetBytes: number;
  concurrency: number;
};
export type Pipeline = Config & { mlx: Model };
export type Options = Config & {
  mlx: Omit<
    Model,
    "workers" | "batchSize" | "prefillSize" | "memoryBytes" | "budgetBytes"
  > &
    Partial<
      Pick<
        Model,
        "workers" | "batchSize" | "prefillSize" | "memoryBytes" | "budgetBytes"
      >
    >;
};
export function configure(config: Options, selected: Settings): Pipeline {
  const batchSize = config.mlx.batchSize ?? selected.batchSize;
  const result: Pipeline = {
    ...config,
    mlx: {
      ...config.mlx,
      workers: config.mlx.workers ?? selected.workers,
      batchSize,
      prefillSize:
        config.mlx.prefillSize ??
        Math.min(selected.prefillSize ?? batchSize, batchSize),
      memoryBytes: config.mlx.memoryBytes ?? selected.memoryBytes,
      budgetBytes: config.mlx.budgetBytes ?? selected.budgetBytes,
    },
  };
  const { capacity } = bounds(result.mlx);
  if (
    !Number.isInteger(result.concurrency) ||
    result.concurrency < 1 ||
    result.concurrency > capacity
  )
    throw Error("concurrency exceeds resident worker capacity");
  return result;
}
