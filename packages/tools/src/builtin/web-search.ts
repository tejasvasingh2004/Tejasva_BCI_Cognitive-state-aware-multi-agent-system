import { z } from 'zod';
import { Scopes } from '@neuroflow/contracts';
import { defineTool, ToolExecutionError, type ToolDefinition } from '../types';

export type WebSearchResult = { title: string; url: string; snippet: string; publishedAt?: string };

/** Search backend boundary. Implementations must honour the abort signal and return plain results. */
export interface WebSearchProvider {
  readonly id: string;
  search(query: string, opts: { limit: number; signal: AbortSignal }): Promise<WebSearchResult[]>;
}

type FetchImpl = typeof fetch;

async function getJson(fetchImpl: FetchImpl, url: string, init: RequestInit, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ToolExecutionError(`The ${provider} search service is unreachable`, true);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new ToolExecutionError(`The ${provider} search service is unavailable (${res.status})`, true);
  }
  if (!res.ok) throw new ToolExecutionError(`The ${provider} search service rejected the request (${res.status})`);
  return res.json();
}

const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** https://docs.tavily.com — POST /search */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = 'tavily';
  constructor(private readonly opts: { apiKey: string; baseUrl?: string; fetchImpl?: FetchImpl }) {}

  async search(query: string, { limit, signal }: { limit: number; signal: AbortSignal }) {
    const body = (await getJson(
      this.opts.fetchImpl ?? fetch,
      `${this.opts.baseUrl ?? 'https://api.tavily.com'}/search`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
        signal,
      },
      'Tavily',
    )) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
    return (body.results ?? []).map((r) => ({
      title: clean(r.title, 200),
      url: String(r.url ?? ''),
      snippet: clean(r.content, 500),
      ...(r.published_date ? { publishedAt: r.published_date } : {}),
    }));
  }
}

/** https://api.search.brave.com — GET /res/v1/web/search */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = 'brave';
  constructor(private readonly opts: { apiKey: string; baseUrl?: string; fetchImpl?: FetchImpl }) {}

  async search(query: string, { limit, signal }: { limit: number; signal: AbortSignal }) {
    const url = new URL(`${this.opts.baseUrl ?? 'https://api.search.brave.com'}/res/v1/web/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const body = (await getJson(
      this.opts.fetchImpl ?? fetch,
      url.toString(),
      { headers: { accept: 'application/json', 'x-subscription-token': this.opts.apiKey }, signal },
      'Brave',
    )) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> } };
    return (body.web?.results ?? []).map((r) => ({
      title: clean(r.title, 200),
      url: String(r.url ?? ''),
      snippet: clean(r.description, 500),
      ...(r.age ? { publishedAt: r.age } : {}),
    }));
  }
}

/** Self-hosted SearXNG (no API key): GET /search?format=json */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = 'searxng';
  constructor(private readonly opts: { baseUrl: string; fetchImpl?: FetchImpl }) {}

  async search(query: string, { limit, signal }: { limit: number; signal: AbortSignal }) {
    const url = new URL(`${this.opts.baseUrl.replace(/\/$/, '')}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const body = (await getJson(this.opts.fetchImpl ?? fetch, url.toString(), { signal }, 'SearXNG')) as {
      results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>;
    };
    return (body.results ?? []).slice(0, limit).map((r) => ({
      title: clean(r.title, 200),
      url: String(r.url ?? ''),
      snippet: clean(r.content, 500),
      ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
    }));
  }
}

/**
 * Chooses a provider from configuration: WEB_SEARCH_PROVIDER (tavily | brave | searxng) with
 * TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / SEARXNG_URL. Returns undefined when not configured, in
 * which case the web_search tool is simply not registered.
 */
export function webSearchProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchImpl,
): WebSearchProvider | undefined {
  const pick = env.WEB_SEARCH_PROVIDER?.toLowerCase();
  if ((pick === 'tavily' || !pick) && env.TAVILY_API_KEY) return new TavilySearchProvider({ apiKey: env.TAVILY_API_KEY, fetchImpl });
  if ((pick === 'brave' || !pick) && env.BRAVE_SEARCH_API_KEY) {
    return new BraveSearchProvider({ apiKey: env.BRAVE_SEARCH_API_KEY, fetchImpl });
  }
  if ((pick === 'searxng' || !pick) && env.SEARXNG_URL) return new SearxngSearchProvider({ baseUrl: env.SEARXNG_URL, fetchImpl });
  return undefined;
}

const MAX_RESULTS = 8;

export function createWebSearchTool(provider: WebSearchProvider): ToolDefinition<z.ZodType, unknown> {
  return defineTool({
    name: 'web_search',
    description:
      'Search the public web for current information (news, recent releases, facts that may have changed). Returns titles, URLs and short snippets; cite URLs you rely on.',
    input: z.object({
      query: z.string().trim().min(2).max(300).describe('Search query'),
      limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
    }),
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: false,
    permissions: [Scopes.toolsExecute],
    timeoutMs: 15_000,
    maxRetries: 1,
    maxResultChars: 6_000,
    async execute({ query, limit }, ctx) {
      const results = await provider.search(query, { limit: limit ?? 5, signal: ctx.signal });
      const safe = results
        .filter((r) => /^https?:\/\//i.test(r.url))
        .slice(0, MAX_RESULTS)
        .map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}) }));
      return { provider: provider.id, count: safe.length, results: safe };
    },
    summarize: (o) => `${o.count} web result${o.count === 1 ? '' : 's'}`,
  }) as ToolDefinition<z.ZodType, unknown>;
}
