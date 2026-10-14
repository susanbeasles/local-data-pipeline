# Memory failure and recovery

The interrupted production run reached 32,475,209,776 bytes of aggregate physical footprint against a 32,000,000,000-byte limit. Its supervisor terminated the workload. The previous report did not attribute footprint to individual processes; the historical cause cannot be established from that report alone. Progress showing 64 active requests was not evidence of completed work.

The worker now reserves padded KV capacity for each complete sequence, including its configured maximum output and initialized role prefix. Admission considers the longest reserved sequence across the active batch. Requests wait in a bounded FIFO rather than exceeding the estimated KV budget. The 64-slot ceiling, complete input, role behavior and output limits remain intact. Allocator/scratch headroom is reserved; this estimate does not replace the aggregate OS memory guard. A sequence that cannot fit by itself returns an explicit error without truncation.

Queue time and active inference time have separate cumulative deadlines. `mlx.timeoutMs` limits active inference; optional `mlx.queueTimeoutMs` limits queue time. The queue default is `timeoutMs * batchSize`, capped at 2,147,483,647 ms. Lifecycle frames never reset accumulated time. Fatal transport/deadline failures retain existing retry/recovery behavior. Resource reports now attribute sampled footprint to supervisor, application and workers.

## Synthetic verification

On the installed local Qwen/MLX runtime, with identical 64 dense synthetic tag requests, one resident model, 64 slots and prefill size 4:

| Configuration | Valid completed requests | Seconds including model load | Aggregate peak GB | Dynamic prompt tokens | Generated tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before admission | 64/64 | 428.025 | 21.006 | 320,448 | 576 |
| With admission | 64/64 | 426.402 | 21.024 | 320,448 | 576 |

The final queue/admission protocol also passed a fresh four-request real-model smoke test (4/4 valid, 37.671 seconds). Thirty-one targeted regression tests and three installed-engine/OS sandbox tests passed; TypeScript checking passed.

Both runs actually executed 64-row token forwards. Fixed role initialization prefills were 1,925 tokens in each run. The fixture fit all 64 slots, so these measurements establish no regression on that fixture, not a demonstrated reduction in peak memory or proof of production stability. Pure admission tests cover padded long-sequence deferral and complete FIFO draining. These are tag requests, not fully enriched files or a six-stage throughput benchmark. No production content was used and production was not restarted.

Reproduce with local bindings in an ignored config:

```sh
PIPELINE_CONFIG=/path/to/local.json node pipeline/tests/load.ts --dense --timeout=900000
```

Reports remain under the generated `state/load-*/work/` directory. Use `--count=4` for a smaller protocol smoke test. Defaults remain 64 requests. Offline runtime and model setup are described in operator.md.

Existing instances remain pinned to their captured release. Updating a checkout does not upgrade or restart an instance. Prepare a new release explicitly before resuming with these changes; do not modify an existing snapshot in place. Preserve checkpoints and investigate any failed jobs before declaring the run complete.
