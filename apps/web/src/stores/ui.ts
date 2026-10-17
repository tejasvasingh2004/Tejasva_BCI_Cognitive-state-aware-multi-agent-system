import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ReasoningBudget, RequestedAgentStrategy, RunMode } from '@neuroflow/contracts';

/**
 * Local UI/workspace state only. Server state (conversations, runs, events) lives in TanStack
 * Query and is never duplicated here.
 */
type UiState = {
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  inspectedRunId: string | null;
  memoryOpen: boolean;
  settingsOpen: boolean;
  /** Mobile only: sidebar shown as an overlay drawer. */
  mobileSidebarOpen: boolean;
  theme: 'light' | 'dark' | 'system';
  composer: {
    mode: RunMode;
    model: string; // 'auto' or model ref
    agentStrategy: RequestedAgentStrategy;
    reasoningBudget: ReasoningBudget | 'auto';
    toolsEnabled: boolean;
    /** Explicit tool allow-list; null = every tool the user may use. */
    tools: string[] | null;
    /** Built-in or workspace agent to run as the single agent; null = automatic. */
    agent: string | null;
    advancedOpen: boolean;
  };
  setSidebarOpen(v: boolean): void;
  toggleInspector(runId?: string | null): void;
  inspect(runId: string | null): void;
  setMemoryOpen(v: boolean): void;
  setSettingsOpen(v: boolean): void;
  setMobileSidebarOpen(v: boolean): void;
  setTheme(t: UiState['theme']): void;
  setComposer(patch: Partial<UiState['composer']>): void;
};

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      inspectorOpen: false,
      inspectedRunId: null,
      memoryOpen: false,
      settingsOpen: false,
      mobileSidebarOpen: false,
      theme: 'system',
      composer: {
        mode: 'standard',
        model: 'auto',
        agentStrategy: 'auto',
        reasoningBudget: 'auto',
        toolsEnabled: true,
        tools: null,
        agent: null,
        advancedOpen: false,
      },
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      toggleInspector: (runId) =>
        set((s) => ({ inspectorOpen: !s.inspectorOpen, ...(runId !== undefined ? { inspectedRunId: runId } : {}) })),
      inspect: (inspectedRunId) => set({ inspectedRunId, inspectorOpen: true }),
      setMemoryOpen: (memoryOpen) => set({ memoryOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setMobileSidebarOpen: (mobileSidebarOpen) => set({ mobileSidebarOpen }),
      setTheme: (theme) => set({ theme }),
      setComposer: (patch) => set((s) => ({ composer: { ...s.composer, ...patch } })),
    }),
    {
      name: 'neuroflow-ui',
      partialize: (s) => ({ sidebarOpen: s.sidebarOpen, composer: s.composer, theme: s.theme }),
      // Older persisted state lacks newer composer fields.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        return { ...current, ...p, composer: { ...current.composer, ...(p.composer ?? {}) } };
      },
    },
  ),
);
