import type { ModelInfo } from '@neuroflow/contracts';
import type { ModelGateway } from '@neuroflow/models';
import { withSpan } from '@neuroflow/observability';

export const SUMMARY_POLICY = {
  /** Summarise once this many user/assistant messages are not yet covered by the summary. */
  triggerMessages: 24,
  /** Most recent messages always left verbatim (they stay in the history window). */
  keepRecent: 12,
  maxSummaryChars: 3_000,
  maxInputChars: 24_000,
};

export type SummaryMessage = { position: number; role: 'user' | 'assistant'; content: string };

/** Which messages to fold into the summary, or null when no summarisation is needed yet. */
export function selectForSummary(unsummarized: SummaryMessage[]): SummaryMessage[] | null {
  if (unsummarized.length < SUMMARY_POLICY.triggerMessages) return null;
  return unsummarized.slice(0, unsummarized.length - SUMMARY_POLICY.keepRecent);
}

/** Summaries use the cheapest/fastest available model; quality matters less than latency. */
export function summaryModel(models: ModelInfo[], fallback?: string): string | undefined {
  const order = { fast: 0, balanced: 1, strong: 2 } as const;
  const available = models.filter((m) => m.available).sort((a, b) => order[a.tier] - order[b.tier]);
  return available[0]?.ref ?? fallback;
}

const PROMPT = `You maintain a running summary of a conversation between a user and an AI assistant.
Merge the PREVIOUS SUMMARY with the NEW MESSAGES into one updated summary.
Keep: the user's goals, decisions, constraints, preferences, facts they provided, open questions and conclusions reached.
Drop: pleasantries and repetition. Write compact bullet points in the third person. Do not invent anything.
Never include secrets, passwords or API keys even if they appear in the messages.`;

/** Produces an updated rolling summary. Throws on model failure (callers treat it as best effort). */
export async function summarizeConversation(
  gateway: ModelGateway,
  input: { model: string; previousSummary: string | null; messages: SummaryMessage[]; signal?: AbortSignal },
): Promise<string> {
  return withSpan('conversation.summarize', { 'summary.messages': input.messages.length }, async () => {
    let transcript = input.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    if (transcript.length > SUMMARY_POLICY.maxInputChars) transcript = transcript.slice(-SUMMARY_POLICY.maxInputChars);
    const res = await gateway.complete({
      model: input.model,
      reasoningBudget: 'off',
      maxOutputTokens: 900,
      temperature: 0.2,
      signal: input.signal,
      messages: [
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: `PREVIOUS SUMMARY:\n${input.previousSummary?.trim() || '(none)'}\n\nNEW MESSAGES:\n${transcript}`,
        },
      ],
    });
    const summary = res.text.trim();
    if (!summary) throw new Error('Empty summary');
    return summary.slice(0, SUMMARY_POLICY.maxSummaryChars);
  });
}
