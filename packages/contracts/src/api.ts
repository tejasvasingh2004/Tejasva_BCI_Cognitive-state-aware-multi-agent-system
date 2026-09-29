import { z } from 'zod';
import { ChatMessage } from './messages';
import { Run } from './runs';

export const Conversation = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof Conversation>;

export const StoredMessage = ChatMessage.extend({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type StoredMessage = z.infer<typeof StoredMessage>;

export const ConversationDetail = z.object({
  conversation: Conversation,
  messages: z.array(StoredMessage),
  runs: z.array(Run),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

export const CreateConversationBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const UpdateConversationBody = z.object({
  title: z.string().trim().min(1).max(200),
});

export const MemoryItem = z.object({
  id: z.string().uuid(),
  content: z.string(),
  tags: z.array(z.string()),
  source: z.string(),
  createdAt: z.string(),
  score: z.number().optional(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

export const CreateMemoryBody = z.object({
  content: z.string().trim().min(1).max(4000),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});

export const SearchMemoryBody = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
});

export const Principal = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  scopes: z.array(z.string()),
  via: z.enum(['session', 'api_key']),
});
export type Principal = z.infer<typeof Principal>;

export const Me = z.object({
  user: z.object({ id: z.string().uuid(), email: z.string(), displayName: z.string() }),
  workspace: z.object({ id: z.string().uuid(), name: z.string() }),
  scopes: z.array(z.string()),
});
export type Me = z.infer<typeof Me>;

/** Scopes checked by the API and the tool runtime. */
export const Scopes = {
  runsWrite: 'runs:write',
  runsRead: 'runs:read',
  memoryRead: 'memory:read',
  memoryWrite: 'memory:write',
  toolsExecute: 'tools:execute',
  admin: 'admin',
} as const;
export const ALL_SCOPES = Object.values(Scopes);
