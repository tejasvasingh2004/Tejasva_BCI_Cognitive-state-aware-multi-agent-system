import type { ToolCall, ToolErrorCode, ToolResult, ToolResultStatus } from '@neuroflow/contracts';
import { Scopes } from '@neuroflow/contracts';
import { runtimeMetrics, withSpan } from '@neuroflow/observability';
import type { ToolRegistry } from './registry';
import {
  ToolExecutionError,
  type ApprovalGate,
  type Prepared,
  type ToolCallRecorder,
  type ToolContext,
  type ToolDefinition,
} from './types';

export type ToolExecutionContext = ToolContext & {
  /** Tools this run may use (execution plan tool policy). */
  allowedTools: readonly string[];
  agentExecutionId?: string;
};

export type ToolRuntimeOptions = {
  approvals?: ApprovalGate;
  recorder?: ToolCallRecorder;
  approvalTimeoutMs?: number;
  defaultMaxResultChars?: number;
  /**
   * Called for errors that are not a ToolExecutionError (bugs, infrastructure). The model only
   * sees a generic message, so this is where operators get the details.
   */
  onUnexpectedError?: (err: unknown, info: { tool: string; phase: 'prepare' | 'execute'; runId: string; toolCallId: string }) => void;
};

/**
 * Executes model-requested tool calls. The model's request is treated as untrusted input:
 * name → registry, arguments → JSON Schema/Zod validation, principal → authorization,
 * risk → approval, then bounded execution and a normalised ToolResult.
 */
export class ToolRuntime {
  private readonly approvalTimeoutMs: number;
  private readonly defaultMaxResultChars: number;

  constructor(
    readonly registry: ToolRegistry,
    private readonly opts: ToolRuntimeOptions = {},
  ) {
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 5 * 60_000;
    this.defaultMaxResultChars = opts.defaultMaxResultChars ?? 8_000;
  }

  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult> {
    return withSpan('tool.execute', { 'tool.name': call.name, 'run.id': ctx.runId }, async (span) => {
      const result = await this.executeInner(call, ctx);
      span.setAttribute('tool.status', result.status);
      runtimeMetrics.toolCalls.add(1, { tool: call.name, status: result.status });
      runtimeMetrics.toolLatency.record(result.durationMs, { tool: call.name });
      return result;
    });
  }

