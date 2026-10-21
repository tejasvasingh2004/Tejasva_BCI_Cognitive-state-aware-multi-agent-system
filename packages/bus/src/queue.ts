import { Queue, type ConnectionOptions } from 'bullmq';

export const RUN_QUEUE_NAME = 'neuroflow-runs';
/** Repository sync/clone and user terminal commands (short, interactive). */
export const WORKSPACE_QUEUE_NAME = 'neuroflow-workspace';
/** Model Lab evaluations (long, batch, lowest urgency). */
export const EVAL_QUEUE_NAME = 'neuroflow-evals';

export type QueueKind = 'runs' | 'workspace' | 'evals';
export const QUEUE_NAMES: Record<QueueKind, string> = { runs: RUN_QUEUE_NAME, workspace: WORKSPACE_QUEUE_NAME, evals: EVAL_QUEUE_NAME };

/**
 * BullMQ priority (1 = highest). The tenant's plan sets the base; interactive workspace runs are
 * served before programmatic API traffic of the same plan when the queue is backed up.
 */
export function runPriority(source: 'workspace' | 'api' | 'openai', planPriority = 1): number {
  return planPriority * 10 + (source === 'workspace' ? 0 : 5);
}

/**
 * Bulkheads: runs, workspace tasks and evaluations live in separate queues so each has its own
 * workers and concurrency, and a slow batch job can never delay an interactive one.
 */
export type WorkspaceJobData =
  | { kind: 'workspace.sync'; codeWorkspaceId: string; workspaceId: string; enqueuedAt: number }
  | { kind: 'model.evaluate'; evaluationId: string; workspaceId: string; enqueuedAt: number }
  | {
      kind: 'workspace.command';
      codeWorkspaceId: string;
      workspaceId: string;
      userId: string;
      executionId: string;
      command: string;
      commandKind: 'command' | 'test' | 'lint' | 'build' | 'install';
      network: 'none' | 'bridge';
      enqueuedAt: number;
    };

export type RunJobData = {
  runId: string;
  workspaceId: string;
  enqueuedAt: number;
  /** W3C trace context propagated from the API request. */
  trace?: Record<string, string>;
};

/**
 * Durable run queue. The job id is the run id, so enqueueing is idempotent and a run can never be
 * executed by two jobs. Worker crashes are recovered by BullMQ stalled-job detection; the
 * orchestrator treats a recovered job as a new attempt of the same run.
 */
export class RunQueue {
  readonly queue: Queue<RunJobData>;
  readonly workspaceQueue: Queue<WorkspaceJobData>;
  readonly evalQueue: Queue<WorkspaceJobData>;

  constructor(connection: ConnectionOptions) {
    const defaultJobOptions = {
      attempts: 2,
      backoff: { type: 'exponential' as const, delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600 },
    };
    this.queue = new Queue<RunJobData>(RUN_QUEUE_NAME, { connection, defaultJobOptions });
    this.workspaceQueue = new Queue<WorkspaceJobData>(WORKSPACE_QUEUE_NAME, { connection, defaultJobOptions });
    // An evaluation is not retried automatically (it would re-spend model tokens).
    this.evalQueue = new Queue<WorkspaceJobData>(EVAL_QUEUE_NAME, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } });
  }

  async enqueue(data: Omit<RunJobData, 'enqueuedAt'>, opts: { priority?: number } = {}): Promise<void> {
    await this.queue.add(
      'run',
      { ...data, enqueuedAt: Date.now() },
      { jobId: data.runId, ...(opts.priority ? { priority: opts.priority } : {}) },
    );
  }

  /** Enqueues a code-workspace task (clone/sync, terminal command) or a Model Lab evaluation. */
  async enqueueWorkspaceJob(data: WorkspaceJobData extends infer T ? (T extends { enqueuedAt: number } ? Omit<T, 'enqueuedAt'> : never) : never, jobId: string): Promise<void> {
    const queue = data.kind === 'model.evaluate' ? this.evalQueue : this.workspaceQueue;
    // A user's own terminal command is more urgent than a background sync.
    const priority = data.kind === 'workspace.command' ? 1 : 5;
    await queue.add(data.kind, { ...data, enqueuedAt: Date.now() } as WorkspaceJobData, { jobId, priority });
  }

  /** Removes a job that has not started yet. Returns true if it was removed. */
  async removeIfWaiting(runId: string): Promise<boolean> {
    const job = await this.queue.getJob(runId);
    if (!job) return false;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove();
      return true;
    }
    return false;
  }

  /** Run backlog used for admission control / backpressure. */
  async backlog(): Promise<number> {
    return waitingCount(this.queue);
  }

  /**
   * Age of the oldest job still waiting to start (not delayed on purpose), per queue — a stuck or
   * starved queue shows up here before users notice.
   */
  async oldestWaitingAgeMs(now = Date.now()): Promise<Record<QueueKind, number | null>> {
    const entries = await Promise.all(
      (
        [
          ['runs', this.queue],
          ['workspace', this.workspaceQueue],
          ['evals', this.evalQueue],
        ] as const
      ).map(async ([kind, q]) => {
        const [waiting, prioritized] = await Promise.all([q.getJobs(['waiting'], 0, 0, true), q.getJobs(['prioritized'], 0, 0, true)]);
        const oldest = Math.min(...[...waiting, ...prioritized].map((j) => j?.timestamp ?? Infinity));
        return [kind, Number.isFinite(oldest) ? Math.max(0, now - oldest) : null] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<QueueKind, number | null>;
  }

  /** Waiting and active jobs per queue (capacity planning, autoscaling signals). */
  async stats(): Promise<Record<QueueKind, { waiting: number; active: number }>> {
    const entries = await Promise.all(
      (
        [
          ['runs', this.queue],
          ['workspace', this.workspaceQueue],
          ['evals', this.evalQueue],
        ] as const
      ).map(async ([kind, q]) => [kind, { waiting: await waitingCount(q), active: (await q.getJobCounts('active')).active ?? 0 }] as const),
    );
    return Object.fromEntries(entries) as Record<QueueKind, { waiting: number; active: number }>;
  }

  async isActive(runId: string): Promise<boolean> {
    const job = await this.queue.getJob(runId);
    if (!job) return false;
    const state = await job.getState();
    return state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized';
  }

  async close(): Promise<void> {
    await Promise.all([this.queue.close(), this.workspaceQueue.close(), this.evalQueue.close()]);
  }
}

async function waitingCount(q: Queue): Promise<number> {
  const counts = await q.getJobCounts('waiting', 'delayed', 'prioritized');
  return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
}
