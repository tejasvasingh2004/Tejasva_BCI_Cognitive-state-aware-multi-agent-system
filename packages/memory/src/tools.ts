import { z } from 'zod';
import { Scopes } from '@neuroflow/contracts';
import { defineTool, type ToolDefinition } from '@neuroflow/tools';
import { MEMORY_LIMITS, type MemoryService } from './service';

/**
 * Memory is exposed to models only as tools, so every retrieval goes through validation,
 * authorization, tracing, timeouts and bounded results like any other capability.
 */
export function createMemoryTools(memory: MemoryService): ToolDefinition<z.ZodType, unknown>[] {
  const searchMemory = defineTool({
    name: 'search_memory',
    description:
      "Search the user's saved memories (past decisions, preferences, facts they asked you to remember). Use when the answer may depend on something the user told you before.",
    input: z.object({
      query: z.string().trim().min(1).max(300).describe('What to look for, in natural language'),
      limit: z.number().int().min(1).max(MEMORY_LIMITS.maxResults).optional(),
    }),
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: false,
    permissions: [Scopes.memoryRead],
    timeoutMs: 5_000,
    maxRetries: 1,
    async execute({ query, limit }, ctx) {
      ctx.emit('memory.started', { query });
      const items = await memory.search({ workspaceId: ctx.workspaceId, userId: ctx.userId, query, limit: limit ?? 5 });
      ctx.emit('memory.completed', { query, count: items.length, memoryIds: items.map((m) => m.id) });
      return {
        count: items.length,
        memories: items.map((m) => ({ id: m.id, content: m.content, tags: m.tags, savedAt: m.createdAt })),
      };
    },
    summarize: (o) => `${o.count} memor${o.count === 1 ? 'y' : 'ies'} found`,
  });

  const saveMemory = defineTool({
    name: 'save_memory',
    description:
      'Save a durable fact, decision or preference the user explicitly wants remembered for future conversations. Do not save secrets or passwords.',
    input: z.object({
      content: z.string().trim().min(3).max(MEMORY_LIMITS.maxStoreChars),
      tags: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
    }),
    riskLevel: 'medium',
    requiresApproval: false,
    sideEffects: true,
    permissions: [Scopes.memoryWrite],
    timeoutMs: 5_000,
    async execute({ content, tags }, ctx) {
      const item = await memory.store({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        content,
        tags,
        source: 'agent',
        sourceRunId: ctx.runId,
      });
      return { id: item.id, saved: true };
    },
    summarize: () => 'Saved to memory',
  });

  const deleteMemory = defineTool({
    name: 'delete_memory',
    description: 'Permanently forget a saved memory by id. Requires the user to approve.',
    input: z.object({ id: z.string().uuid() }),
    riskLevel: 'high',
    requiresApproval: true,
    sideEffects: true,
    permissions: [Scopes.memoryWrite],
    timeoutMs: 5_000,
    async execute({ id }, ctx) {
      const deleted = await memory.delete({ workspaceId: ctx.workspaceId, userId: ctx.userId }, id);
      return { id, deleted };
    },
    summarize: (o) => (o.deleted ? 'Memory deleted' : 'Memory not found'),
  });

  return [searchMemory, saveMemory, deleteMemory] as ToolDefinition<z.ZodType, unknown>[];
}
