import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  FlaskConical,
  GaugeCircle,
  MessageSquare,
  Plus,
  Rocket,
  Server,
  SlidersHorizontal,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import type { ModelDeployment, ModelInfo, ModelLabConfig, ModelLabScope, ReasoningBudget, RequestedAgentStrategy } from '@neuroflow/contracts';
import { labApi } from '@/lib/code-api';
import { cn, formatCost, formatDuration, relativeTime } from '@/lib/utils';
import { useLabModels, useLabProviders } from '@/hooks/code';
import { useTools } from '@/hooks/queries';
import { navigateTo, useDocumentTitle } from '@/hooks/route';
import { useUi } from '@/stores/ui';
import { useToasts } from '@/stores/toasts';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/ui/sparkle';
import { AppSwitcher } from '@/components/layout/AppSwitcher';
import { errorMessage, inputClass, StatusDot } from '@/components/code/shared';

const SECTIONS = [
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'providers', label: 'Providers', icon: Server },
  { id: 'parameters', label: 'Parameters', icon: SlidersHorizontal },
  { id: 'datasets', label: 'Datasets', icon: Database },
  { id: 'fine-tuning', label: 'Fine-tuning', icon: Cpu },
  { id: 'evaluations', label: 'Evaluations', icon: GaugeCircle },
  { id: 'deployments', label: 'Deployments', icon: Rocket },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

const BUDGETS: ReasoningBudget[] = ['off', 'low', 'medium', 'high'];
const STRATEGIES: RequestedAgentStrategy[] = ['auto', 'direct', 'single_agent', 'sequential', 'parallel', 'supervisor', 'evaluator_optimizer'];

/** Model Lab: configures the Model Gateway. Every call still goes through the NeuroFlow runtime. */
export function ModelLab({ section }: { section: string | null }) {
  useDocumentTitle('Model Lab · NeuroFlow');
  const current: Section = (SECTIONS.find((s) => s.id === section)?.id ?? 'models') as Section;
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="glass flex h-14 shrink-0 items-center gap-3 rounded-[22px] px-4">
        <Logo className="size-7" />
        <div className="text-sm font-semibold text-ink">Model Lab</div>
        <AppSwitcher className="ml-4" />
      </header>
      <div className="flex min-h-0 flex-1 gap-3">
        <nav className="glass hidden w-52 shrink-0 flex-col gap-0.5 rounded-[24px] p-3 md:flex" aria-label="Model Lab sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => navigateTo(`/lab/${s.id}`)}
              className={cn(
                'flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition',
                current === s.id ? 'bg-surface text-ink shadow-soft' : 'text-ink-soft hover:bg-surface/60',
              )}
              data-testid={`lab-${s.id}`}
            >
              <s.icon className={cn('size-4', current === s.id ? 'text-accent' : 'text-faint')} />
              {s.label}
            </button>
          ))}
        </nav>
        <main className="glass min-w-0 flex-1 overflow-y-auto rounded-[24px]">
          <div className="mx-auto max-w-5xl px-6 py-6">
            <select className={cn(inputClass, 'mb-4 md:hidden')} value={current} onChange={(e) => navigateTo(`/lab/${e.target.value}`)}>
              {SECTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {current === 'models' && <ModelsSection />}
            {current === 'providers' && <ProvidersSection />}
            {current === 'parameters' && <ParametersSection />}
            {current === 'datasets' && <DatasetsSection />}
            {current === 'fine-tuning' && <FineTuningSection />}
            {current === 'evaluations' && <EvaluationsSection />}
            {current === 'deployments' && <DeploymentsSection />}
          </div>
        </main>
      </div>
    </div>
  );
}

