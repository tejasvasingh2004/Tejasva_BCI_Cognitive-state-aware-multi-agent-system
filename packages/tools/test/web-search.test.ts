import { describe, expect, it } from 'vitest';
import {
  BraveSearchProvider,
  createWebSearchTool,
  SearxngSearchProvider,
  TavilySearchProvider,
  ToolRegistry,
  ToolRuntime,
  webSearchProviderFromEnv,
} from '../src';

type Captured = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const ctx = (scopes = ['tools:execute']) => ({
  runId: 'r1',
  workspaceId: 'w1',
  userId: 'u1',
  scopes,
  signal: new AbortController().signal,
  emit: () => {},
  allowedTools: ['web_search'],
});

describe('web_search', () => {
  it('normalises Tavily, Brave and SearXNG responses', async () => {
    const cap: Captured[] = [];
    const tavily = new TavilySearchProvider({
      apiKey: 'tvly-secret',
      fetchImpl: fakeFetch(200, { results: [{ title: '<b>Node 24</b>', url: 'https://nodejs.org', content: 'Released  today' }] }, cap),
    });
    expect(await tavily.search('node', { limit: 3, signal: new AbortController().signal })).toEqual([
      { title: 'Node 24', url: 'https://nodejs.org', snippet: 'Released today' },
    ]);
    expect(JSON.parse(String(cap[0]!.init.body))).toMatchObject({ query: 'node', max_results: 3 });
    expect(new Headers(cap[0]!.init.headers).get('authorization')).toBe('Bearer tvly-secret');

    const brave = new BraveSearchProvider({
      apiKey: 'b',
      fetchImpl: fakeFetch(200, { web: { results: [{ title: 'T', url: 'https://x.dev', description: 'D', age: '2 days' }] } }, cap),
    });
    expect(await brave.search('q', { limit: 2, signal: new AbortController().signal })).toEqual([
      { title: 'T', url: 'https://x.dev', snippet: 'D', publishedAt: '2 days' },
    ]);
    expect(cap[1]!.url).toContain('count=2');

    const searx = new SearxngSearchProvider({
      baseUrl: 'http://searx.local/',
      fetchImpl: fakeFetch(200, { results: [1, 2, 3].map((i) => ({ title: `R${i}`, url: `https://r${i}.io`, content: 'c' })) }),
    });
    expect(await searx.search('q', { limit: 2, signal: new AbortController().signal })).toHaveLength(2);
  });

  it('runs through the tool runtime: validated, bounded, only http(s) URLs', async () => {
    const provider = {
      id: 'stub',
      search: async () => [
        { title: 'ok', url: 'https://good.example', snippet: 's' },
        { title: 'bad', url: 'javascript:alert(1)', snippet: 's' },
      ],
    };
    const runtime = new ToolRuntime(new ToolRegistry().register(createWebSearchTool(provider)));
    const ok = await runtime.execute({ id: 'c1', name: 'web_search', arguments: '{"query":"latest node"}' }, ctx());
    expect(ok.status).toBe('success');
    expect(ok.data).toEqual({ provider: 'stub', count: 1, results: [{ title: 'ok', url: 'https://good.example', snippet: 's' }] });

    const invalid = await runtime.execute({ id: 'c2', name: 'web_search', arguments: '{"query":""}' }, ctx());
    expect(invalid.error?.code).toBe('invalid_arguments');
    const denied = await runtime.execute({ id: 'c3', name: 'web_search', arguments: '{"query":"x y"}' }, ctx([]));
    expect(denied.error?.code).toBe('unauthorized');
  });

  it('maps provider outages to retryable errors without leaking the key', async () => {
    const runtime = new ToolRuntime(
      new ToolRegistry().register(createWebSearchTool(new TavilySearchProvider({ apiKey: 'tvly-secret', fetchImpl: fakeFetch(503, {}) }))),
    );
    const res = await runtime.execute({ id: 'c1', name: 'web_search', arguments: '{"query":"news today"}' }, ctx());
    expect(res.status).toBe('error');
    expect(JSON.stringify(res)).not.toContain('tvly-secret');
    expect(res.attempts).toBe(2);
  });

  it('is only enabled when configured', () => {
    expect(webSearchProviderFromEnv({})).toBeUndefined();
    expect(webSearchProviderFromEnv({ TAVILY_API_KEY: 'k' })?.id).toBe('tavily');
    expect(webSearchProviderFromEnv({ WEB_SEARCH_PROVIDER: 'brave', TAVILY_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'b' })?.id).toBe('brave');
    expect(webSearchProviderFromEnv({ SEARXNG_URL: 'http://s' })?.id).toBe('searxng');
  });
});
