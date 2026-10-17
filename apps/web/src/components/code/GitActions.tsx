import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitCommitHorizontal, GitPullRequest, Upload } from 'lucide-react';
import type { CodeWorkspace } from '@neuroflow/contracts';
import { codeApi } from '@/lib/code-api';
import { cn } from '@/lib/utils';
import { codeKeys, useGit, useRefreshWorkingTree } from '@/hooks/code';
import { useToasts } from '@/stores/toasts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { errorMessage, inputClass } from './shared';

export const AGENT_BRANCH_PREFIX = 'neuroflow/agent/';

/**
 * Commit → push → pull request. Commits never land on the base branch (the server moves them to a
 * `neuroflow/agent/*` branch); push is limited to agent branches; every step is an explicit user
 * action and is recorded (and linked to the agent run when one is active).
 */
export function GitActions({ workspace, runId, defaultMessage, compact }: { workspace: CodeWorkspace; runId?: string | null; defaultMessage?: string; compact?: boolean }) {
  const qc = useQueryClient();
  const id = workspace.id;
  const git = useGit(id, workspace.status);
  const refresh = useRefreshWorkingTree(id);
  const pushToast = useToasts((s) => s.push);
  const [message, setMessage] = useState('');
  const [prOpen, setPrOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = git.data?.status.length ?? 0;
  const branch = git.data?.branch ?? workspace.branch;
  const onAgentBranch = branch.startsWith(AGENT_BRANCH_PREFIX);
  const ops = git.data?.operations ?? [];
  const pushedSha = ops.find((o) => o.kind === 'push' && o.ref === branch)?.sha;
  const head = git.data?.log[0]?.sha;
  const unpushed = onAgentBranch && head && head !== pushedSha;
  const prForBranch = ops.find((o) => o.kind === 'pull_request' && o.ref === branch);

  const after = () => {
    refresh();
    void qc.invalidateQueries({ queryKey: codeKeys.workspace(id) });
    if (runId) void qc.invalidateQueries({ queryKey: codeKeys.run(runId) });
  };
  const commit = useMutation({
    mutationFn: () => codeApi.commit(id, (message.trim() || defaultMessage || '').trim(), runId ?? undefined),
    onSuccess: (r) => {
      setMessage('');
      setError(null);
      pushToast({ tone: 'success', title: `Committed ${r.sha.slice(0, 7)}`, body: `on ${r.branch}` });
      after();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const push = useMutation({
    mutationFn: () => codeApi.push(id, runId ?? undefined),
    onSuccess: (r) => {
      setError(null);
      pushToast({ tone: 'success', title: `Pushed ${r.branch}`, body: r.remote });
      after();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const msg = message.trim() || defaultMessage || '';
  return (
    <div className={cn('flex flex-col gap-2', compact && 'gap-1.5')} data-testid="git-actions">
      <textarea
        className={cn(inputClass, 'min-h-[60px] resize-y font-mono text-xs leading-5')}
        placeholder={defaultMessage || 'Commit message'}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && changes && msg.length >= 3) commit.mutate();
        }}
        data-testid="commit-message"
      />
      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" disabled={!changes || msg.length < 3 || commit.isPending} onClick={() => commit.mutate()} data-testid="commit">
          <GitCommitHorizontal className="size-3.5" /> Commit{changes ? ` ${changes}` : ''}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!onAgentBranch || !unpushed || !workspace.repository.canPush || push.isPending}
          onClick={() => push.mutate()}
          title={
            !workspace.repository.canPush
              ? 'The connected credentials cannot push to this repository'
              : !onAgentBranch
                ? `Only ${AGENT_BRANCH_PREFIX}* branches can be pushed`
                : undefined
          }
          data-testid="push"
        >
          <Upload className="size-3.5" /> Push
        </Button>
        {workspace.repository.provider === 'github' &&
          (prForBranch?.url ? (
            <Button variant="outline" size="sm" asChild>
              <a href={prForBranch.url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" /> PR
              </a>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={!onAgentBranch || !pushedSha} onClick={() => setPrOpen(true)} data-testid="open-pr">
              <GitPullRequest className="size-3.5" /> Pull request
            </Button>
          ))}
      </div>
      {!changes && !unpushed && <p className="text-[11px] text-faint">Working tree clean on {branch}.</p>}
      {changes > 0 && !onAgentBranch && (
        <p className="text-[11px] leading-4 text-faint">Commits go to a new {AGENT_BRANCH_PREFIX}… branch, never directly to {branch}.</p>
      )}
      {error && <p className="text-[11px] text-rose-500" role="alert">{error}</p>}
      <PullRequestDialog open={prOpen} onOpenChange={setPrOpen} workspace={workspace} runId={runId} branch={branch} defaultTitle={git.data?.log[0]?.subject ?? ''} onDone={after} />
    </div>
  );
}

function PullRequestDialog({
  open,
  onOpenChange,
  workspace,
  runId,
  branch,
  defaultTitle,
  onDone,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  workspace: CodeWorkspace;
  runId?: string | null;
  branch: string;
  defaultTitle: string;
  onDone(): void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pushToast = useToasts((s) => s.push);
  const create = useMutation({
    mutationFn: () => codeApi.pullRequest(workspace.id, { title: title.trim() || defaultTitle, body, draft }, runId ?? undefined),
    onSuccess: (pr) => {
      onOpenChange(false);
      pushToast({ tone: 'success', title: `Pull request #${pr.number} opened`, body: `${pr.head} → ${pr.base}`, onClick: () => window.open(pr.url, '_blank') });
      onDone();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Create pull request" description={`${branch} → ${workspace.baseBranch} on ${workspace.repository.fullName}`}>
      <div className="flex flex-col gap-3">
        <input className={inputClass} placeholder={defaultTitle || 'Title'} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="pr-title" />
        <textarea className={cn(inputClass, 'min-h-32 leading-6')} placeholder="Describe the change" value={body} onChange={(e) => setBody(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Open as draft
        </label>
        <p className="text-xs text-muted">NeuroFlow never merges pull requests; review and merge on GitHub.</p>
        {error && <p className="text-xs text-rose-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="md" disabled={(title.trim() || defaultTitle).length < 3 || create.isPending} onClick={() => create.mutate()} data-testid="create-pr">
            <GitPullRequest className="size-4" /> Create pull request
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