function Title({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
      {children && <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{children}</p>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------------- models

function ModelsSection() {
  const { data, isLoading } = useLabModels();
  const setComposer = useUi((s) => s.setComposer);
  const byProvider = useMemo(() => {
    const m = new Map<string, ModelInfo[]>();
    for (const x of data?.models ?? []) m.set(x.provider, [...(m.get(x.provider) ?? []), x]);
    return [...m.entries()];
  }, [data]);
  return (
    <>
      <Title title="Models">Models available through the Model Gateway. Requests are routed, retried and fall back between them by the runtime — never from the browser.</Title>
      {isLoading && <div className="h-24 animate-pulse rounded-2xl bg-surface/60" />}
      {byProvider.map(([provider, models]) => (
        <div key={provider} className="mb-6">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{provider}</div>
          <div className="overflow-hidden rounded-2xl border border-line bg-surface/60">
            {models.map((m) => (
              <div key={m.ref} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line/60 px-4 py-3 last:border-0" data-testid="lab-model">
                <StatusDot status={m.available ? 'ready' : 'cancelled'} />
                <div className="min-w-48 flex-1">
                  <div className="text-sm font-medium text-ink">
                    {m.displayName}
                    {data?.default === m.ref && <span className="ml-2 rounded-full bg-violet-soft px-2 py-0.5 text-[10px] text-accent">default</span>}
                  </div>
                  <div className="font-mono text-[11px] text-muted">{m.ref}</div>
                </div>
                <div className="text-xs text-muted">{m.tier}</div>
                <div className="text-xs text-muted">{Math.round(m.contextWindow / 1000)}k ctx</div>
                <div className="flex gap-1">
                  {m.capabilities.tools && <Tag>tools</Tag>}
                  {m.capabilities.reasoning && <Tag>reasoning</Tag>}
                  {m.capabilities.streaming && <Tag>streaming</Tag>}
                </div>
                <div className="w-28 text-right text-xs text-muted">
                  {m.pricing ? (m.pricing.inputPerMTok === 0 ? 'free (local)' : `$${m.pricing.inputPerMTok} / $${m.pricing.outputPerMTok}`) : 'pricing n/a'}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!m.available}
                  onClick={() => {
                    setComposer({ model: m.ref });
                    navigateTo('/');
                  }}
                  title="Open a chat that uses this model"
                >
                  <MessageSquare className="size-3.5" /> Try
                </Button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function Tag({ children, tone = 'violet' }: { children: React.ReactNode; tone?: 'violet' | 'mint' | 'rose' | 'peach' }) {
  const tones = { violet: 'bg-violet-soft text-accent', mint: 'bg-mint-soft text-emerald-700', rose: 'bg-rose-soft text-rose-600', peach: 'bg-peach-soft text-amber-700' };
  return <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium', tones[tone])}>{children}</span>;
}

// ---------------------------------------------------------------------------------- providers

const FT_LABEL: Record<string, { text: string; tone: 'mint' | 'rose' | 'peach' | 'violet' }> = {
  available: { text: 'Fine-tuning available', tone: 'mint' },
  not_available: { text: 'Fine-tuning not available', tone: 'rose' },
  requires_provider_access: { text: 'Requires provider access', tone: 'peach' },
  coming_soon: { text: 'Not yet supported', tone: 'violet' },
};

function ProvidersSection() {
  const { data: providers = [], isLoading } = useLabProviders();
  return (
    <>
      <Title title="Providers">Provider connections are configured on the server. Credentials are never shown or sent to the browser.</Title>
      {isLoading && <div className="h-24 animate-pulse rounded-2xl bg-surface/60" />}
      <div className="grid gap-3 md:grid-cols-2">
        {providers.map((p) => (
          <div key={p.id} className="rounded-2xl border border-line bg-surface/60 p-4" data-testid="lab-provider">
            <div className="flex items-center gap-2">
              <StatusDot status={p.available ? 'ready' : p.configured ? 'error' : 'cancelled'} />
              <div className="text-sm font-semibold text-ink">{p.displayName}</div>
              <span className="ml-auto text-xs text-muted">
                {p.circuit === 'open' ? 'paused after repeated failures' : p.available ? 'reachable' : p.configured ? 'unreachable' : 'not configured'}
              </span>
              {p.circuit && p.circuit !== 'closed' && (
                <Tag tone={p.circuit === 'open' ? 'rose' : 'peach'}>{p.circuit === 'open' ? 'circuit open' : 'trial request'}</Tag>
              )}
            </div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted">Kind</dt>
              <dd className="text-ink-soft">{p.kind}</dd>
              <dt className="text-muted">Endpoint</dt>
              <dd className="truncate font-mono text-ink-soft">{p.endpoint || '—'}</dd>
              <dt className="text-muted">Models</dt>
              <dd className="text-ink-soft">{p.models}</dd>
            </dl>
            <div className="mt-3 flex items-start gap-2">
              <Tag tone={FT_LABEL[p.fineTuning.status]?.tone}>{FT_LABEL[p.fineTuning.status]?.text ?? p.fineTuning.status}</Tag>
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-faint">{p.fineTuning.reason}</p>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------- parameters

function ModelSelect({ value, onChange, includeAuto = true, disabled }: { value: string; onChange(v: string): void; includeAuto?: boolean; disabled?: boolean }) {
  const { data } = useLabModels();
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {includeAuto && <option value="auto">Auto (router decides)</option>}
      {data?.models.map((m) => (
        <option key={m.ref} value={m.ref}>
          {m.displayName} — {m.ref}
          {m.available ? '' : ' (unavailable)'}
        </option>
      ))}
      {includeAuto &&
        data?.deployments
          .filter((d) => d.status === 'active')
          .map((d) => (
            <option key={d.id} value={`deployment/${d.name}`}>
              deployment/{d.name}
            </option>
          ))}
    </select>
  );
}

function ParametersSection() {
  const [scope, setScope] = useState<ModelLabScope>('default');
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['lab-config', scope], queryFn: () => labApi.config(scope) });
  const { data: models } = useLabModels();
  const { data: tools = [] } = useTools();
  const [draft, setDraft] = useState<ModelLabConfig | null>(null);
  const pushToast = useToasts((s) => s.push);
  useEffect(() => {
    setDraft(data?.config ?? null);
  }, [data]);
  const save = useMutation({
    mutationFn: (c: ModelLabConfig) => labApi.saveConfig(scope, c),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lab-config', scope] });
      pushToast({ tone: 'success', title: 'Parameters saved', body: scope === 'code_agent' ? 'Applies to new Code Agent runs' : 'Applies to new runs' });
    },
    onError: (err) => pushToast({ tone: 'error', title: 'Could not save', body: errorMessage(err) }),
  });
  const model = models?.models.find((m) => m.ref === draft?.model);
  const supports = (p: string) => !model || model.supportedParameters?.includes(p as never) !== false;
  const scopedTools = tools.filter((t) => (scope === 'code_agent' ? true : !t.requiresWorkspace));
  const set = (patch: Partial<ModelLabConfig>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const editable = Boolean(data?.canEdit);

  return (
    <>
      <Title title="Parameters">
        Defaults the runtime applies to new runs when the request does not set them. Unsupported controls are hidden for the selected model; there is no universal “thinking” switch.
      </Title>
      <div className="mb-4 flex gap-1.5">
        {(['default', 'code_agent'] as const).map((s) => (
          <button key={s} onClick={() => setScope(s)} className={cn('h-8 rounded-full px-3.5 text-xs font-medium transition', scope === s ? 'bg-ink text-canvas' : 'bg-surface/70 text-ink-soft')}>
            {s === 'default' ? 'AI workspace' : 'Code Agent'}
          </button>
        ))}
      </div>
      {isLoading || !draft ? (
        <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />
      ) : (
        <div className="grid gap-4 rounded-2xl border border-line bg-surface/60 p-5 md:grid-cols-2">
          {!editable && <p className="col-span-full text-xs text-amber-700">Only workspace admins can change these defaults.</p>}
          <Field label="Model">
            <ModelSelect value={draft.model} onChange={(v) => set({ model: v })} disabled={!editable} />
          </Field>
          <Field label="Agent strategy">
            <select className={inputClass} value={draft.agentStrategy ?? 'auto'} disabled={!editable} onChange={(e) => set({ agentStrategy: e.target.value as RequestedAgentStrategy })}>
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          {supports('temperature') && (
            <Field label={`Temperature ${draft.temperature ?? 'default'}`}>
              <input type="range" min={0} max={2} step={0.1} value={draft.temperature ?? 0.7} disabled={!editable} onChange={(e) => set({ temperature: Number(e.target.value) })} className="accent-violet-500" />
            </Field>
          )}
          {supports('maxOutputTokens') && (
            <Field label="Max output tokens">
              <input
                type="number"
                className={inputClass}
                min={1}
                max={32768}
                placeholder="default"
                disabled={!editable}
                value={draft.maxOutputTokens ?? ''}
                onChange={(e) => set({ maxOutputTokens: e.target.value ? Number(e.target.value) : undefined })}
              />
            </Field>
          )}
          {model?.supportedParameters?.includes('reasoningBudget') || draft.model === 'auto' ? (
            <Field label="Reasoning budget" hint={draft.model === 'auto' ? 'Applied only to models that support it' : undefined}>
              <select className={inputClass} value={draft.reasoningBudget ?? ''} disabled={!editable} onChange={(e) => set({ reasoningBudget: (e.target.value || undefined) as ReasoningBudget | undefined })}>
                <option value="">Automatic</option>
                {BUDGETS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Recent messages kept in context">
            <input
              type="number"
              className={inputClass}
              min={2}
              max={100}
              placeholder="default"
              disabled={!editable}
              value={draft.recentMessages ?? ''}
              onChange={(e) => set({ recentMessages: e.target.value ? Number(e.target.value) : undefined })}
            />
          </Field>
          <div className="col-span-full">
            <div className="mb-1.5 flex items-center gap-3 text-xs font-medium text-ink-soft">
              Tools
              <label className="flex items-center gap-1.5 font-normal text-muted">
                <input type="checkbox" checked={draft.tools === null} disabled={!editable} onChange={(e) => set({ tools: e.target.checked ? null : scopedTools.map((t) => t.name) })} /> All permitted tools
              </label>
            </div>
            {draft.tools !== null && (
              <div className="flex flex-wrap gap-1.5">
                {scopedTools.map((t) => {
                  const on = draft.tools!.includes(t.name);
                  return (
                    <button
                      key={t.name}
                      disabled={!editable}
                      onClick={() => set({ tools: on ? draft.tools!.filter((x) => x !== t.name) : [...draft.tools!, t.name] })}
                      className={cn('rounded-full px-2.5 py-1 font-mono text-[11px] transition', on ? 'bg-violet-soft text-accent' : 'bg-surface text-faint')}
                      title={t.description}
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="col-span-full flex justify-end">
            <Button variant="primary" size="md" disabled={!editable || save.isPending} onClick={() => save.mutate(draft)} data-testid="save-parameters">
              Save parameters
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------- datasets

function DatasetsSection() {
  const qc = useQueryClient();
  const { data: datasets = [], isLoading } = useQuery({ queryKey: ['lab-datasets'], queryFn: labApi.datasets });
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => labApi.createDataset(name.trim()),
    onSuccess: ({ id }) => {
      setName('');
      setSelected(id);
      void qc.invalidateQueries({ queryKey: ['lab-datasets'] });
    },
  });
  useEffect(() => {
    if (!selected && datasets[0]) setSelected(datasets[0].id);
  }, [datasets, selected]);
  return (
    <>
      <Title title="Datasets">
        Examples are added only by explicit action: manually, by import, or by saving a recorded run from its replay. Nothing is collected from private repositories automatically, and only
        reviewed examples are exported.
      </Title>
      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <input className={cn(inputClass, 'py-1.5 text-xs')} placeholder="New dataset" value={name} onChange={(e) => setName(e.target.value)} data-testid="dataset-name" />
            <Button variant="outline" size="icon-sm" type="submit" aria-label="Create dataset" disabled={!name.trim()}>
              <Plus className="size-3.5" />
            </Button>
          </form>
          {isLoading && <div className="h-10 animate-pulse rounded-xl bg-surface/60" />}
          {datasets.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelected(d.id)}
              className={cn('rounded-xl px-3 py-2 text-left transition', selected === d.id ? 'bg-surface shadow-soft' : 'hover:bg-surface/60')}
            >
              <div className="truncate text-sm text-ink">{d.name}</div>
              <div className="text-[11px] text-muted">
                {d.examples} examples · {d.reviewed} reviewed
              </div>
            </button>
          ))}
        </div>
        {selected ? <DatasetDetail id={selected} onDeleted={() => setSelected(null)} /> : <div className="text-sm text-faint">Create a dataset to start.</div>}
      </div>
    </>
  );
}

function DatasetDetail({ id, onDeleted }: { id: string; onDeleted(): void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['lab-dataset', id], queryFn: () => labApi.dataset(id) });
  const [task, setTask] = useState('');
  const [expected, setExpected] = useState('');
  const [jsonl, setJsonl] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['lab-dataset', id] });
    void qc.invalidateQueries({ queryKey: ['lab-datasets'] });
  };
  const add = useMutation({
    mutationFn: () => labApi.addExample(id, { task: task.trim(), ...(expected.trim() ? { expected: expected.trim() } : {}) }),
    onSuccess: () => {
      setTask('');
      setExpected('');
      refresh();
    },
  });
  const importMut = useMutation({
    mutationFn: () => labApi.importExamples(id, jsonl),
    onSuccess: (r) => {
      setJsonl('');
      setImportMsg(`Imported ${r.imported}${r.errors.length ? ` · ${r.errors.join('; ')}` : ''}`);
      refresh();
    },
    onError: (err) => setImportMsg(errorMessage(err)),
  });
  const review = useMutation({ mutationFn: (v: { exampleId: string; reviewed: boolean }) => labApi.reviewExample(id, v.exampleId, v.reviewed), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (exampleId: string) => labApi.deleteExample(id, exampleId), onSuccess: refresh });
  const removeDataset = useMutation({
    mutationFn: () => labApi.deleteDataset(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lab-datasets'] });
      onDeleted();
    },
  });
  if (!data) return <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="text-base font-semibold text-ink">{data.dataset.name}</div>
        <span className="text-xs text-muted">
          {data.dataset.examples} examples · {data.dataset.reviewed} reviewed
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" asChild>
            <a href={labApi.exportUrl(id)} download>
              <Download className="size-3.5" /> Export reviewed (JSONL)
            </a>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => window.confirm('Delete this dataset?') && removeDataset.mutate()} aria-label="Delete dataset">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="grid gap-3 rounded-2xl border border-line bg-surface/60 p-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-ink-soft">Add an example</div>
          <textarea className={cn(inputClass, 'min-h-16 text-xs')} placeholder="Task / prompt" value={task} onChange={(e) => setTask(e.target.value)} data-testid="example-task" />
          <textarea className={cn(inputClass, 'min-h-12 text-xs')} placeholder="Expected answer (used by evaluations)" value={expected} onChange={(e) => setExpected(e.target.value)} />
          <Button variant="outline" size="sm" className="self-start" disabled={!task.trim() || add.isPending} onClick={() => add.mutate()} data-testid="add-example">
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-ink-soft">Import JSONL</div>
          <textarea
            className={cn(inputClass, 'min-h-[106px] font-mono text-[11px]')}
            placeholder={'{"task":"…","expected":"…"}\n{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}'}
            value={jsonl}
            onChange={(e) => setJsonl(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={!jsonl.trim() || importMut.isPending} onClick={() => importMut.mutate()}>
              <Upload className="size-3.5" /> Import
            </Button>
            <label className="cursor-pointer text-[11px] text-accent hover:underline">
              or choose a file
              <input type="file" accept=".jsonl,.json,.txt" className="hidden" onChange={(e) => void e.target.files?.[0]?.text().then(setJsonl)} />
            </label>
            {importMsg && <span className="truncate text-[11px] text-muted">{importMsg}</span>}
          </div>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-line">
        {data.examples.length === 0 && <div className="px-4 py-6 text-center text-xs text-faint">No examples yet.</div>}
        {data.examples.map((e) => (
          <div key={e.id} className="flex items-start gap-3 border-b border-line/60 bg-surface/50 px-4 py-2.5 last:border-0">
            <input type="checkbox" className="mt-1" checked={e.reviewed} onChange={(ev) => review.mutate({ exampleId: e.id, reviewed: ev.target.checked })} aria-label="Reviewed" />
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-xs text-ink">{e.task}</div>
              {e.expected && <div className="mt-0.5 line-clamp-1 text-[11px] text-emerald-700">→ {e.expected}</div>}
              <div className="mt-0.5 flex gap-2 text-[10.5px] text-faint">
                <span>{e.source.replace('_', ' ')}</span>
                {e.outcome && <span>{e.outcome}</span>}
                <span>{relativeTime(e.createdAt)}</span>
              </div>
            </div>
            <button className="rounded p-1 text-faint hover:text-rose-500" onClick={() => remove.mutate(e.id)} aria-label="Delete example">
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------- fine-tuning

function FineTuningSection() {
  const { data, isLoading } = useQuery({ queryKey: ['lab-fine-tuning'], queryFn: labApi.fineTuning });
  const anyAvailable = data?.providers.some((p) => p.status === 'available');
  return (
    <>
      <Title title="Fine-tuning">
        Fine-tuning depends on the provider. NeuroFlow never trains automatically and never uses private repository content unless you explicitly put it in a reviewed dataset.
      </Title>
      {isLoading && <div className="h-24 animate-pulse rounded-2xl bg-surface/60" />}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface/60">
        {data?.providers.map((p) => (
          <div key={p.provider} className="flex items-start gap-3 border-b border-line/60 px-4 py-3 last:border-0" data-testid="ft-provider">
            {p.status === 'available' ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-500" /> : <XCircle className="mt-0.5 size-4 text-faint" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                {p.displayName} <Tag tone={FT_LABEL[p.status]?.tone}>{FT_LABEL[p.status]?.text ?? p.status}</Tag>
              </div>
              <div className="mt-0.5 text-xs text-muted">{p.reason}</div>
            </div>
          </div>
        ))}
      </div>
      {!anyAvailable && data && (
        <div className="mt-4 rounded-2xl bg-violet-soft/50 px-4 py-3 text-sm text-ink-soft">
          None of the configured providers support fine-tuning through NeuroFlow, so no training jobs can be started here. You can export a reviewed dataset as chat-format JSONL from{' '}
          <button className="text-accent underline" onClick={() => navigateTo('/lab/datasets')}>
            Datasets
          </button>{' '}
          and use it with a provider that supports fine-tuning.
        </div>
      )}
      <h2 className="mb-2 mt-8 text-sm font-semibold text-ink">Jobs</h2>
      {data?.jobs.length === 0 && <div className="text-xs text-faint">No fine-tuning jobs.</div>}
      {data?.jobs.map((j) => (
        <div key={j.id} className="flex items-center gap-3 rounded-xl bg-surface/60 px-3 py-2 text-xs">
          <StatusDot status={j.status === 'succeeded' ? 'passed' : j.status} />
          <span className="text-ink">{j.name}</span>
          <span className="font-mono text-muted">{j.baseModel}</span>
          <span className="ml-auto text-muted">{j.status}</span>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------- evaluations

function EvaluationsSection() {
  const qc = useQueryClient();
  const { data: evaluations = [] } = useQuery({
    queryKey: ['lab-evaluations'],
    queryFn: labApi.evaluations,
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === 'queued' || e.status === 'running') ? 1500 : false),
  });
  const { data: datasets = [] } = useQuery({ queryKey: ['lab-datasets'], queryFn: labApi.datasets });
  const { data: models } = useLabModels();
  const [name, setName] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [scorer, setScorer] = useState<'contains' | 'exact' | 'judge'>('contains');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => labApi.createEvaluation({ name: name.trim() || 'Evaluation', datasetId, models: selected, scorer }),
    onSuccess: ({ id }) => {
      setError(null);
      setOpen(id);
      void qc.invalidateQueries({ queryKey: ['lab-evaluations'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <>
      <Title title="Evaluations">Run a dataset against up to four models through the Gateway (in the worker) and compare quality, latency and cost.</Title>
      <div className="grid gap-3 rounded-2xl border border-line bg-surface/60 p-4 md:grid-cols-2">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Support answers v2" />
        </Field>
        <Field label="Dataset">
          <select className={inputClass} value={datasetId} onChange={(e) => setDatasetId(e.target.value)} data-testid="eval-dataset">
            <option value="">Choose a dataset</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.examples})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scorer" hint={scorer === 'judge' ? 'The default model grades each answer against the reference' : 'Compared with each example’s expected answer'}>
          <select className={inputClass} value={scorer} onChange={(e) => setScorer(e.target.value as typeof scorer)}>
            <option value="contains">Contains expected answer</option>
            <option value="exact">Exact match</option>
            <option value="judge">LLM judge</option>
          </select>
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-soft">Models ({selected.length}/4)</span>
          <div className="flex flex-wrap gap-1.5">
            {models?.models
              .filter((m) => m.available)
              .map((m) => {
                const on = selected.includes(m.ref);
                return (
                  <button
                    key={m.ref}
                    onClick={() => setSelected(on ? selected.filter((x) => x !== m.ref) : selected.length < 4 ? [...selected, m.ref] : selected)}
                    className={cn('rounded-full px-2.5 py-1 font-mono text-[11px]', on ? 'bg-violet-soft text-accent' : 'bg-surface text-faint')}
                  >
                    {m.ref}
                  </button>
                );
              })}
          </div>
        </div>
        {error && <p className="col-span-full text-xs text-rose-500">{error}</p>}
        <div className="col-span-full flex justify-end">
          <Button variant="primary" size="md" disabled={!datasetId || !selected.length || create.isPending} onClick={() => create.mutate()} data-testid="run-evaluation">
            <FlaskConical className="size-4" /> Run evaluation
          </Button>
        </div>
      </div>
      <div className="mt-6 flex flex-col gap-2">
        {evaluations.map((e) => (
          <div key={e.id} className="rounded-2xl border border-line bg-surface/60" data-testid="evaluation">
            <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
              <StatusDot status={e.status === 'completed' ? 'passed' : e.status} />
              <span className="text-sm font-medium text-ink">{e.name}</span>
              <span className="text-xs text-muted">{e.scorer}</span>
              <span className="ml-auto text-xs text-muted">
                {e.status} · {relativeTime(e.createdAt)}
              </span>
            </button>
            {(open === e.id || e.status === 'running') && (
              <div className="border-t border-line/60 px-4 py-3">
                {e.error && <p className="mb-2 text-xs text-rose-500">{e.error}</p>}
                {e.results.length === 0 && <p className="text-xs text-faint">{e.status === 'failed' ? 'No results.' : 'Waiting for the worker…'}</p>}
                {e.results.map((r) => (
                  <div key={r.model} className="mb-3">
                    <div className="flex items-center gap-3 text-xs">
                      <span className="w-56 truncate font-mono text-ink">{r.model}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
                        <div className="h-full rounded-full bg-violet-button" style={{ width: `${Math.round(r.score * 100)}%` }} />
                      </div>
                      <span className="w-12 text-right font-semibold text-ink">{Math.round(r.score * 100)}%</span>
                      <span className="w-16 text-right text-muted">
                        {r.passed}/{r.total}
                      </span>
                      <span className="w-16 text-right text-muted">{formatDuration(r.avgLatencyMs)}</span>
                      <span className="w-16 text-right text-muted">{formatCost(r.costUsd)}</span>
                      {r.errors > 0 && <span className="text-rose-500">{r.errors} errors</span>}
                    </div>
                    {open === e.id && (
                      <details className="mt-1 pl-56 text-[11px]">
                        <summary className="cursor-pointer text-muted">Samples</summary>
                        {r.samples.map((s) => (
                          <div key={s.exampleId} className="mt-1 flex gap-2">
                            {s.passed ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" /> : <XCircle className="size-3.5 shrink-0 text-rose-400" />}
                            <span className="line-clamp-2 text-ink-soft">{s.error ?? s.output}</span>
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------- deployments

const emptyDeployment = { name: '', model: '', description: '', status: 'active' as 'active' | 'disabled', parameters: {} as ModelDeployment['parameters'] };

function DeploymentsSection() {
  const qc = useQueryClient();
  const { data: deployments = [] } = useQuery({ queryKey: ['lab-deployments'], queryFn: labApi.deployments });
  const { data: models } = useLabModels();
  const [draft, setDraft] = useState(emptyDeployment);
  const [error, setError] = useState<string | null>(null);
  const model = models?.models.find((m) => m.ref === draft.model);
  const save = useMutation({
    mutationFn: () => labApi.saveDeployment(draft),
    onSuccess: () => {
      setDraft(emptyDeployment);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['lab-deployments'] });
      void qc.invalidateQueries({ queryKey: ['lab-models'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: labApi.deleteDeployment,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lab-deployments'] }),
  });
  const setParam = (p: Partial<ModelDeployment['parameters']>) => setDraft((d) => ({ ...d, parameters: { ...d.parameters, ...p } }));
  return (
    <>
      <Title title="Deployments">
        A deployment is a named model configuration. Select <span className="font-mono">deployment/&lt;name&gt;</span> as the model anywhere (chat, Code Agent, API) and the Gateway applies it.
      </Title>
      <div className="grid gap-3 rounded-2xl border border-line bg-surface/60 p-4 md:grid-cols-2">
        <Field label="Name" hint="lowercase letters, digits and dashes">
          <input className={cn(inputClass, 'font-mono')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="support-bot" data-testid="deployment-name" />
        </Field>
        <Field label="Model">
          <ModelSelect value={draft.model || ''} includeAuto={false} onChange={(v) => setDraft({ ...draft, model: v })} />
        </Field>
        {(!model || model.supportedParameters?.includes('temperature') !== false) && (
          <Field label={`Temperature ${draft.parameters.temperature ?? 'default'}`}>
            <input type="range" min={0} max={2} step={0.1} value={draft.parameters.temperature ?? 0.7} onChange={(e) => setParam({ temperature: Number(e.target.value) })} className="accent-violet-500" />
          </Field>
        )}
        <Field label="Max output tokens">
          <input type="number" className={inputClass} min={1} max={32768} placeholder="default" value={draft.parameters.maxOutputTokens ?? ''} onChange={(e) => setParam({ maxOutputTokens: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
        {model?.supportedParameters?.includes('reasoningBudget') && (
          <Field label="Reasoning budget">
            <select className={inputClass} value={draft.parameters.reasoningBudget ?? ''} onChange={(e) => setParam({ reasoningBudget: (e.target.value || undefined) as ReasoningBudget | undefined })}>
              <option value="">Automatic</option>
              {BUDGETS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Description">
          <input className={inputClass} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </Field>
        <div className="col-span-full">
          <Field label="System prompt">
            <textarea className={cn(inputClass, 'min-h-20 text-xs leading-5')} value={draft.parameters.systemPrompt ?? ''} onChange={(e) => setParam({ systemPrompt: e.target.value || undefined })} />
          </Field>
        </div>
        {error && <p className="col-span-full text-xs text-rose-500">{error}</p>}
        <div className="col-span-full flex justify-end">
          <Button variant="primary" size="md" disabled={!draft.name || !draft.model || save.isPending} onClick={() => save.mutate()} data-testid="save-deployment">
            <Rocket className="size-4" /> Save deployment
          </Button>
        </div>
      </div>
      <div className="mt-6 flex flex-col gap-2">
        {deployments.map((d) => (
          <div key={d.id} className="flex items-center gap-3 rounded-2xl border border-line bg-surface/60 px-4 py-3" data-testid="deployment">
            <StatusDot status={d.status === 'active' ? 'ready' : 'cancelled'} />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-sm text-ink">deployment/{d.name}</div>
              <div className="truncate text-xs text-muted">
                {d.model}
                {d.parameters.temperature !== undefined ? ` · t=${d.parameters.temperature}` : ''}
                {d.parameters.reasoningBudget ? ` · reasoning ${d.parameters.reasoningBudget}` : ''}
                {d.description ? ` · ${d.description}` : ''}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setDraft({ name: d.name, model: d.model, description: d.description, status: d.status, parameters: d.parameters })}>
              Edit
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => remove.mutate(d.name)} aria-label={`Delete ${d.name}`}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
