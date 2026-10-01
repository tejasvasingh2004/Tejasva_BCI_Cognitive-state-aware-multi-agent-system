import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ApprovalMode } from '@neuroflow/contracts';

export type EditorTab = { path: string; mode: 'edit' | 'diff' };
export type Buffer = {
  /** Current editor content. */
  content: string;
  /** Content as last loaded from / saved to the workspace. */
  saved: string;
  /** The file changed in the workspace while the buffer had unsaved edits. */
  conflict?: string;
};
export type Selection = { path: string; startLine: number; endLine: number; text: string };
export type TerminalEntry = {
  id: string;
  command: string;
  kind: string;
  output: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'timeout' | 'denied';
  exitCode?: number;
  durationMs?: number;
  network?: boolean;
  message?: string;
};
export type Marker = { path: string; line: number; column: number; severity: 'error' | 'warning' | 'info'; message: string; source?: string };

export type AgentTab = 'chat' | 'plan' | 'activity' | 'context' | 'approvals';
export type BottomTab = 'terminal' | 'problems' | 'tests' | 'diff' | 'logs';
export type ExplorerTab = 'files' | 'search' | 'git' | 'branches';

/**
 * Local state of the open code workspace (tabs, unsaved buffers, selection, panel layout, terminal
 * session). Repository, Git and run data are server state and stay in TanStack Query.
 */
type CodeState = {
  workspaceId: string | null;
  tabs: EditorTab[];
  activePath: string | null;
  buffers: Record<string, Buffer>;
  selection: Selection | null;
  /** Line to reveal in the editor (search results, problems, activity links). */
  reveal: { path: string; line: number; nonce: number } | null;
  pinned: string[];
  agentTab: AgentTab;
  bottomTab: BottomTab;
  explorerTab: ExplorerTab;
  bottomOpen: boolean;
  commandBarOpen: boolean;
  terminal: TerminalEntry[];
  markers: Marker[];
  /** Run shown in the agent panel per code workspace, and the conversation the agent chat continues. */
  activeRun: Record<string, string | null>;
  conversation: Record<string, string | null>;
  /** Approval mode chosen for the next agent request (defaults to the workspace's mode). */
  approvalMode: Record<string, ApprovalMode>;

  open(workspaceId: string): void;
  openFile(path: string, mode?: EditorTab['mode']): void;
  closeTab(path: string): void;
  setActive(path: string): void;
  setTabMode(path: string, mode: EditorTab['mode']): void;
  loadBuffer(path: string, content: string): void;
  editBuffer(path: string, content: string): void;
  markSaved(path: string, content: string): void;
  externalChange(path: string, content: string | null): void;
  resolveConflict(path: string, keep: 'mine' | 'theirs'): void;
  renamePath(from: string, to: string): void;
  setSelection(s: Selection | null): void;
  revealLine(path: string, line: number): void;
  togglePin(path: string): void;
  setAgentTab(t: AgentTab): void;
  setBottomTab(t: BottomTab, open?: boolean): void;
  setExplorerTab(t: ExplorerTab): void;
  setBottomOpen(v: boolean): void;
  setCommandBarOpen(v: boolean): void;
  upsertTerminal(id: string, patch: Partial<TerminalEntry> & { append?: string }): void;
  clearTerminal(): void;
  setMarkers(m: Marker[]): void;
  setActiveRun(workspaceId: string, runId: string | null): void;
  setConversation(workspaceId: string, conversationId: string | null): void;
  setApprovalMode(workspaceId: string, mode: ApprovalMode): void;
};

const TERMINAL_LIMIT = 200_000;

