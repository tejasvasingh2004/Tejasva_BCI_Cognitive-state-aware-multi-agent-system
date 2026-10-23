import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Bot, Building2, Check, Copy, KeyRound, LogOut, Monitor, Moon, Plug, Plus, ScrollText, ShieldCheck, Sun, Trash2, Webhook } from 'lucide-react';
import { formatUsd, type AgentSpec, type ProviderKeyInfo } from '@neuroflow/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';
import { keys, useAgents, useApiKeys, useAudit, useSession, useSettings, useTools } from '@/hooks/queries';
import { useUi } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { WebhooksTab } from './WebhooksTab';

type Tab = 'general' | 'workspace' | 'agents' | 'providers' | 'webhooks' | 'keys' | 'audit';

const input =
  'w-full rounded-2xl border border-line bg-surface/80 px-3.5 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-accent/50';

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const { data: me } = useSession();
  const isAdmin = Boolean(me?.scopes.includes('admin'));
  const [tab, setTab] = useState<Tab>('general');

  const tabs: Array<{ id: Tab; label: string; icon: typeof Bell; admin?: boolean }> = [
    { id: 'general', label: 'General', icon: Sun },
    { id: 'workspace', label: 'Workspace', icon: Building2 },
    { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'providers', label: 'Model providers', icon: Plug },
    { id: 'webhooks', label: 'Webhooks', icon: Webhook },
    { id: 'keys', label: 'API keys', icon: KeyRound },
    { id: 'audit', label: 'Audit log', icon: ScrollText, admin: true },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen} title="Settings" className="w-[min(860px,calc(100vw-32px))]">
      <div className="flex min-h-[460px] flex-col gap-4 md:flex-row" data-testid="settings">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col" aria-label="Settings sections">
          {tabs
            .filter((t) => !t.admin || isAdmin)
            .map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex items-center gap-2.5 whitespace-nowrap rounded-2xl px-3 py-2 text-sm transition',
                  tab === t.id ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:bg-surface/60 hover:text-ink',
                )}
              >
                <t.icon className={cn('size-4', tab === t.id ? 'text-accent' : 'text-faint')} />
                {t.label}
              </button>
            ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
          {tab === 'general' && <GeneralTab authMode={me?.authMode} />}
          {tab === 'workspace' && <WorkspaceTab />}
          {tab === 'agents' && <AgentsTab />}
          {tab === 'providers' && <ProviderKeysTab />}
          {tab === 'webhooks' && <WebhooksTab />}
          {tab === 'keys' && <ApiKeysTab />}
          {tab === 'audit' && isAdmin && <AuditTab />}
        </div>
      </div>
    </Dialog>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-0.5 text-xs leading-5 text-muted">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function GeneralTab({ authMode }: { authMode?: 'dev' | 'production' }) {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const qc = useQueryClient();
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  const options = [
    { id: 'light' as const, label: 'Light', icon: Sun },
    { id: 'dark' as const, label: 'Dark', icon: Moon },
    { id: 'system' as const, label: 'System', icon: Monitor },
  ];
  return (
    <>
      <Section title="Appearance">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {options.map((o) => (
            <button
              key={o.id}
              role="radio"
              aria-checked={theme === o.id}
              onClick={() => setTheme(o.id)}
              className={cn(
                'flex flex-col items-center gap-2 rounded-2xl border p-4 text-sm transition',
                theme === o.id ? 'border-accent/40 bg-violet-soft text-ink' : 'border-line bg-surface/50 text-muted hover:text-ink',
              )}
            >
              <o.icon className="size-5" />
              {o.label}
            </button>
          ))}
        </div>
      </Section>
      <Section
        title="Desktop notifications"
        description="Get notified when a long task finishes while NeuroFlow is in the background. In Cognitive Mode, notifications are reduced when you are busy."
      >
        {permission === 'granted' ? (
          <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="size-4" /> Enabled
          </p>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={permission === 'denied'}
            onClick={() => void Notification.requestPermission().then(setPermission)}
          >
            <Bell className="size-3.5" /> {permission === 'denied' ? 'Blocked by the browser' : 'Enable notifications'}
          </Button>
        )}
      </Section>
      {authMode === 'production' && (
        <Section title="Account">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void api.logout().then(() => {
                qc.clear();
                window.location.assign('/');
              })
            }
          >
            <LogOut className="size-3.5" /> Sign out
          </Button>
        </Section>
      )}
    </>
  );
}

