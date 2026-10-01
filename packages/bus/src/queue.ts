import { Queue, type ConnectionOptions } from 'bullmq';

export const RUN_QUEUE_NAME = 'neuroflow-runs';

/**
 * BullMQ priority (1 = highest). Interactive workspace runs are served before programmatic
 * API traffic when the queue is backed up.
 */
export function runPriority(source: 'workspace' | 'api' | 'openai'): number {
  return source === 'workspace' ? 1 : 5;
}

/** Code-workspace background tasks share the run queue and worker pool (job name = task kind). */
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

  constructor(connection: ConnectionOptions) {
    this.queue = new Queue<RunJobData>(RUN_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  }

  async enqueue(data: Omit<RunJobData, 'enqueuedAt'>, opts: { priority?: number } = {}): Promise<void> {
    await this.queue.add(
      'run',
      { ...data, enqueuedAt: Date.now() },
      { jobId: data.runId, ...(opts.priority ? { priority: opts.priority } : {}) },
    );
  }

  /** Enqueues a code-workspace task (clone/sync or a user terminal command). */
  async enqueueWorkspaceJob(data: WorkspaceJobData extends infer T ? (T extends { enqueuedAt: number } ? Omit<T, 'enqueuedAt'> : never) : never, jobId: string): Promise<void> {
    await (this.queue as unknown as Queue<WorkspaceJobData>).add(data.kind, { ...data, enqueuedAt: Date.now() } as WorkspaceJobData, { jobId, priority: 1 });
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

  /** Backlog size used for admission control / backpressure. */
  async backlog(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'delayed', 'prioritized');
    return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
  }

  async isActive(runId: string): Promise<boolean> {
    const job = await this.queue.getJob(runId);
    if (!job) return false;
    const state = await job.getState();
    return state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized';
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