export const useCode = create<CodeState>()(
  persist(
    (set, get) => ({
      workspaceId: null,
      tabs: [],
      activePath: null,
      buffers: {},
      selection: null,
      reveal: null,
      pinned: [],
      agentTab: 'chat',
      bottomTab: 'terminal',
      explorerTab: 'files',
      bottomOpen: true,
      commandBarOpen: false,
      terminal: [],
      markers: [],
      activeRun: {},
      conversation: {},
      approvalMode: {},

      open: (workspaceId) => {
        if (get().workspaceId === workspaceId) return;
        set({ workspaceId, tabs: [], activePath: null, buffers: {}, selection: null, pinned: [], terminal: [], markers: [] });
      },
      openFile: (path, mode = 'edit') =>
        set((s) => ({
          tabs: s.tabs.some((t) => t.path === path) ? s.tabs.map((t) => (t.path === path ? { ...t, mode } : t)) : [...s.tabs, { path, mode }],
          activePath: path,
        })),
      closeTab: (path) =>
        set((s) => {
          const i = s.tabs.findIndex((t) => t.path === path);
          const tabs = s.tabs.filter((t) => t.path !== path);
          const buffers = { ...s.buffers };
          delete buffers[path];
          const activePath = s.activePath === path ? (tabs[Math.max(0, i - 1)]?.path ?? null) : s.activePath;
          return { tabs, buffers, activePath };
        }),
      setActive: (activePath) => set({ activePath }),
      setTabMode: (path, mode) => set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, mode } : t)) })),
      loadBuffer: (path, content) => set((s) => ({ buffers: { ...s.buffers, [path]: { content, saved: content } } })),
      editBuffer: (path, content) =>
        set((s) => {
          const b = s.buffers[path];
          if (!b || b.content === content) return s;
          return { buffers: { ...s.buffers, [path]: { ...b, content } } };
        }),
      markSaved: (path, content) =>
        set((s) => ({ buffers: { ...s.buffers, [path]: { content: s.buffers[path]?.content ?? content, saved: content } } })),
      externalChange: (path, content) =>
        set((s) => {
          const b = s.buffers[path];
          if (!b) return s;
          if (content === null) return { buffers: { ...s.buffers, [path]: { ...b, conflict: '' } } };
          if (content === b.saved) return s;
          // Clean buffers follow the workspace; dirty ones keep the user's edits and flag a conflict.
          if (b.content === b.saved) return { buffers: { ...s.buffers, [path]: { content, saved: content } } };
          return { buffers: { ...s.buffers, [path]: { ...b, conflict: content } } };
        }),
      resolveConflict: (path, keep) =>
        set((s) => {
          const b = s.buffers[path];
          if (!b || b.conflict === undefined) return s;
          const next = keep === 'theirs' ? { content: b.conflict, saved: b.conflict } : { content: b.content, saved: b.conflict };
          return { buffers: { ...s.buffers, [path]: next } };
        }),
      renamePath: (from, to) =>
        set((s) => {
          const buffers = { ...s.buffers };
          if (buffers[from]) {
            buffers[to] = buffers[from]!;
            delete buffers[from];
          }
          return {
            buffers,
            tabs: s.tabs.map((t) => (t.path === from ? { ...t, path: to } : t)),
            activePath: s.activePath === from ? to : s.activePath,
          };
        }),
      setSelection: (selection) => set({ selection }),
      revealLine: (path, line) =>
        set((s) => ({
          tabs: s.tabs.some((t) => t.path === path) ? s.tabs.map((t) => (t.path === path ? { ...t, mode: 'edit' as const } : t)) : [...s.tabs, { path, mode: 'edit' as const }],
          activePath: path,
          reveal: { path, line, nonce: (s.reveal?.nonce ?? 0) + 1 },
        })),
      togglePin: (path) => set((s) => ({ pinned: s.pinned.includes(path) ? s.pinned.filter((p) => p !== path) : [...s.pinned, path].slice(-20) })),
      setAgentTab: (agentTab) => set({ agentTab }),
      setBottomTab: (bottomTab, open = true) => set((s) => ({ bottomTab, bottomOpen: open || s.bottomOpen })),
      setExplorerTab: (explorerTab) => set({ explorerTab }),
      setBottomOpen: (bottomOpen) => set({ bottomOpen }),
      setCommandBarOpen: (commandBarOpen) => set({ commandBarOpen }),
      upsertTerminal: (id, { append, ...patch }) =>
        set((s) => {
          const existing = s.terminal.find((t) => t.id === id);
          if (!existing) {
            const entry: TerminalEntry = { id, command: '', kind: 'command', output: append ?? '', status: 'queued', ...patch };
            return { terminal: [...s.terminal.slice(-30), entry] };
          }
          return {
            terminal: s.terminal.map((t) =>
              t.id === id ? { ...t, ...patch, output: append ? (t.output + append).slice(-TERMINAL_LIMIT) : t.output } : t,
            ),
          };
        }),
      clearTerminal: () => set({ terminal: [] }),
      setMarkers: (markers) => set({ markers }),
      setActiveRun: (workspaceId, runId) => set((s) => ({ activeRun: { ...s.activeRun, [workspaceId]: runId } })),
      setConversation: (workspaceId, conversationId) => set((s) => ({ conversation: { ...s.conversation, [workspaceId]: conversationId } })),
      setApprovalMode: (workspaceId, mode) => set((s) => ({ approvalMode: { ...s.approvalMode, [workspaceId]: mode } })),
    }),
    {
      name: 'neuroflow-code',
      partialize: (s) => ({
        bottomOpen: s.bottomOpen,
        bottomTab: s.bottomTab,
        agentTab: s.agentTab,
        explorerTab: s.explorerTab,
        conversation: s.conversation,
        activeRun: s.activeRun,
        approvalMode: s.approvalMode,
      }),
    },
  ),
);

export const isDirty = (b: Buffer | undefined) => Boolean(b && b.content !== b.saved);