const RETENTION = [
  { value: null, label: 'Keep until deleted' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '180 days' },
  { value: 365, label: '1 year' },
];

function WorkspaceTab() {
  const { data } = useSettings();
  const qc = useQueryClient();
  const [instructions, setInstructions] = useState('');
  const [retention, setRetention] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) {
      setInstructions(data.settings.instructions);
      setRetention(data.settings.memoryRetentionDays);
    }
  }, [data]);
  const canEdit = data?.canEdit ?? false;

  const save = async () => {
    setError(null);
    try {
      const res = await api.updateSettings({ instructions, memoryRetentionDays: retention });
      qc.setQueryData(keys.settings, res);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save settings');
    }
  };

  return (
    <>
      <Section title="Workspace instructions" description="Included (bounded) in every task in this workspace — e.g. tone, terminology, standards.">
        <textarea
          className={cn(input, 'min-h-32 resize-y leading-6')}
          maxLength={4000}
          disabled={!canEdit}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Always answer in British English. Our product is called Orchid."
          data-testid="workspace-instructions"
        />
      </Section>
      <Section title="Memory retention" description="Memories older than this are forgotten automatically. Changes apply to existing memories.">
        <select
          className={cn(input, 'w-auto rounded-full')}
          disabled={!canEdit}
          value={retention ?? ''}
          onChange={(e) => setRetention(e.target.value ? Number(e.target.value) : null)}
        >
          {RETENTION.map((r) => (
            <option key={r.label} value={r.value ?? ''}>
              {r.label}
            </option>
          ))}
        </select>
      </Section>
      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" onClick={() => void save()}>
            Save changes
          </Button>
          {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>}
          {error && <span className="text-xs text-rose-500">{error}</span>}
        </div>
      ) : (
        <p className="text-xs text-muted">Only workspace admins can change these settings.</p>
      )}
    </>
  );
}

const emptyAgent = (): Omit<AgentSpec, 'builtin'> => ({
  id: '',
  name: '',
  description: '',
  instructions: '',
  capabilities: [],
  tools: [],
  modelRole: 'agent',
  maxIterations: 4,
});

