import { z } from 'zod';
import { defineTool, ToolExecutionError } from '../types';

/**
 * Safe arithmetic evaluator (recursive descent). Never uses eval/Function.
 * Grammar: expr := term (('+'|'-') term)* ; term := power (('*'|'/'|'%') power)* ;
 * power := unary ('^' power)? ; unary := '-' unary | call ; call := ident '(' args ')' | primary
 */
const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  min: Math.min,
  max: Math.max,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function evaluateExpression(src: string): number {
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const expect = (c: string) => {
    skip();
    if (src[i] !== c) throw new ToolExecutionError(`Expected "${c}" at position ${i}`);
    i++;
  };

  const primary = (): number => {
    skip();
    if (peek() === '(') {
      i++;
      const v = expr();
      expect(')');
      return v;
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const ident = /^[a-z][a-z0-9]*/i.exec(src.slice(i));
    if (ident) {
      const name = ident[0].toLowerCase();
      i += ident[0].length;
      skip();
      if (peek() === '(') {
        const fn = FUNCS[name];
        if (!fn) throw new ToolExecutionError(`Unknown function "${name}"`);
        i++;
        const args: number[] = [];
        skip();
        if (peek() !== ')') {
          args.push(expr());
          skip();
          while (peek() === ',') {
            i++;
            args.push(expr());
            skip();
          }
        }
        expect(')');
        return fn(...args);
      }
      if (name in CONSTS) return CONSTS[name]!;
      throw new ToolExecutionError(`Unknown identifier "${name}"`);
    }
    throw new ToolExecutionError(`Unexpected input at position ${i}`);
  };
  const unary = (): number => {
    skip();
    if (peek() === '-') {
      i++;
      return -unary();
    }
    if (peek() === '+') {
      i++;
      return unary();
    }
    return primary();
  };
  const power = (): number => {
    const base = unary();
    skip();
    if (peek() === '^') {
      i++;
      return base ** power();
    }
    return base;
  };
  const term = (): number => {
    let v = power();
    for (;;) {
      skip();
      const op = peek();
      if (op !== '*' && op !== '/' && op !== '%') return v;
      i++;
      const r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      skip();
      const op = peek();
      if (op !== '+' && op !== '-') return v;
      i++;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
  };

  const value = expr();
  skip();
  if (i !== src.length) throw new ToolExecutionError(`Unexpected input at position ${i}`);
  if (!Number.isFinite(value)) throw new ToolExecutionError('Result is not a finite number');
  return value;
}

export const calculatorTool = defineTool({
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression exactly. Supports + - * / % ^, parentheses, sqrt, abs, round, floor, ceil, ln, log, log2, exp, sin, cos, tan, min, max, pi, e.',
  input: z.object({
    expression: z.string().min(1).max(300).describe('Arithmetic expression, e.g. "(12.5 * 4) / 3"'),
  }),
  riskLevel: 'low',
  requiresApproval: false,
  sideEffects: false,
  permissions: [],
  timeoutMs: 1_000,
  async execute({ expression }) {
    return { expression, result: evaluateExpression(expression) };
  },
  summarize: (o) => `${o.expression} = ${o.result}`,
});
