import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import type { WebhookDelivery, WebhookEndpoint, WebhookEventType } from '@neuroflow/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { keys } from '@/hooks/queries';
import { cn, relativeTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const input =
  'w-full rounded-2xl border border-line bg-surface/80 px-3.5 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-accent/50';

const EVENT_LABELS: Record<WebhookEventType, string> = {
  'run.completed': 'Run completed',
  'run.failed': 'Run failed',
  'run.cancelled': 'Run cancelled',
  'run.approval_requested': 'Approval requested',
  'budget.threshold_reached': 'Budget alert',
  'budget.exceeded': 'Budget exceeded',
};

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-0.5 text-xs leading-5 text-muted">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Webhook endpoints, the signing secret and recent deliveries. */
export function WebhooksTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: keys.webhooks,
    queryFn: api.webhooks,
    // While a delivery is in flight the endpoint's last-delivery badge follows it.
    refetchInterval: (q) => (q.state.data?.endpoints.some((e) => e.lastDelivery && ['pending', 'delivering'].includes(e.lastDelivery.status)) ? 2_000 : false),
  });
  const deliveries = useQuery({ queryKey: keys.webhookDeliveries, queryFn: () => api.webhookDeliveries(20).then((r) => r.deliveries), enabled: Boolean(data?.canEdit), refetchInterval: 5_000 });
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: keys.webhooks }), qc.invalidateQueries({ queryKey: keys.webhookDeliveries })]);
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

  if (isLoading || !data) return <p className="text-xs text-muted">Loading…</p>;
  const toggle = (e: WebhookEventType) => setEvents(events.includes(e) ? events.filter((x) => x !== e) : [...events, e]);

  return (
    <>
      <Section
        title="Webhooks"
        description="NeuroFlow posts run outcomes, approval requests and budget alerts to your URLs, signed with the Standard Webhooks scheme. Runs can also name their own callback URL (webhookUrl) for async use."
      >
        <div className="space-y-2" data-testid="webhook-list">
          {data.endpoints.length === 0 && <p className="text-xs text-faint">No endpoints yet.</p>}
          {data.endpoints.map((e) => (
            <EndpointRow key={e.id} endpoint={e} canEdit={data.canEdit} busy={busy !== null} act={act} />
          ))}
        </div>
      </Section>

      {data.canEdit && (
        <Section title="Add an endpoint" description="https URLs only. Choose events, or none for all of them.">
          <div className="flex gap-2">
            <input className={input} placeholder="https://example.com/neuroflow/webhooks" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Endpoint URL" data-testid="webhook-url" />
            <Button
              variant="primary"
              size="md"
              disabled={!url.trim() || busy !== null}
              onClick={() =>
                void act('create', async () => {
                  await api.createWebhook({ url: url.trim(), eventTypes: events });
                  setUrl('');
                  setEvents([]);
                })
              }
              data-testid="webhook-add"
            >
              Add
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {data.eventTypes.map((t) => (
              <button
                key={t}
                onClick={() => toggle(t)}
                className={cn('rounded-full border px-3 py-1 text-xs', events.includes(t) ? 'border-accent/40 bg-violet-soft text-ink' : 'border-line text-muted')}
                aria-pressed={events.includes(t)}
                data-testid={`webhook-event-${t}`}
              >
                {EVENT_LABELS[t]}
              </button>
            ))}
          </div>
        </Section>
      )}

      {data.canEdit && (
        <Section
          title="Signing secret"
          description={
            data.secret
              ? `Verify each delivery with this secret (ends in …${data.secret.hint}). After rotating, the old secret keeps signing for 24 hours.`
              : 'Created with the first endpoint or async run.'
          }
        >
          {secret ? (
            <div className="flex items-center gap-2" data-testid="webhook-secret">
              <code className="min-w-0 flex-1 truncate rounded-xl bg-surface px-3 py-2 text-xs text-ink">{secret}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(secret);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
          ) : (
            data.secret && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act('reveal', async () => setSecret((await api.webhookSecret()).secret))} data-testid="webhook-secret-reveal">
                  Show secret
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act('rotate', async () => setSecret((await api.rotateWebhookSecret()).secret))} data-testid="webhook-secret-rotate">
                  <RefreshCw className="size-3.5" /> Rotate
                </Button>
              </div>
            )
          )}
        </Section>
      )}

      {data.canEdit && (deliveries.data?.length ?? 0) > 0 && (
        <Section title="Recent deliveries">
          <div className="space-y-1" data-testid="webhook-deliveries">
            {deliveries.data!.map((d) => (
              <DeliveryRow key={d.id} delivery={d} busy={busy !== null} onRetry={() => void act(d.id, () => api.retryWebhookDelivery(d.id))} />
            ))}
          </div>
        </Section>
      )}
      {error && (
        <p className="text-xs text-rose-500" role="alert" data-testid="webhook-error">
          {error}
        </p>
      )}
    </>
  );
}

