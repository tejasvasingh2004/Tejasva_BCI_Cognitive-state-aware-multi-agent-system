import { DelayedError, Worker, type Job } from 'bullmq';
import { PLAN_LIMITS, type Plan } from '@neuroflow/contracts';
import { QUEUE_NAMES, RedisRateLimiter, type QueueKind, type Redis, type RunJobData, type WorkspaceJobData } from '@neuroflow/bus';
import { workspaceRepo, type Pool } from '@neuroflow/db';
import type { Logger } from '@neuroflow/observability';
import { processRun, WorkerShutdownError } from './processor';
import type { WorkerRuntime } from './runtime';
import { processWorkspaceJob } from './workspace-jobs';

export type QueueWorkersOptions = {
  pool: Pool;
  /** Commands / pub-sub connection. */
  redis: Redis;
  /** Creates a dedicated BullMQ connection (each Worker blocks on its own). */
  connection: () => Redis;
  runtime: WorkerRuntime;
  logger: Logger;
  shutdownSignal: AbortSignal;
  /** Which queues this process serves (scale each tier independently). */
  queues?: QueueKind[];
  concurrency?: Partial<Record<QueueKind, number>>;
  /** Overrides the plan's per-workspace running cap (tests/operators). */
  maxRunningPerWorkspace?: number;
};

/** Lease of a running job's fairness slot; renewed while the job runs. */
const RUNNING_SLOT_TTL_MS = 2 * 60_000;
const PLAN_CACHE_TTL_MS = 30_000;

/**
 * Starts one BullMQ worker per queue (bulkheads). Runs pass a per-tenant fairness gate: a
 * workspace never executes more runs at once than its plan allows across the whole worker pool,
 * so one tenant's burst cannot occupy every worker; excess jobs are delayed briefly and picked up
 * as soon as the tenant's slot frees (other tenants' jobs run in the meantime).
 */
export function startQueueWorkers(opts: QueueWorkersOptions) {
  const queues = opts.queues ?? ['runs', 'workspace', 'evals'];
  const limiter = new RedisRateLimiter(opts.redis);
  const planCache = new Map<string, { plan: Plan; at: number }>();
  const planOf = async (workspaceId: string): Promise<Plan> => {
    const hit = planCache.get(workspaceId);
    if (hit && Date.now() - hit.at < PLAN_CACHE_TTL_MS) return hit.plan;
    const plan = (await workspaceRepo.getPlan(opts.pool, workspaceId)) ?? 'free';
    planCache.set(workspaceId, { plan, at: Date.now() });
    return plan;
  };

  const runWorkspaceJob = (job: Job) =>
    processWorkspaceJob(job.data as WorkspaceJobData, { runtime: opts.runtime, redis: opts.redis, logger: opts.logger, signal: opts.shutdownSignal, pool: opts.pool });

  const runRun = async (job: Job, token?: string) => {
    // Jobs enqueued before the queue split carried workspace tasks on the run queue.
    if (job.name !== 'run') return runWorkspaceJob(job);
    const data = job.data as RunJobData;
    const cap = opts.maxRunningPerWorkspace ?? PLAN_LIMITS[await planOf(data.workspaceId)].runningPerWorkspace;
    const release = await limiter.tryAcquireSlot(`running:${data.workspaceId}`, cap, RUNNING_SLOT_TTL_MS, { heartbeat: true });
    if (!release) {
      // Fair share: retry shortly without consuming an attempt; other tenants' jobs proceed.
      await job.moveToDelayed(Date.now() + 1_000 + Math.floor(Math.random() * 1_000), token);
      throw new DelayedError();
    }
    try {
      return await processRun(data, { pool: opts.pool, redis: opts.redis, runtime: opts.runtime, logger: opts.logger, shutdownSignal: opts.shutdownSignal });
    } finally {
      await release().catch(() => {});
    }
  };

  const processors: Record<QueueKind, (job: Job, token?: string) => Promise<unknown>> = {
    runs: runRun,
    workspace: runWorkspaceJob,
    evals: runWorkspaceJob,
  };
  const defaults: Record<QueueKind, number> = { runs: 4, workspace: 4, evals: 1 };

  const workers = queues.map((kind) => {
    const worker = new Worker(QUEUE_NAMES[kind], processors[kind], {
      connection: opts.connection(),
      concurrency: opts.concurrency?.[kind] ?? defaults[kind],
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    });
    worker.on('failed', (job, err) => {
      if (err instanceof WorkerShutdownError || err instanceof DelayedError) return;
      opts.logger.error({ queue: kind, jobId: job?.id, err }, 'job failed (infrastructure error)');
    });
    worker.on('error', (err) => opts.logger.error({ queue: kind, err }, 'worker error'));
    return worker;
  });

  return {
    workers,
    queues,
    async close(force = false) {
      await Promise.all(workers.map((w) => w.close(force)));
    },
  };
}
