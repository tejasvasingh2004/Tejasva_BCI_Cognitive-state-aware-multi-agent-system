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
  composer: {
    mode: RunMode;
    model: string; // 'auto' or model ref
    agentStrategy: RequestedAgentStrategy;
    reasoningBudget: ReasoningBudget | 'auto';
    toolsEnabled: boolean;
    advancedOpen: boolean;
  };
  setSidebarOpen(v: boolean): void;
  toggleInspector(runId?: string | null): void;
  inspect(runId: string | null): void;
  setMemoryOpen(v: boolean): void;
  setComposer(patch: Partial<UiState['composer']>): void;
};

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      inspectorOpen: false,
      inspectedRunId: null,
      memoryOpen: false,
      composer: {
        mode: 'standard',
        model: 'auto',
        agentStrategy: 'auto',
        reasoningBudget: 'auto',
        toolsEnabled: true,
        advancedOpen: false,
      },
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      toggleInspector: (runId) =>
        set((s) => ({ inspectorOpen: !s.inspectorOpen, ...(runId !== undefined ? { inspectedRunId: runId } : {}) })),
      inspect: (inspectedRunId) => set({ inspectedRunId, inspectorOpen: true }),
      setMemoryOpen: (memoryOpen) => set({ memoryOpen }),
      setComposer: (patch) => set((s) => ({ composer: { ...s.composer, ...patch } })),
    }),
    {
      name: 'neuroflow-ui',
      partialize: (s) => ({ sidebarOpen: s.sidebarOpen, composer: s.composer }),
    },
  ),
);
