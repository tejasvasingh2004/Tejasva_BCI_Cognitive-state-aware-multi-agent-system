import { z } from 'zod';
import type { JsonSchema, ToolDescriptor } from '@neuroflow/contracts';
import type { ToolDefinition } from './types';

const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

export type ToolSpec = { name: string; description: string; inputSchema: JsonSchema };

export class ToolRegistry {
  private readonly tools = new Map<string, { def: ToolDefinition; schema: JsonSchema }>();

  register(def: ToolDefinition<z.ZodType, unknown>): this {
    if (!NAME_RE.test(def.name)) throw new Error(`Invalid tool name "${def.name}"`);
    if (this.tools.has(def.name)) throw new Error(`Tool "${def.name}" is already registered`);
    if (def.timeoutMs <= 0) throw new Error(`Tool "${def.name}" must declare a positive timeout`);
    this.tools.set(def.name, { def, schema: toJsonSchema(def.input) });
    return this;
  }

  registerAll(defs: ToolDefinition<z.ZodType, unknown>[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.def;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tools for an ordinary run (no repository) or a code run, optionally read-only (no side effects). */
  namesFor(opts: { code: boolean; readOnly?: boolean }): string[] {
    return [...this.tools.values()]
      .filter(({ def }) => (opts.code ? true : !def.requiresWorkspace))
      .filter(({ def }) => (opts.readOnly ? !def.sideEffects : true))
      .map(({ def }) => def.name);
  }

  describe(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ def, schema }) => ({
      name: def.name,
      description: def.description,
      inputSchema: schema,
      riskLevel: def.riskLevel,
      requiresApproval: def.requiresApproval,
      sideEffects: def.sideEffects,
      permissions: def.permissions,
      timeoutMs: def.timeoutMs,
      ...(def.requiresWorkspace ? { requiresWorkspace: true } : {}),
    }));
  }

  /** Tool specs (JSON Schema contracts) for the given allow-list, as offered to models. */
  specs(allowed: readonly string[]): ToolSpec[] {
    return allowed
      .map((n) => this.tools.get(n))
      .filter((t): t is { def: ToolDefinition; schema: JsonSchema } => Boolean(t))
      .map(({ def, schema }) => ({ name: def.name, description: def.description, inputSchema: schema }));
  }
}

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as JsonSchema;
  const { $schema: _drop, ...rest } = json;
  return rest;
}
