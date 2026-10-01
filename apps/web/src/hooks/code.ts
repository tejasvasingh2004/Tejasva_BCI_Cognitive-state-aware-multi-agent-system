import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunEvent } from '@neuroflow/contracts';
import { codeApi, labApi } from '@/lib/code-api';
import { reduceCodeEvents, type CodeRunView } from '@/lib/code-run-view';
import { followWorkspace, type WorkspaceEvent } from '@/lib/workspace-stream';
import { useCode } from '@/stores/code';
import { keys, useRunView } from './queries';

export const codeKeys = {
  githubConfig: ['github-config'] as const,
  connections: ['github-connections'] as const,
  owners: (c: string) => ['github-owners', c] as const,
  repos: (c: string, o: string) => ['github-repos', c, o] as const,
  branches: (c: string, o: string, r: string) => ['github-branches', c, o, r] as const,
  workspaces: ['code-workspaces'] as const,
  workspace: (id: string) => ['code-workspace', id] as const,
  tree: (id: string) => ['code-tree', id] as const,
  git: (id: string) => ['code-git', id] as const,
  diff: (id: string) => ['code-diff', id] as const,
  runs: (id: string) => ['code-runs', id] as const,
  run: (runId: string) => ['code-run', runId] as const,
  executions: (id: string) => ['code-executions', id] as const,
  file: (id: string, path: string) => ['code-file', id, path] as const,
};

export const useGithubConfig = () => useQuery({ queryKey: codeKeys.githubConfig, queryFn: codeApi.githubConfig, staleTime: 60_000 });
export const useConnections = () => useQuery({ queryKey: codeKeys.connections, queryFn: codeApi.connections });
export const useOwners = (connectionId: string | null) =>
  useQuery({ queryKey: codeKeys.owners(connectionId ?? ''), queryFn: () => codeApi.owners(connectionId!), enabled: Boolean(connectionId), retry: false });
export const useRepos = (connectionId: string | null, owner: string | null) =>
  useQuery({
    queryKey: codeKeys.repos(connectionId ?? '', owner ?? ''),
    queryFn: () => codeApi.repos(connectionId!, owner!),
    enabled: Boolean(connectionId && owner),
    retry: false,
  });
export const useBranches = (connectionId: string | null, owner: string | null, repo: string | null) =>
  useQuery({
    queryKey: codeKeys.branches(connectionId ?? '', owner ?? '', repo ?? ''),
    queryFn: () => codeApi.branches(connectionId!, owner!, repo!),
    enabled: Boolean(connectionId && owner && repo),
    retry: false,
  });

export const useCodeWorkspaces = () =>
  useQuery({
    queryKey: codeKeys.workspaces,
    queryFn: codeApi.workspaces,
    refetchInterval: (q) => (q.state.data?.some((w) => w.status === 'provisioning' || w.status === 'syncing') ? 2000 : false),
  });

export const useCodeWorkspace = (id: string | null) =>
  useQuery({
    queryKey: codeKeys.workspace(id ?? ''),
    queryFn: () => codeApi.workspace(id!),
    enabled: Boolean(id),
    // Provisioning progress also arrives as live events; polling is the fallback.
    refetchInterval: (q) => (q.state.data && ['provisioning', 'syncing'].includes(q.state.data.workspace.status) ? 2500 : false),
    retry: false,
  });

const ready = (status?: string) => status === 'ready' || status === 'syncing';

export const useTree = (id: string, status?: string) =>
  useQuery({ queryKey: codeKeys.tree(id), queryFn: () => codeApi.tree(id), enabled: ready(status) });
export const useGit = (id: string, status?: string) =>
  useQuery({ queryKey: codeKeys.git(id), queryFn: () => codeApi.git(id), enabled: ready(status) });
export const useDiff = (id: string, status?: string) =>
  useQuery({ queryKey: codeKeys.diff(id), queryFn: () => codeApi.diff(id), enabled: ready(status) });
export const useCodeRuns = (id: string) => useQuery({ queryKey: codeKeys.runs(id), queryFn: () => codeApi.runs(id) });
export const useExecutions = (id: string) => useQuery({ queryKey: codeKeys.executions(id), queryFn: () => codeApi.executions(id) });
export const useCodeRun = (runId: string | null) =>
  useQuery({
    queryKey: codeKeys.run(runId ?? ''),
    queryFn: () => codeApi.run(runId!),
    enabled: Boolean(runId),
    refetchInterval: (q) => (q.state.data && ['queued', 'running'].includes(q.state.data.run.status) ? 3000 : false),
  });

export const useLabProviders = () => useQuery({ queryKey: ['lab-providers'], queryFn: labApi.providers, staleTime: 30_000 });
export const useLabModels = () => useQuery({ queryKey: ['lab-models'], queryFn: labApi.models, staleTime: 30_000 });

/** Invalidates everything that reflects the working tree (tree, Git status, diff). */
export function useRefreshWorkingTree(id: string) {
  const qc = useQueryClient();
  return useMemo(
    () => () => {
      void qc.invalidateQueries({ queryKey: codeKeys.tree(id) });
      void qc.invalidateQueries({ queryKey: codeKeys.git(id) });
      void qc.invalidateQueries({ queryKey: codeKeys.diff(id) });
    },
    [qc, id],
  );
}

