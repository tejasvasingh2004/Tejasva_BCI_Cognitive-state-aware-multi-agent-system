import type { CognitiveState, WorkloadLevel } from '@neuroflow/contracts';

export type CognitiveSubject = { workspaceId: string; userId: string };

/** Pluggable source of cognitive state (BCI, interaction signals, manual self-report…). */
export interface CognitiveStateProvider {
  readonly id: string;
  getState(subject: CognitiveSubject, signal?: AbortSignal): Promise<CognitiveState | null>;
}

export type CognitiveStateStore = {
  get(subject: CognitiveSubject): Promise<CognitiveState | null>;
};

/** State reported by the user (or last persisted sample) from the cognitive session store. */
export class StoredStateProvider implements CognitiveStateProvider {
  readonly id = 'stored';
  constructor(
    private readonly store: CognitiveStateStore,
    private readonly maxAgeMs = 30 * 60_000,
  ) {}

  async getState(subject: CognitiveSubject): Promise<CognitiveState | null> {
    const state = await this.store.get(subject);
    if (!state) return null;
    // Stale automatic samples are ignored; manual self-reports stay valid until changed.
    if (state.source !== 'manual' && Date.now() - Date.parse(state.observedAt) > this.maxAgeMs) return null;
    return state;
  }
}

/**
 * Adapter for the NeuroFlow EEG workload classifier service (Python, `backend/`), which exposes
 * `POST /predict-workload`. Without a live headset the service can replay STEW recordings
 * (`simulate: true`), which is how it is used in development.
 */
export class BciHttpProvider implements CognitiveStateProvider {
  readonly id = 'bci';
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { simulate?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  async getState(_subject: CognitiveSubject, signal?: AbortSignal): Promise<CognitiveState | null> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 5_000);
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.baseUrl.replace(/\/$/, '')}/predict-workload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ simulate: this.opts.simulate ?? true }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`BCI service responded ${res.status}`);
    const body = (await res.json()) as { workload?: string; confidence?: number };
    const workload = normalizeWorkload(body.workload);
    if (!workload) throw new Error('BCI service returned an unknown workload level');
    return {
      workload,
      confidence: clamp01(body.confidence ?? 0.5),
      source: 'bci',
      observedAt: new Date().toISOString(),
    };
  }
}

/** Tries providers in order and returns the first available state. */
export class ChainedProvider implements CognitiveStateProvider {
  readonly id = 'chain';
  constructor(private readonly providers: CognitiveStateProvider[]) {}

  async getState(subject: CognitiveSubject, signal?: AbortSignal): Promise<CognitiveState | null> {
    let lastError: unknown;
    for (const p of this.providers) {
      try {
        const state = await p.getState(subject, signal);
        if (state) return state;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return null;
  }
}

export function normalizeWorkload(value: string | undefined): WorkloadLevel | null {
  switch ((value ?? '').toUpperCase()) {
    case 'LOW':
    case 'NORMAL':
      return 'low';
    case 'MEDIUM':
    case 'MODERATE':
      return 'medium';
    case 'HIGH':
    case 'OVERLOADED':
      return 'high';
    default:
      return null;
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