function EndpointRow({ endpoint: e, canEdit, busy, act }: { endpoint: WebhookEndpoint; canEdit: boolean; busy: boolean; act: (id: string, fn: () => Promise<unknown>) => Promise<void> }) {
  return (
    <div className="rounded-2xl border border-line bg-surface/50 p-3" data-testid="webhook-row">
      <div className="flex items-center gap-2">
        <Webhook className={cn('size-4', e.enabled ? 'text-accent' : 'text-faint')} />
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{e.url}</span>
        {canEdit && (
          <span className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" className="h-7" disabled={busy || !e.enabled} onClick={() => void act(e.id, () => api.testWebhook(e.id))} data-testid="webhook-test">
              <Send className="size-3.5" /> Test
            </Button>
            <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => void act(e.id, () => api.updateWebhook(e.id, { enabled: !e.enabled }))} data-testid="webhook-toggle">
              {e.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => void act(e.id, () => api.deleteWebhook(e.id))} data-testid="webhook-delete">
              <Trash2 className="size-3.5" />
            </Button>
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        {(e.eventTypes.length ? e.eventTypes : ['all events']).map((t) => (
          <span key={t} className="rounded-full bg-surface px-2 py-0.5">
            {EVENT_LABELS[t as WebhookEventType] ?? t}
          </span>
        ))}
        {!e.enabled && <span className="text-amber-600">{e.disabledReason ?? 'paused'}</span>}
        {e.lastDelivery && (
          <span className={cn('ml-auto', e.lastDelivery.status === 'failed' ? 'text-rose-500' : 'text-faint')}>
            last {e.lastDelivery.status}
            {e.lastDelivery.statusCode ? ` (${e.lastDelivery.statusCode})` : ''} {relativeTime(e.lastDelivery.at)}
          </span>
        )}
      </div>
    </div>
  );
}

function DeliveryRow({ delivery: d, busy, onRetry }: { delivery: WebhookDelivery; busy: boolean; onRetry: () => void }) {
  const tone = d.status === 'delivered' ? 'text-emerald-600' : d.status === 'failed' ? 'text-rose-500' : 'text-amber-600';
  return (
    <div className="flex items-center gap-2 rounded-xl bg-surface/60 px-3 py-1.5 text-xs" data-testid="webhook-delivery">
      <span className={cn('w-16 shrink-0 font-medium', tone)}>{d.status}</span>
      <span className="shrink-0 text-ink">{d.eventType}</span>
      <span className="min-w-0 flex-1 truncate text-faint">{d.lastError ?? (d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : d.url)}</span>
      <span className="shrink-0 text-faint">
        {d.attempts > 1 ? `${d.attempts} attempts · ` : ''}
        {relativeTime(d.createdAt)}
      </span>
      {(d.status === 'failed' || d.status === 'delivered') && (
        <Button variant="ghost" size="sm" className="h-6" disabled={busy} onClick={onRetry} data-testid="webhook-redeliver">
          Resend
        </Button>
      )}
    </div>
  );
}