function AgentsTab() {
  const { data } = useAgents();
  const { data: tools = [] } = useTools();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Omit<AgentSpec, 'builtin'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = data?.canEdit ?? false;

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      await api.saveAgent(draft);
      await qc.invalidateQueries({ queryKey: keys.agents });
      setDraft(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the agent');
    }
  };

  if (draft) {
    const set = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });
    return (
      <Section title={draft.id && data?.agents.some((a) => a.id === draft.id) ? `Edit ${draft.name}` : 'New agent'}>
        <div className="grid gap-3 sm:grid-cols-2">
          <input className={input} placeholder="id (e.g. code-reviewer)" value={draft.id} onChange={(e) => set({ id: e.target.value.toLowerCase() })} />
          <input className={input} placeholder="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <input className={cn(input, 'mt-3')} placeholder="What it is good at (shown to the supervisor)" value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        <textarea className={cn(input, 'mt-3 min-h-28 leading-6')} placeholder="Instructions" value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })} />
        <input
          className={cn(input, 'mt-3')}
          placeholder="Capabilities, comma separated"
          value={draft.capabilities.join(', ')}
          onChange={(e) => set({ capabilities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {tools.map((t) => {
            const on = draft.tools.includes(t.name);
            return (
              <button
                key={t.name}
                onClick={() => set({ tools: on ? draft.tools.filter((x) => x !== t.name) : [...draft.tools, t.name] })}
                className={cn('rounded-full border px-3 py-1 text-xs', on ? 'border-accent/40 bg-violet-soft text-ink' : 'border-line text-muted')}
              >
                {t.name}
              </button>
            );
          })}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <select className={input} value={draft.modelRole} onChange={(e) => set({ modelRole: e.target.value as AgentSpec['modelRole'] })}>
            <option value="agent">General model</option>
            <option value="research">Research model</option>
            <option value="analysis">Analysis model</option>
            <option value="synthesis">Writing model</option>
          </select>
          <select
            className={input}
            value={draft.outputContract?.format ?? ''}
            onChange={(e) =>
              set({ outputContract: e.target.value ? { format: e.target.value as 'markdown' | 'text' | 'json', ...(draft.outputContract?.description ? { description: draft.outputContract.description } : {}) } : undefined })
            }
          >
            <option value="">Any output</option>
            <option value="markdown">Markdown</option>
            <option value="text">Plain text</option>
            <option value="json">JSON</option>
          </select>
          <input
            className={input}
            type="number"
            min={1}
            max={10}
            value={draft.maxIterations}
            onChange={(e) => set({ maxIterations: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
            aria-label="Max iterations"
          />
        </div>
        {error && <p className="mt-3 text-xs text-rose-500">{error}</p>}
        <div className="mt-4 flex gap-2">
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={!draft.id || !draft.name || !draft.instructions}>
            Save agent
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="Agents"
      description="Agents are roles, not models — NeuroFlow picks the model per run. Choose an agent in the composer, or let the supervisor delegate to it."
    >
      {canEdit && (
        <Button variant="outline" size="sm" className="mb-3" onClick={() => setDraft(emptyAgent())}>
          <Plus className="size-3.5" /> New agent
        </Button>
      )}
      <div className="space-y-2">
        {data?.agents.map((a) => (
          <div key={a.id} className="flex items-start gap-3 rounded-2xl border border-line bg-surface/50 p-3">
            <Bot className="mt-0.5 size-4 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                {a.name}
                <span className="rounded-full bg-violet-soft px-2 text-[10px] font-normal text-accent">{a.builtin ? 'built-in' : 'custom'}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted">{a.description}</p>
              {a.capabilities.length > 0 && <p className="mt-1 text-[11px] text-faint">{a.capabilities.join(' · ')}</p>}
            </div>
            {!a.builtin && canEdit && (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setDraft({ ...a })}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${a.name}`}
                  onClick={() => void api.deleteAgent(a.id).then(() => qc.invalidateQueries({ queryKey: keys.agents }))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

const KEY_SCOPES = [
  { id: 'runs:read', label: 'Read runs' },
  { id: 'runs:write', label: 'Start runs' },
  { id: 'tools:execute', label: 'Use tools' },
  { id: 'memory:read', label: 'Read memory' },
  { id: 'memory:write', label: 'Write memory' },
];

/**
 * Bring your own provider keys. A key is checked with the provider before it is saved and is never
 * shown again — only its last four characters.
 */
function ProviderKeysTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: keys.providerKeys, queryFn: api.providerKeys });
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providers = data?.providers ?? [];
  const chosen = provider || providers[0]?.id || '';

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: keys.providerKeys }), qc.invalidateQueries({ queryKey: keys.models })]);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    act('save', async () => {
      await api.createProviderKey({ provider: chosen, apiKey: apiKey.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
      setApiKey('');
      setLabel('');
    });

  if (isLoading || !data) return <p className="text-xs text-muted">Loading…</p>;
  return (
    <>
      <Section
        title="Use your own provider accounts"
        description={
          data.platformKeysEnabled
            ? 'Add a key and runs call that provider with it, billed to your provider account. Providers without your key use NeuroFlow\'s key.'
            : 'This deployment runs models only with your own keys: add a key for each provider you want to use.'
        }
      >
        <div className="space-y-2" data-testid="provider-list">
          {providers.map((p) => {
            const mine = data.keys.filter((k) => k.provider === p.id);
            const active = mine.find((k) => k.status === 'active');
            const source = active ? `Using your key …${active.hint}` : p.platformKey && data.platformKeysEnabled ? 'Using NeuroFlow\'s key' : 'No key: add one to use these models';
            return (
              <div key={p.id} className="rounded-2xl border border-line bg-surface/50 p-3" data-testid={`provider-${p.id}`}>
                <div className="flex items-center gap-2">
                  <Plug className="size-4 text-faint" />
                  <span className="text-sm font-medium text-ink">{p.displayName}</span>
                  <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[11px]', active ? 'bg-mint-soft text-emerald-700 dark:text-emerald-300' : 'bg-surface text-muted')} data-testid={`provider-source-${p.id}`}>
                    {source}
                  </span>
                </div>
                {mine.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {mine.map((k) => (
                      <div key={k.id} className="flex items-center gap-2 rounded-xl bg-surface/60 px-3 py-2 text-xs" data-testid="provider-key-row">
                        <ShieldCheck className={cn('size-3.5', k.status === 'active' ? 'text-emerald-600' : 'text-rose-500')} />
                        <span className="text-ink">{k.label}</span>
                        <code className="text-faint">…{k.hint}</code>
                        <span className={cn('truncate', k.status === 'active' ? 'text-faint' : 'text-rose-500')}>
                          {k.status === 'active' ? (k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : 'not used yet') : (k.lastError ?? 'invalid')}
                        </span>
                        <KeyBudget k={k} canEdit={data.canEdit} disabled={busy !== null} onSave={(v) => act(k.id, () => api.updateProviderKey(k.id, { monthlyBudgetUsd: v }))} />
                        {data.canEdit && (
                          <span className="flex shrink-0 gap-1">
                            <Button variant="ghost" size="sm" className="h-7" disabled={busy !== null} onClick={() => void act(k.id, () => api.verifyProviderKey(k.id))} data-testid="provider-key-verify">
                              Check
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7" disabled={busy !== null} onClick={() => void act(k.id, () => api.deleteProviderKey(k.id))} data-testid="provider-key-delete">
                              <Trash2 className="size-3.5" />
                            </Button>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
      {data.canEdit && providers.length > 0 && (
        <Section title="Add a key" description="The key is checked with the provider, encrypted, and never shown again.">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)]">
            <select className={input} value={chosen} onChange={(e) => setProvider(e.target.value)} aria-label="Provider" data-testid="provider-key-provider">
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <input
              className={input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Provider API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-label="Provider API key"
              data-testid="provider-key-input"
            />
          </div>
          <div className="mt-2 flex gap-2">
            <input className={input} placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" />
            <Button variant="primary" size="md" disabled={apiKey.trim().length < 8 || busy !== null} onClick={() => void save()} data-testid="provider-key-save">
              {busy === 'save' ? 'Checking…' : 'Check and save'}
            </Button>
          </div>
        </Section>
      )}
      {error && (
        <p className="text-xs text-rose-500" role="alert" data-testid="provider-key-error">
          {error}
        </p>
      )}
    </>
  );
}

/** This month's spend through a key and its optional monthly budget, editable by admins. */
function KeyBudget({ k, canEdit, disabled, onSave }: { k: ProviderKeyInfo; canEdit: boolean; disabled: boolean; onSave: (v: number | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(k.monthlyBudgetUsd?.toString() ?? '');
  const over = k.monthlyBudgetUsd !== null && k.spendThisMonthUsd >= k.monthlyBudgetUsd;
  const label = `${formatUsd(k.spendThisMonthUsd)}${k.monthlyBudgetUsd !== null ? ` / ${formatUsd(k.monthlyBudgetUsd)}` : ''} this month`;
  if (editing) {
    const parsed = value.trim() === '' ? null : Math.round(Number(value) * 100) / 100;
    const valid = parsed === null || (Number.isFinite(parsed) && parsed > 0);
    return (
      <span className="ml-auto flex items-center gap-1">
        <span className="text-faint">$</span>
        <input
          className="h-7 w-20 rounded-lg border border-line bg-surface px-2 text-xs text-ink"
          inputMode="decimal"
          placeholder="No limit"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Monthly budget (USD)"
          data-testid="provider-key-budget-input"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          disabled={!valid || disabled}
          onClick={() => void onSave(parsed).then(() => setEditing(false))}
          data-testid="provider-key-budget-save"
        >
          Save
        </Button>
      </span>
    );
  }
  return (
    <span className="ml-auto flex items-center gap-1">
      <span className={cn('whitespace-nowrap', over ? 'text-rose-500' : 'text-faint')} data-testid="provider-key-spend">
        {over ? `Budget reached: ${label}` : label}
      </span>
      {canEdit && (
        <Button variant="ghost" size="sm" className="h-7" disabled={disabled} onClick={() => setEditing(true)} data-testid="provider-key-budget">
          {k.monthlyBudgetUsd === null ? 'Set budget' : 'Budget'}
        </Button>
      )}
    </span>
  );
}

function ApiKeysTab() {
  const { data: apiKeys = [] } = useApiKeys();
  const { data: me } = useSession();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['runs:read', 'runs:write', 'tools:execute', 'memory:read']);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = KEY_SCOPES.filter((s) => me?.scopes.includes(s.id));

  const create = async () => {
    setError(null);
    try {
      const { apiKey } = await api.createApiKey(name.trim(), scopes.filter((s) => me?.scopes.includes(s)));
      setCreated(apiKey.key);
      setName('');
      await qc.invalidateQueries({ queryKey: keys.apiKeys });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create the key');
    }
  };

  return (
    <>
      <Section title="Create an API key" description="Use keys with the NeuroFlow API or any OpenAI-compatible client (base URL /v1).">
        <div className="flex gap-2">
          <input className={input} placeholder="Key name (e.g. CI pipeline)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="primary" size="md" disabled={!name.trim()} onClick={() => void create()}>
            Create
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {available.map((s) => {
            const on = scopes.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() => setScopes(on ? scopes.filter((x) => x !== s.id) : [...scopes, s.id])}
                className={cn('rounded-full border px-3 py-1 text-xs', on ? 'border-accent/40 bg-violet-soft text-ink' : 'border-line text-muted')}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
        {created && (
          <div className="mt-3 rounded-2xl border border-emerald-200 bg-mint-soft p-3 dark:border-emerald-900" data-testid="created-key">
            <p className="text-xs text-emerald-700 dark:text-emerald-300">Copy this key now — it will not be shown again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-xl bg-surface px-3 py-2 text-xs text-ink">{created}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(created).then(() => setCopied(true))}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        )}
      </Section>
      <Section title="Your keys">
        {apiKeys.length === 0 && <p className="text-xs text-muted">No keys yet.</p>}
        <div className="space-y-2">
          {apiKeys.map((k) => (
            <div key={k.id} className={cn('flex items-center gap-3 rounded-2xl border border-line bg-surface/50 p-3', k.revokedAt && 'opacity-50')}>
              <KeyRound className="size-4 text-faint" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">
                  {k.name} <code className="ml-1 text-xs text-faint">{k.prefix}…</code>
                </div>
                <div className="text-[11px] text-faint">
                  {k.scopes.join(', ')} · created {relativeTime(k.createdAt)}
                  {k.lastUsedAt ? ` · used ${relativeTime(k.lastUsedAt)}` : ' · never used'}
                  {k.revokedAt ? ' · revoked' : ''}
                </div>
              </div>
              {!k.revokedAt && (
                <Button variant="ghost" size="sm" onClick={() => void api.revokeApiKey(k.id).then(() => qc.invalidateQueries({ queryKey: keys.apiKeys }))}>
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function AuditTab() {
  const { data: events = [], isLoading } = useAudit();
  return (
    <Section title="Audit log" description="Security-relevant actions in this workspace. Never contains secrets or message content.">
      {isLoading && <p className="text-xs text-muted">Loading…</p>}
      <ol className="space-y-1.5" data-testid="audit-log">
        {events.map((e) => (
          <li key={e.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-xs hover:bg-surface/60">
            <span className={cn('size-1.5 shrink-0 rounded-full', e.outcome === 'success' ? 'bg-emerald-400' : 'bg-rose-400')} />
            <code className="text-ink">{e.action}</code>
            {e.targetType && <span className="truncate text-faint">{e.targetType}{e.targetId ? ` ${e.targetId.slice(0, 8)}` : ''}</span>}
            <span className="ml-auto shrink-0 text-faint">{relativeTime(e.createdAt)}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
