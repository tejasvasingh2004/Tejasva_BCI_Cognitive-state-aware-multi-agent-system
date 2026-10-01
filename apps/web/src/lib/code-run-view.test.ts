import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@neuroflow/contracts';
import { reduceCodeEvents } from './code-run-view';
import { parseRoute } from '../hooks/route';
import { parseUnifiedDiff } from '../components/code/DiffView';

let seq = 0;
const ev = (type: RunEvent['type'], data: unknown): RunEvent =>
  ({ runId: 'r', seq: ++seq, ts: new Date(1_700_000_000_000 + seq * 100).toISOString(), type, data }) as RunEvent;

const file = { path: 'src/a.ts', op: 'modify', additions: 2, deletions: 1 } as const;

describe('reduceCodeEvents', () => {
  it('derives plan, activity, reviews, commands and tests from real events only', () => {
    seq = 0;
    const view = reduceCodeEvents([
      ev('repository.loaded', { repository: 'acme/app', branch: 'main', commit: 'abc', fileCount: 12, languages: ['TypeScript'], projectKind: 'node', instructions: true }),
      ev('agent.plan.created', { steps: ['Read the code', 'Fix the bug', 'Run tests'] }),
      ev('file.search.started', { query: 'add', kind: 'text' }),
      ev('file.search.completed', { query: 'add', kind: 'text', matches: 3, files: ['src/a.ts'] }),
      ev('file.read', { path: 'src/a.ts', bytes: 100 }),
      ev('patch.generated', { patchId: 'p1', toolCallId: 't1', files: [file], valid: true }),
      ev('patch.review_required', { patchId: 'p1', toolCallId: 't1', files: [file], diff: 'diff --git a/src/a.ts b/src/a.ts' }),
      ev('approval.requested', { toolCallId: 't1', name: 'edit_file', riskLevel: 'medium', arguments: {}, expiresAt: '2030-01-01T00:00:00Z' }),
      ev('approval.requested', { toolCallId: 't2', name: 'push', riskLevel: 'high', arguments: {}, expiresAt: '2030-01-01T00:00:00Z', reason: 'Push publishes commits' }),
    ]);
    expect(view.repository?.repository).toBe('acme/app');
    expect(view.plan?.steps).toHaveLength(3);
    expect(view.filesRead).toEqual(['src/a.ts']);
    expect(view.reviews).toEqual([expect.objectContaining({ patchId: 'p1', status: 'pending' })]);
    // The patch approval is a review, not a separate action approval.
    expect(view.approvals.map((a) => a.toolCallId)).toEqual(['t2']);
    expect(view.activity.find((a) => a.kind === 'search')).toMatchObject({ status: 'done', detail: '3 matches in 1 file' });
  });

  it('tracks decisions, command output, tests and completion', () => {
    seq = 0;
    const view = reduceCodeEvents([
      ev('patch.review_required', { patchId: 'p1', toolCallId: 't1', files: [file], diff: '' }),
      ev('patch.approved', { patchId: 'p1' }),
      ev('file.modified', { path: 'src/a.ts', op: 'modify', additions: 2, deletions: 1, patchId: 'p1' }),
      ev('command.started', { executionId: 'e1', command: 'npm test', kind: 'test' }),
      ev('test.started', { executionId: 'e1', command: 'npm test' }),
      ev('command.output', { executionId: 'e1', chunk: 'ok 1\n' }),
      ev('command.output', { executionId: 'e1', chunk: 'ok 2\n' }),
      ev('command.completed', { executionId: 'e1', kind: 'test', exitCode: 0, durationMs: 1200, timedOut: false }),
      ev('test.completed', { executionId: 'e1', passed: true, exitCode: 0, durationMs: 1200, summary: { passed: 2, total: 2 } }),
      ev('git.diff.updated', { files: [file], additions: 2, deletions: 1 }),
      ev('code.run.completed', { status: 'completed', filesChanged: 1, additions: 2, deletions: 1, testsPassed: true }),
    ]);
    expect(view.reviews[0]!.status).toBe('approved');
    expect(view.filesModified).toEqual(['src/a.ts']);
    expect(view.commands[0]).toMatchObject({ status: 'passed', output: 'ok 1\nok 2\n', exitCode: 0 });
    expect(view.tests[0]).toMatchObject({ passed: true, summary: { passed: 2, total: 2 } });
    expect(view.activity.find((a) => a.kind === 'test')).toMatchObject({ status: 'done', title: 'Tests passed (2/2)' });
    expect(view.diff?.additions).toBe(2);
    expect(view.completed?.testsPassed).toBe(true);
  });

  it('closes pending work when the run is cancelled', () => {
    seq = 0;
    const view = reduceCodeEvents([
      ev('patch.review_required', { patchId: 'p1', toolCallId: 't1', files: [file], diff: '' }),
      ev('command.started', { executionId: 'e1', command: 'npm run build', kind: 'build' }),
      ev('run.cancelled', { reason: 'user' }),
    ]);
    expect(view.reviews[0]!.status).toBe('rejected');
    expect(view.commands[0]!.status).toBe('failed');
    expect(view.activity.every((a) => a.status !== 'active' && a.status !== 'waiting')).toBe(true);
  });
});

describe('parseRoute', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  it('maps paths to apps', () => {
    expect(parseRoute('/')).toEqual({ app: 'chat', conversationId: null });
    expect(parseRoute(`/c/${id}`)).toEqual({ app: 'chat', conversationId: id });
    expect(parseRoute('/code')).toEqual({ app: 'code', workspaceId: null, replayRunId: null });
    expect(parseRoute(`/code/${id}`)).toEqual({ app: 'code', workspaceId: id, replayRunId: null });
    expect(parseRoute(`/code/${id}/replay/${id}`)).toEqual({ app: 'code', workspaceId: id, replayRunId: id });
    expect(parseRoute('/lab/datasets')).toEqual({ app: 'lab', section: 'datasets' });
  });
});

describe('parseUnifiedDiff', () => {
  it('parses files, statuses and line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' const x = 1;',
      '-return a - b;',
      '+return a + b;',
      'diff --git a/new.md b/new.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.md',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/a.ts', 'modified', 1, 1],
      ['new.md', 'added', 1, 0],
    ]);
    expect(files[0]!.lines.find((l) => l.kind === 'add')).toMatchObject({ newNo: 2 });
    expect(files[0]!.lines.find((l) => l.kind === 'del')).toMatchObject({ oldNo: 2 });
  });
});
