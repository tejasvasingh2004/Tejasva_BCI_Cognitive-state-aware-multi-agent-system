import { describe, expect, it } from 'vitest';
import {
  BciHttpProvider,
  capStrategy,
  ChainedProvider,
  derivePolicy,
  normalizeWorkload,
  StoredStateProvider,
} from '../src';

const subject = { workspaceId: 'w', userId: 'u' };
const now = () => new Date().toISOString();

describe('cognitive policy', () => {
  it('maps workload to bounded preferences', () => {
    const high = derivePolicy({ workload: 'high', confidence: 0.9, source: 'bci', observedAt: now() });
    expect(high).toMatchObject({ responseDensity: 'low', taskChunking: 'high', maxAutoStrategy: 'single_agent' });
    const low = derivePolicy({ workload: 'low', confidence: 0.9, source: 'bci', observedAt: now() });
    expect(low.responseDensity).toBe('high');
    // Policy has no knobs for permissions/approvals by construction.
    expect(Object.keys(high)).not.toContain('permissions');
  });

  it('softens low-confidence extremes', () => {
    expect(derivePolicy({ workload: 'high', confidence: 0.2, source: 'bci', observedAt: now() }).workload).toBe('medium');
  });

  it('caps automatically selected strategies', () => {
    expect(capStrategy('supervisor', 'single_agent')).toBe('single_agent');
    expect(capStrategy('direct', 'single_agent')).toBe('direct');
  });

  it('normalises legacy workload labels', () => {
    expect(normalizeWorkload('OVERLOADED')).toBe('high');
    expect(normalizeWorkload('NORMAL')).toBe('low');
    expect(normalizeWorkload('bogus')).toBeNull();
  });
});

describe('providers', () => {
  it('reads the BCI service response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ workload: 'HIGH', confidence: 0.81, processing_time_ms: 12 }), {
        status: 200,
      })) as typeof fetch;
    const state = await new BciHttpProvider('http://bci', { fetchImpl }).getState(subject);
    expect(state).toMatchObject({ workload: 'high', confidence: 0.81, source: 'bci' });
  });

  it('falls back through the chain and ignores stale automatic samples', async () => {
    const failing = new BciHttpProvider('http://bci', {
      fetchImpl: (async () => new Response('down', { status: 503 })) as typeof fetch,
    });
    const stale = new StoredStateProvider({
      get: async () => ({ workload: 'high', confidence: 1, source: 'bci', observedAt: new Date(0).toISOString() }),
    });
    const manual = new StoredStateProvider({
      get: async () => ({ workload: 'medium', confidence: 1, source: 'manual', observedAt: new Date(0).toISOString() }),
    });
    expect(await stale.getState(subject)).toBeNull();
    expect(await new ChainedProvider([failing, manual]).getState(subject)).toMatchObject({ workload: 'medium' });
    await expect(new ChainedProvider([failing]).getState(subject)).rejects.toThrow('503');
  });
});
