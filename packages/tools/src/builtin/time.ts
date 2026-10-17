import { z } from 'zod';
import { defineTool, ToolExecutionError } from '../types';

export const currentTimeTool = defineTool({
  name: 'get_current_time',
  description: 'Get the current date and time, optionally in a specific IANA time zone (e.g. "Asia/Kolkata").',
  input: z.object({
    timezone: z.string().max(64).optional().describe('IANA time zone name; defaults to UTC'),
  }),
  riskLevel: 'low',
  requiresApproval: false,
  sideEffects: false,
  permissions: [],
  timeoutMs: 1_000,
  async execute({ timezone }) {
    const tz = timezone ?? 'UTC';
    const now = new Date();
    let local: string;
    try {
      local = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now);
    } catch {
      throw new ToolExecutionError(`Unknown time zone "${tz}"`);
    }
    return { iso: now.toISOString(), timezone: tz, local };
  },
  summarize: (o) => o.local,
});
