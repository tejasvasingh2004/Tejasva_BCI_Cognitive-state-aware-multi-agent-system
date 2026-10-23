import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunEvent, WorkloadLevel } from '@neuroflow/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { followRun } from '@/lib/run-stream';
import { reduceRunEvents, type RunView } from '@/lib/run-view';

export const keys = {
  me: ['me'] as const,
  models: ['models'] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  run: (id: string) => ['run', id] as const,
  runEvents: (id: string) => ['run-events', id] as const,
  memories: ['memories'] as const,
  cognitive: ['cognitive'] as const,
  agents: ['agents'] as const,
  settings: ['settings'] as const,
  apiKeys: ['api-keys'] as const,
  providerKeys: ['provider-keys'] as const,
  budget: ['budget'] as const,
  webhooks: ['webhooks'] as const,
  webhookDeliveries: ['webhook-deliveries'] as const,
  audit: ['audit'] as const,
};

/** Raised when the workspace needs an interactive sign-in (production auth mode). */
export class LoginRequiredError extends Error {
  constructor() {
    super('Sign in required');
  }
}

/** Session bootstrap: dev mode signs in automatically; production shows the sign-in screen. */
export function useSession() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
          const { authMode } = await api.authConfig();
          if (authMode !== 'dev') throw new LoginRequiredError();
          await api.devLogin().catch(() => {
            throw err;
          });
          return api.me();
        }
        throw err;
      }
    },
    staleTime: Infinity,
    retry: (count, err) => !(err instanceof LoginRequiredError) && count < 1,
  });
}

export const useTools = () => useQuery({ queryKey: ['tools'], queryFn: () => api.tools().then((r) => r.tools), staleTime: 60_000 });
export const useAgents = () => useQuery({ queryKey: keys.agents, queryFn: api.agents, staleTime: 30_000 });
export const useSettings = (enabled = true) => useQuery({ queryKey: keys.settings, queryFn: api.settings, enabled });
export const useApiKeys = (enabled = true) => useQuery({ queryKey: keys.apiKeys, queryFn: () => api.apiKeys().then((r) => r.apiKeys), enabled });
export const useAudit = (enabled = true) =>
  useQuery({ queryKey: keys.audit, queryFn: () => api.audit().then((r) => r.events), enabled, retry: false });

export const useModels = () => useQuery({ queryKey: keys.models, queryFn: api.models, staleTime: 30_000, refetchInterval: 60_000 });
export const useConversations = () => useQuery({ queryKey: keys.conversations, queryFn: () => api.conversations().then((r) => r.conversations) });
export const useConversation = (id: string | null) =>
  useQuery({ queryKey: keys.conversation(id ?? ''), queryFn: () => api.conversation(id!), enabled: Boolean(id) });
export const useRunDetails = (id: string | null) =>
  useQuery({
    queryKey: keys.run(id ?? ''),
    queryFn: () => api.run(id!),
    enabled: Boolean(id),
    // Live runs keep accumulating execution records.
    refetchInterval: (q) => (q.state.data && ['queued', 'running'].includes(q.state.data.run.status) ? 1500 : false),
  });
export const useMemories = (enabled = true) =>
  useQuery({ queryKey: keys.memories, queryFn: () => api.memories().then((r) => r.memories), enabled });
export const useCognitive = (enabled: boolean) =>
  useQuery({ queryKey: keys.cognitive, queryFn: api.cognitive, enabled, refetchInterval: enabled ? 30_000 : false });

/**
 * Live run state. Events are server state: they are kept in the query cache (so remounts and
 * other components share them) and folded into a RunView by a pure reducer.
 */
export function useRunView(runId: string | null, live: boolean): { view: RunView | null; connection: string } {
  const qc = useQueryClient();
  const [connection, setConnection] = useState('closed');
  const { data: events } = useQuery<RunEvent[]>({
    queryKey: keys.runEvents(runId ?? ''),
    queryFn: () => [],
    enabled: false,
    initialData: [],
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!runId) return;
    const existing = qc.getQueryData<RunEvent[]>(keys.runEvents(runId)) ?? [];
    const last = existing.at(-1);
    if (last && ['run.completed', 'run.failed', 'run.cancelled'].includes(last.type)) return;
    if (!live && existing.length > 0) return;
    return followRun(runId, {
      afterSeq: last?.seq ?? 0,
      onStateChange: setConnection,
      onEvent: (event) => {
        qc.setQueryData<RunEvent[]>(keys.runEvents(runId), (prev = []) => (prev.at(-1)?.seq ?? 0) >= event.seq ? prev : [...prev, event]);
        if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
          void qc.invalidateQueries({ queryKey: keys.run(runId) });
          void qc.invalidateQueries({ queryKey: keys.conversations });
          setTimeout(() => void qc.invalidateQueries({ queryKey: ['conversation'] }), 50);
        }
      },
    });
  }, [runId, live, qc]);

  const view = useMemo(() => (runId && events.length ? reduceRunEvents(events) : null), [runId, events]);
  return { view, connection };
}

export function useCancelRun() {
  return useMutation({ mutationFn: (runId: string) => api.cancelRun(runId) });
}

export function useApprove() {
  return useMutation({
    mutationFn: (v: { runId: string; toolCallId: string; approved: boolean }) => api.approve(v.runId, v.toolCallId, v.approved),
  });
}

export function useSetWorkload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (w: WorkloadLevel) => api.setWorkload(w),
    onSuccess: (data) => qc.setQueryData(keys.cognitive, data),
  });
}

export function useSampleBci() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.sampleBci, onSuccess: (data) => qc.setQueryData(keys.cognitive, data) });
}