  private async executeInner(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult> {
    const started = Date.now();
    const fail = (status: ToolResultStatus, code: ToolErrorCode, message: string, retryable = false): ToolResult => ({
      toolCallId: call.id,
      name: call.name,
      status,
      error: { code, message, retryable },
      durationMs: Date.now() - started,
      attempts: 1,
      truncated: false,
    });

    // 1. Tool name
    const def = this.registry.get(call.name);
    if (!def) {
      return this.finalize(ctx, fail('error', 'unknown_tool', `Unknown tool "${call.name}"`), undefined);
    }

    // 2. Arguments: parse JSON, then validate against the schema. Never execute raw arguments.
    let raw: unknown;
    try {
      raw = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
    } catch {
      return this.finalize(ctx, fail('error', 'invalid_arguments', 'Arguments are not valid JSON'), def);
    }
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return this.finalize(ctx, fail('error', 'invalid_arguments', `Invalid arguments: ${issues}`), def);
    }
    const args = parsed.data;

    // 3. Authorization. A model asking for a tool is never authorization in itself.
    const missing = [Scopes.toolsExecute, ...def.permissions].filter((s) => !ctx.scopes.includes(s));
    if (!ctx.allowedTools.includes(def.name) || missing.length > 0) {
      return this.finalize(ctx, fail('denied', 'unauthorized', `Not authorized to use tool "${def.name}"`), def);
    }

    // 4. Recovery safety: side-effecting calls that already succeeded are not repeated.
    if (def.sideEffects && this.opts.recorder) {
      const previous = await this.opts.recorder.findCompleted(ctx.runId, call.id);
      if (previous) return previous;
    }

    ctx.emit('tool.started', {
      toolCallId: call.id,
      name: def.name,
      riskLevel: def.riskLevel,
      ...(ctx.agentExecutionId ? { agentExecutionId: ctx.agentExecutionId } : {}),
    });
    // 5a. Optional preparation: compute the proposed change and decide whether it needs approval.
    let prepared: Prepared | undefined;
    if (def.prepare) {
      try {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(def.timeoutMs)]);
        prepared = await raceAbort(def.prepare(args, { ...ctx, signal, toolCallId: call.id }), signal);
      } catch (err) {
        const unexpected = !(err instanceof ToolExecutionError) && !ctx.signal.aborted;
        if (unexpected) this.opts.onUnexpectedError?.(err, { tool: def.name, phase: 'prepare', runId: ctx.runId, toolCallId: call.id });
        const message = err instanceof ToolExecutionError ? err.message : 'Tool preparation failed';
        // tool.started was already emitted; record the call (with its arguments) before finishing it.
        await this.opts.recorder?.start({
          runId: ctx.runId,
          agentExecutionId: ctx.agentExecutionId,
          toolCallId: call.id,
          name: def.name,
          arguments: args,
          riskLevel: def.riskLevel,
          approvalStatus: 'not_required',
        });
        return this.finalize(
          ctx,
          fail(ctx.signal.aborted ? 'cancelled' : 'error', ctx.signal.aborted ? 'cancelled' : 'execution_failed', message),
          def,
          true,
          undefined,
          unexpected ? diagnose(err) : undefined,
        );
      }
    }
    const needsApproval = def.requiresApproval || Boolean(prepared?.approval);

    await this.opts.recorder?.start({
      runId: ctx.runId,
      agentExecutionId: ctx.agentExecutionId,
      toolCallId: call.id,
      name: def.name,
      arguments: args,
      riskLevel: def.riskLevel,
      approvalStatus: needsApproval && prepared?.output === undefined ? 'pending' : 'not_required',
    });

    // 5b. Preparation decided the outcome without executing (e.g. Suggest mode: proposal only).
    if (prepared && prepared.output !== undefined) {
      const bounded = bound(prepared.output, def.maxResultChars ?? this.defaultMaxResultChars);
      return this.finalize(
        ctx,
        { toolCallId: call.id, name: def.name, status: 'success', data: bounded.data, durationMs: Date.now() - started, attempts: 1, truncated: bounded.truncated },
        def,
        true,
        safeSummary(def, prepared.output),
      );
    }

    // 5c. Human approval for consequential tools. Fails closed when no approval channel exists.
    if (needsApproval) {
      const { outcome: decision, reason } = await this.awaitApproval(call, def, args, ctx, prepared?.approval);
      if (prepared && def.onDecision && decision !== 'cancelled') {
        await Promise.resolve(def.onDecision(decision === 'approved', prepared, { ...ctx, toolCallId: call.id })).catch(() => {});
      }
      if (decision !== 'approved') {
        const denied =
          decision === 'cancelled'
            ? fail('cancelled', 'cancelled', 'Run cancelled while awaiting approval')
            : decision === 'timeout'
              ? fail('denied', 'approval_timeout', 'Approval was not given in time')
              : fail(
                  'denied',
                  'approval_denied',
                  // The user's feedback is what lets the model adapt instead of guessing.
                  reason ? `The user declined this action. Their feedback: ${reason.slice(0, 500)}` : 'The user declined this action',
                );
        return this.finalize(ctx, denied, def, true);
      }
    }

    // 6. Execute with timeout; retry only side-effect-free tools on retryable failures.
    const maxAttempts = def.sideEffects ? 1 : 1 + (def.maxRetries ?? 1);
    let attempts = 0;
    let lastError: { status: ToolResultStatus; code: ToolErrorCode; message: string; retryable: boolean } | undefined;
    let diagnostic: string | undefined;
    while (attempts < maxAttempts) {
      attempts++;
      if (ctx.signal.aborted) {
        lastError = { status: 'cancelled', code: 'cancelled', message: 'Run cancelled', retryable: false };
        break;
      }
      const timeout = AbortSignal.timeout(def.timeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeout]);
      try {
        const output = await raceAbort(def.execute(args, { ...ctx, signal, toolCallId: call.id }, prepared), signal);
        const bounded = bound(output, def.maxResultChars ?? this.defaultMaxResultChars);
        const result: ToolResult = {
          toolCallId: call.id,
          name: def.name,
          status: 'success',
          data: bounded.data,
          durationMs: Date.now() - started,
          attempts,
          truncated: bounded.truncated,
        };
        return this.finalize(ctx, result, def, true, safeSummary(def, output));
      } catch (err) {
        if (ctx.signal.aborted) {
          lastError = { status: 'cancelled', code: 'cancelled', message: 'Run cancelled', retryable: false };
          break;
        }
        if (timeout.aborted) {
          lastError = { status: 'timeout', code: 'timeout', message: `Tool timed out after ${def.timeoutMs}ms`, retryable: true };
        } else {
          const retryable = err instanceof ToolExecutionError ? err.retryable : false;
          if (!(err instanceof ToolExecutionError)) {
            this.opts.onUnexpectedError?.(err, { tool: def.name, phase: 'execute', runId: ctx.runId, toolCallId: call.id });
            diagnostic = diagnose(err);
          }
          const message = err instanceof ToolExecutionError ? err.message : 'Tool execution failed';
          lastError = { status: 'error', code: 'execution_failed', message, retryable };
        }
        if (!lastError.retryable) break;
      }
    }
    const e = lastError!;
    return this.finalize(ctx, { ...fail(e.status, e.code, e.message, e.retryable), attempts }, def, true, undefined, diagnostic);
  }

  private async awaitApproval(
    call: ToolCall,
    def: ToolDefinition,
    args: unknown,
    ctx: ToolExecutionContext,
    request?: Prepared['approval'],
  ): Promise<{ outcome: 'approved' | 'denied' | 'timeout' | 'cancelled'; reason?: string }> {
    if (!this.opts.approvals) return { outcome: 'denied' };
    ctx.emit('approval.requested', {
      toolCallId: call.id,
      name: def.name,
      riskLevel: def.riskLevel,
      arguments: args,
      expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
      ...(request?.reason ? { reason: request.reason } : {}),
      ...(request?.preview !== undefined ? { preview: request.preview } : {}),
    });
    let outcome: 'approved' | 'denied' | 'timeout' | 'cancelled';
    let reason: string | undefined;
    try {
      const decision = await this.opts.approvals.wait(ctx.runId, call.id, this.approvalTimeoutMs, ctx.signal);
      if (decision === 'timeout') outcome = 'timeout';
      else {
        outcome = decision.approved ? 'approved' : 'denied';
        reason = decision.reason;
      }
    } catch {
      outcome = 'cancelled';
    }
    if (outcome !== 'cancelled') {
      ctx.emit('approval.resolved', {
        toolCallId: call.id,
        approved: outcome === 'approved',
        ...(reason ? { reason } : {}),
      });
    }
    await this.opts.recorder?.approval(
      ctx.runId,
      call.id,
      outcome === 'approved' ? 'approved' : outcome === 'timeout' ? 'expired' : 'denied',
    );
    return { outcome, ...(reason ? { reason } : {}) };
  }

  private async finalize(
    ctx: ToolExecutionContext,
    result: ToolResult,
    def: ToolDefinition | undefined,
    started = false,
    summary?: string,
    diagnostic?: string,
  ): Promise<ToolResult> {
    if (!started) {
      // Rejected before execution: still observable in the timeline and the database.
      ctx.emit('tool.started', {
        toolCallId: result.toolCallId,
        name: result.name,
        ...(def ? { riskLevel: def.riskLevel } : {}),
        ...(ctx.agentExecutionId ? { agentExecutionId: ctx.agentExecutionId } : {}),
      });
    }
    ctx.emit('tool.completed', {
      toolCallId: result.toolCallId,
      name: result.name,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.error ? { errorCode: result.error.code } : {}),
      ...(summary ? { summary } : {}),
    });
    await this.opts.recorder?.finish(ctx.runId, result, diagnostic ? { diagnostic } : undefined).catch(() => {});
    return result;
  }
}

/** Operator diagnostic for an unexpected error: bounded, with credential-like strings redacted. */
function diagnose(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.replace(/(gh[pousr]_|github_pat_|gsk_|sk-)[A-Za-z0-9_-]+/g, '$1[REDACTED]').slice(0, 1000);
}

/** Serialises a ToolResult for the model's `tool` message. */
export function toolResultContent(result: ToolResult): string {
  if (result.status === 'success') {
    return JSON.stringify({ status: 'success', data: result.data, ...(result.truncated ? { truncated: true } : {}) });
  }
  return JSON.stringify({ status: result.status, error: result.error });
}

function bound(output: unknown, maxChars: number): { data: unknown; truncated: boolean } {
  const json = JSON.stringify(output ?? null);
  if (json.length <= maxChars) return { data: output ?? null, truncated: false };
  return { data: { preview: json.slice(0, maxChars) }, truncated: true };
}

function safeSummary(def: ToolDefinition, output: unknown): string | undefined {
  try {
    return def.summarize?.(output)?.slice(0, 200);
  } catch {
    return undefined;
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