/**
 * Re-reads open files that changed in the workspace (agent edits, commands, branch switches).
 * Clean buffers update in place; buffers with unsaved edits are flagged as conflicts.
 */
export async function refreshOpenFiles(id: string, paths?: string[]) {
  const { buffers, workspaceId } = useCode.getState();
  if (workspaceId !== id) return;
  const targets = (paths ?? Object.keys(buffers)).filter((p) => buffers[p]);
  await Promise.all(
    targets.map(async (p) => {
      const file = await codeApi.file(id, p).catch(() => null);
      useCode.getState().externalChange(p, file && !file.binary ? (file.content ?? '') : null);
    }),
  );
}

/** Live workspace channel: sync status, user terminal output, user-visible Git operations. */
export function useWorkspaceEvents(id: string) {
  const qc = useQueryClient();
  const refresh = useRefreshWorkingTree(id);
  const upsertTerminal = useCode((s) => s.upsertTerminal);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');

  useEffect(() => {
    return followWorkspace(id, {
      onStateChange: setConnection,
      onEvent: (e: WorkspaceEvent) => {
        const d = e.data;
        const cid = (d.correlationId as string | undefined) ?? (d.executionId as string | undefined);
        switch (e.type) {
          case 'workspace.status':
            void qc.invalidateQueries({ queryKey: codeKeys.workspace(id) });
            void qc.invalidateQueries({ queryKey: codeKeys.workspaces });
            if (d.status === 'ready') {
              refresh();
              void refreshOpenFiles(id);
            }
            break;
          case 'command.started':
            if (cid) upsertTerminal(cid, { command: String(d.command ?? ''), kind: String(d.kind ?? 'command'), status: 'running' });
            break;
          case 'command.output':
            if (cid) upsertTerminal(cid, { append: String(d.chunk ?? '') });
            break;
          case 'command.completed':
            if (cid) {
              upsertTerminal(cid, {
                status: d.timedOut ? 'timeout' : d.exitCode === 0 ? 'passed' : 'failed',
                exitCode: d.exitCode as number,
                durationMs: d.durationMs as number,
              });
            }
            void qc.invalidateQueries({ queryKey: codeKeys.executions(id) });
            break;
          case 'command.denied':
            if (cid) upsertTerminal(cid, { status: 'denied', message: String(d.reason ?? 'Command not allowed') });
            break;
          case 'command.failed':
            if (cid) upsertTerminal(cid, { status: 'failed', message: String(d.message ?? 'Command failed') });
            break;
          case 'file.modified':
          case 'git.diff.updated':
            refresh();
            void refreshOpenFiles(id);
            break;
          case 'branch.created':
          case 'commit.created':
          case 'push.completed':
          case 'pull_request.created':
            refresh();
            void qc.invalidateQueries({ queryKey: codeKeys.workspace(id) });
            break;
          default:
            break;
        }
      },
    });
  }, [id, qc, refresh, upsertTerminal]);

  return connection;
}

/**
 * A code run's live state: the generic run view (status, streamed answer, approvals) plus the
 * code view (plan, activity, reviews, commands, tests, diff), both from the same event stream.
 */
export function useCodeRunView(codeWorkspaceId: string, runId: string | null) {
  const { view, connection } = useRunView(runId, true);
  const { data: events } = useQuery<RunEvent[]>({
    queryKey: keys.runEvents(runId ?? ''),
    queryFn: () => [],
    enabled: false,
    initialData: [],
    staleTime: Infinity,
  });
  const code: CodeRunView | null = useMemo(() => (runId && events.length ? reduceCodeEvents(events) : null), [runId, events]);

  // Agent edits and Git operations change the working tree: keep the editor and Git panels current.
  const qc = useQueryClient();
  const refresh = useRefreshWorkingTree(codeWorkspaceId);
  const seen = useRef<{ runId: string | null; seq: number }>({ runId: null, seq: 0 });
  useEffect(() => {
    if (!runId || !events.length) return;
    const initial = seen.current.runId !== runId;
    const fresh = initial ? [] : events.filter((e) => e.seq > seen.current.seq);
    seen.current = { runId, seq: events.at(-1)!.seq };
    if (!fresh.length) return;
    const touched = new Set<string>();
    let tree = false;
    for (const e of fresh) {
      if (e.type === 'file.modified') {
        touched.add(e.data.path);
        tree = true;
      } else if (['git.diff.updated', 'commit.created', 'branch.created', 'push.completed', 'pull_request.created'].includes(e.type)) tree = true;
      else if (e.type === 'command.completed') void qc.invalidateQueries({ queryKey: codeKeys.executions(codeWorkspaceId) });
      else if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled') {
        void qc.invalidateQueries({ queryKey: codeKeys.runs(codeWorkspaceId) });
        void qc.invalidateQueries({ queryKey: codeKeys.run(runId) });
        tree = true;
      }
    }
    if (tree) refresh();
    if (touched.size) void refreshOpenFiles(codeWorkspaceId, [...touched]);
  }, [events, runId, codeWorkspaceId, qc, refresh]);
  return { view, code, connection };
}
