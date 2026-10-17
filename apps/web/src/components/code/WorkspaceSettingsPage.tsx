import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Check } from 'lucide-react';
import { Archive, FileText, ListChecks, Save, Terminal } from 'lucide-react';
import type { ApprovalMode } from '@neuroflow/contracts';
import { ApiRequestError } from '@/lib/api';
import { codeApi } from '@/lib/code-api';
import { cn } from '@/lib/utils';
import { codeKeys, useCodeWorkspace, useLabModels, useRefreshWorkingTree } from '@/hooks/code';
import { navigateTo } from '@/hooks/route';
import { useCode } from '@/stores/code';
import { useToasts } from '@/stores/toasts';
import { Button } from '@/components/ui/button';
import { APPROVAL_MODES, errorMessage, inputClass } from './shared';
import { WorkspacePage } from './WorkspacePage';

const COMMANDS = ['install', 'test', 'lint', 'build'] as const;
const INSTRUCTIONS_PATH = '.neuroflow/instructions.md';

function Card({ title, icon: Icon, description, children }: { title: string; icon: typeof Check; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface/50 p-5">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-accent" />
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
      </div>
      {description && <p className="mt-1 text-xs leading-5 text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Workspace Settings: defaults for the Code Agent, project commands, sandbox and repository instructions. */
export function WorkspaceSettingsPage({ workspaceId }: { workspaceId: string }) {
  return (
    <WorkspacePage workspaceId={workspaceId} title="Settings">
      <SettingsBody workspaceId={workspaceId} />
    </WorkspacePage>
  );
}

function SettingsBody({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);
  const { data } = useCodeWorkspace(workspaceId);
  const models = useLabModels();
  const ws = data!.workspace;

  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(ws.approvalMode);
  const [planReviewDefault, setPlanReviewDefault] = useState(data!.settings.planReviewDefault);
  const [defaultModel, setDefaultModel] = useState(data!.settings.defaultModel ?? 'auto');
  const [sandboxImage, setSandboxImage] = useState(data!.settings.sandboxImage ?? '');
  const [commands, setCommands] = useState<Record<string, string>>(data!.commands);
  useEffect(() => {
    setApprovalMode(data!.workspace.approvalMode);
    setPlanReviewDefault(data!.settings.planReviewDefault);
    setDefaultModel(data!.settings.defaultModel ?? 'auto');
    setSandboxImage(data!.settings.sandboxImage ?? '');
    setCommands(data!.commands);
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const changedCommands = Object.fromEntries(COMMANDS.map((k) => [k, (commands[k] ?? '').trim()]).filter(([k, v]) => v !== (data!.commands[k as string] ?? '')));
      return codeApi.updateWorkspace(workspaceId, {
        approvalMode,
        settings: { planReviewDefault, defaultModel: defaultModel === 'auto' ? null : defaultModel, sandboxImage: sandboxImage || null },
        ...(Object.keys(changedCommands).length ? { commands: changedCommands } : {}),
      });
    },
    onSuccess: () => {
      // The composer's "Plan first" follows the new default for this workspace.
      useCode.getState().setPlanReview(workspaceId, planReviewDefault);
      useCode.getState().setApprovalMode(workspaceId, approvalMode);
      void qc.invalidateQueries({ queryKey: codeKeys.workspace(workspaceId) });
      pushToast({ tone: 'success', title: 'Workspace settings saved' });
    },
    onError: (err) => pushToast({ tone: 'error', title: 'Could not save settings', body: errorMessage(err) }),
  });
  const archive = useMutation({
    mutationFn: () => codeApi.archiveWorkspace(workspaceId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: codeKeys.workspaces });
      navigateTo('/code');
    },
  });

  const detected = data!.detected;
  const modelOptions = models.data?.models.filter((m) => m.available && m.capabilities.tools) ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Workspace settings</h1>
        <p className="mt-1 text-sm text-muted">
          Defaults for the Code Agent in <span className="font-mono">{ws.repository.fullName}</span>. They apply to new tasks; a request can still override them.
        </p>
      </div>

      <Card title="Agent defaults" icon={ListChecks}>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-soft">Approval mode</span>
            <select className={inputClass} value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as ApprovalMode)} data-testid="settings-approval-mode">
              {APPROVAL_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.description}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-soft">Default model</span>
            <select className={inputClass} value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} data-testid="settings-default-model">
              <option value="auto">Auto (router and Model Lab defaults)</option>
              {modelOptions.map((m) => (
                <option key={m.ref} value={m.ref}>
                  {m.displayName} — {m.ref}
                </option>
              ))}
              {models.data?.deployments
                .filter((d) => d.status === 'active')
                .map((d) => (
                  <option key={d.id} value={`deployment/${d.name}`}>
                    deployment/{d.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="mt-4 flex items-start gap-3 rounded-xl border border-line bg-surface/60 p-3">
          <input type="checkbox" className="mt-0.5" checked={planReviewDefault} onChange={(e) => setPlanReviewDefault(e.target.checked)} data-testid="settings-plan-review" />
          <span>
            <span className="block text-sm font-medium text-ink">Review plans first</span>
            <span className="block text-xs leading-5 text-muted">Every task starts with Plan Review: the agent proposes a plan and waits for you to approve or edit it before touching the repository.</span>
          </span>
        </label>
      </Card>

      <Card title="Project commands" icon={Terminal} description={`Used by the agent and the Tests panel. Leave empty to use what NeuroFlow detected${detected ? ` (${detected.kind}${detected.packageManager ? `, ${detected.packageManager}` : ''})` : ''}.`}>
        <div className="grid gap-3 md:grid-cols-2">
          {COMMANDS.map((k) => (
            <label key={k} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium capitalize text-ink-soft">{k}</span>
              <input
                className={cn(inputClass, 'font-mono text-xs')}
                value={commands[k] ?? ''}
                placeholder={detected?.commands[k] ?? 'not detected'}
                onChange={(e) => setCommands((c) => ({ ...c, [k]: e.target.value }))}
                data-testid={`settings-command-${k}`}
              />
            </label>
          ))}
        </div>
        <label className="mt-4 flex flex-col gap-1.5 md:w-1/2">
          <span className="text-xs font-medium text-ink-soft">Sandbox image</span>
          <select className={cn(inputClass, 'font-mono text-xs')} value={sandboxImage} onChange={(e) => setSandboxImage(e.target.value)} data-testid="settings-sandbox-image">
            <option value="">Detected{detected ? ` (${detected.image})` : ''}</option>
            {data!.sandboxImages.map((img) => (
              <option key={img} value={img}>
                {img}
              </option>
            ))}
          </select>
        </label>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" size="md" onClick={() => save.mutate()} disabled={save.isPending} data-testid="settings-save">
          <Save className="size-4" /> Save settings
        </Button>
      </div>

      <InstructionsEditor workspaceId={workspaceId} />

      <Card title="Archive workspace" icon={Archive} description="Removes the workspace from your list. The repository on GitHub is not affected.">
        <Button variant="danger" size="sm" disabled={archive.isPending} onClick={() => window.confirm('Archive this workspace?') && archive.mutate()}>
          <Archive className="size-3.5" /> Archive
        </Button>
      </Card>
    </div>
  );
}

function InstructionsEditor({ workspaceId }: { workspaceId: string }) {
  const pushToast = useToasts((s) => s.push);
  const refresh = useRefreshWorkingTree(workspaceId);
  const file = useQuery({
    queryKey: [...codeKeys.file(workspaceId, INSTRUCTIONS_PATH), 'settings'],
    queryFn: () =>
      codeApi.file(workspaceId, INSTRUCTIONS_PATH).then(
        (f) => f.content ?? '',
        (err: unknown) => {
          if (err instanceof ApiRequestError && err.status === 404) return '';
          throw err;
        },
      ),
    staleTime: 0,
  });
  const [text, setText] = useState('');
  useEffect(() => {
    if (file.data !== undefined) setText(file.data);
  }, [file.data]);
  const save = useMutation({
    mutationFn: () => codeApi.saveFile(workspaceId, INSTRUCTIONS_PATH, text.endsWith('\n') || !text ? text : `${text}\n`),
    onSuccess: () => {
      refresh();
      void file.refetch();
      pushToast({ tone: 'success', title: 'Instructions saved', body: 'Commit the change from the Git panel to share it with your team.' });
    },
    onError: (err) => pushToast({ tone: 'error', title: 'Could not save instructions', body: errorMessage(err) }),
  });
  const dirty = file.data !== undefined && text !== file.data;
  return (
    <Card
      title="Repository instructions"
      icon={FileText}
      description="Saved as .neuroflow/instructions.md in the repository and given to the agent on every task: conventions, commands, things to avoid."
    >
      <textarea
        className={cn(inputClass, 'min-h-48 font-mono text-xs leading-5')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'- Use pnpm, never npm.\n- Run the tests for the package you change.\n- Prefer small functions; add tests for bug fixes.'}
        disabled={file.isLoading}
        data-testid="settings-instructions"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-faint">The file is written to the working tree; it reaches GitHub when you commit and push it.</p>
        <Button variant="outline" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="settings-instructions-save">
          <Save className="size-3.5" /> Save instructions
        </Button>
      </div>
    </Card>
  );
}
