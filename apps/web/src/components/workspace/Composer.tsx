import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, Bot, Brain, ChevronDown, Cpu, Gauge, Network, SlidersHorizontal, Square, Wrench } from 'lucide-react';
import type { ReasoningBudget, RequestedAgentStrategy } from '@neuroflow/contracts';
import { cn } from '@/lib/utils';
import { STRATEGY_LABEL } from '@/lib/run-view';
import { useAgents, useModels, useTools } from '@/hooks/queries';
import { useUi } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';

export type ComposerHandle = { focus(): void; setText(t: string): void };

type Props = {
  running: boolean;
  onSubmit(text: string): void;
  onStop(): void;
  placeholder?: string;
  variant?: 'hero' | 'docked';
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { running, onSubmit, onStop, placeholder = 'Ask NeuroFlow anything…', variant = 'docked' },
  ref,
) {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const advancedOpen = useUi((s) => s.composer.advancedOpen);
  const setComposer = useUi((s) => s.setComposer);

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    setText: (t) => {
      setText(t);
      requestAnimationFrame(() => area.current?.focus());
    },
  }));

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || running) return;
    onSubmit(value);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && running) onStop();
  };

  return (
    <div className="w-full">
      <motion.div
        layout
        className={cn(
          'glass-strong flex items-end gap-2 rounded-[26px] py-2 pl-3 pr-2 transition-shadow focus-within:shadow-float',
          variant === 'hero' && 'rounded-full py-1.5',
        )}
      >
        <Tooltip content={advancedOpen ? 'Hide controls' : 'Execution controls'}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('mb-0.5', advancedOpen && 'bg-violet-soft text-accent')}
            onClick={() => setComposer({ advancedOpen: !advancedOpen })}
            aria-label="Execution controls"
          >
            <SlidersHorizontal className="size-4" />
          </Button>
        </Tooltip>
        <textarea
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Message"
          data-testid="composer-input"
          className="max-h-[220px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-ink outline-none placeholder:text-faint"
        />
        {running ? (
          <Tooltip content="Stop (Esc)">
            <Button variant="primary" size="icon" onClick={onStop} aria-label="Stop" data-testid="stop-button">
              <Square className="size-3.5 fill-current" />
            </Button>
          </Tooltip>
        ) : (
          <Button
            variant="primary"
            size="icon"
            onClick={submit}
            disabled={!text.trim()}
            aria-label="Send"
            data-testid="send-button"
          >
            <ArrowUp className="size-4.5" strokeWidth={2.5} />
          </Button>
        )}
      </motion.div>
      <AnimatePresence initial={false}>
        {advancedOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <ComposerControls />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

const STRATEGIES: RequestedAgentStrategy[] = ['auto', 'direct', 'single_agent', 'sequential', 'parallel', 'supervisor', 'evaluator_optimizer'];
const BUDGETS: Array<ReasoningBudget | 'auto'> = ['auto', 'off', 'low', 'medium', 'high'];

function Chip({ icon: Icon, label, value, tone = 'violet' }: { icon: typeof Cpu; label: string; value: string; tone?: 'violet' | 'sky' | 'mint' | 'peach' | 'rose' }) {
  const tones = {
    violet: 'bg-violet-soft text-accent',
    sky: 'bg-sky-soft text-sky-600',
    mint: 'bg-mint-soft text-emerald-600',
    peach: 'bg-peach-soft text-orange-500',
    rose: 'bg-rose-soft text-rose-500',
  };
  return (
    <span className="flex items-center gap-2 rounded-full border border-surface bg-surface/70 py-1 pl-1 pr-3 text-xs text-ink-soft shadow-sm transition hover:bg-surface">
      <span className={cn('flex size-6 items-center justify-center rounded-full', tones[tone])}>
        <Icon className="size-3.5" />
      </span>
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink">{value}</span>
      <ChevronDown className="size-3 text-faint" />
    </span>
  );
}

function ComposerControls() {
  const composer = useUi((s) => s.composer);
  const setComposer = useUi((s) => s.setComposer);
  const { data: models } = useModels();
  const { data: allTools = [] } = useTools();
  // Repository tools only run inside a code workspace (they are offered by the Code Agent).
  const tools = useMemo(() => allTools.filter((t) => !t.requiresWorkspace), [allTools]);
  const { data: agentData } = useAgents();
  const agents = agentData?.agents ?? [];
  const toolsLabel = !composer.toolsEnabled
    ? 'None'
    : !composer.tools
      ? 'All'
      : composer.tools.length === 1
        ? composer.tools[0]!.replace(/_/g, ' ')
        : `${composer.tools.length} selected`;
  const agentLabel = composer.agent ? (agents.find((a) => a.id === composer.agent)?.name ?? composer.agent) : 'Auto';
  const modelLabel =
    composer.model === 'auto' ? 'Auto' : (models?.data.find((m) => m.id === composer.model)?.display_name ?? composer.model);

  return (
    <div className="flex flex-wrap items-center gap-2 px-2 pt-3" data-testid="composer-controls">
      <button
        onClick={() => setComposer({ mode: composer.mode === 'standard' ? 'cognitive' : 'standard' })}
        className={cn(
          'flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs shadow-sm transition',
          composer.mode === 'cognitive' ? 'border-violet-200 bg-violet-soft text-accent-deep' : 'border-surface bg-surface/70 text-ink-soft hover:bg-surface',
        )}
        aria-pressed={composer.mode === 'cognitive'}
        data-testid="mode-toggle"
      >
        <span className={cn('flex size-6 items-center justify-center rounded-full', composer.mode === 'cognitive' ? 'bg-violet-button text-white' : 'bg-rose-soft text-rose-500')}>
          <Brain className="size-3.5" />
        </span>
        {composer.mode === 'cognitive' ? 'Cognitive mode' : 'Standard mode'}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger className="outline-none">
          <Chip icon={Cpu} label="Model" value={modelLabel} tone="sky" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuItem selected={composer.model === 'auto'} onSelect={() => setComposer({ model: 'auto' })} hint="router picks">
            Auto
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {models?.data
            .filter((m) => m.id !== 'neuroflow-auto')
            .map((m) => (
              <DropdownMenuItem
                key={m.id}
                disabled={!m.available}
                selected={composer.model === m.id}
                onSelect={() => setComposer({ model: m.id })}
                hint={m.available ? m.owned_by : 'unavailable'}
              >
                {m.display_name}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className="outline-none" data-testid="strategy-picker">
          <Chip icon={Network} label="Agents" value={composer.agentStrategy === 'auto' ? 'Auto' : STRATEGY_LABEL[composer.agentStrategy]!} tone="violet" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Execution strategy</DropdownMenuLabel>
          {STRATEGIES.map((s) => (
            <DropdownMenuItem key={s} selected={composer.agentStrategy === s} onSelect={() => setComposer({ agentStrategy: s })}>
              {s === 'auto' ? 'Auto (smallest reliable)' : STRATEGY_LABEL[s]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className="outline-none">
          <Chip icon={Gauge} label="Reasoning" value={composer.reasoningBudget === 'auto' ? 'Auto' : cap(composer.reasoningBudget)} tone="peach" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Reasoning budget</DropdownMenuLabel>
          {BUDGETS.map((b) => (
            <DropdownMenuItem key={b} selected={composer.reasoningBudget === b} onSelect={() => setComposer({ reasoningBudget: b })}>
              {cap(b)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className="outline-none" data-testid="tools-picker">
          <Chip icon={Wrench} label="Tools" value={toolsLabel} tone="mint" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Tools the agent may use</DropdownMenuLabel>
          <DropdownMenuItem
            selected={composer.toolsEnabled && !composer.tools}
            onSelect={() => setComposer({ toolsEnabled: true, tools: null })}
          >
            All available tools
          </DropdownMenuItem>
          <DropdownMenuItem selected={!composer.toolsEnabled} onSelect={() => setComposer({ toolsEnabled: false, tools: null })}>
            No tools
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {tools.map((t) => {
            const on = composer.toolsEnabled && (!composer.tools || composer.tools.includes(t.name));
            return (
              <DropdownMenuItem
                key={t.name}
                selected={on}
                hint={t.requiresApproval ? 'approval' : undefined}
                // Keep the menu open while toggling several tools.
                onSelect={(e) => {
                  e.preventDefault();
                  const current = composer.toolsEnabled ? (composer.tools ?? tools.map((x) => x.name)) : [];
                  const next = on ? current.filter((n) => n !== t.name) : [...current, t.name];
                  setComposer({ toolsEnabled: next.length > 0, tools: next.length === tools.length ? null : next });
                }}
              >
                {t.name.replace(/_/g, ' ')}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className="outline-none" data-testid="agent-picker">
          <Chip icon={Bot} label="Agent" value={agentLabel} tone="rose" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Run as agent</DropdownMenuLabel>
          <DropdownMenuItem selected={!composer.agent} onSelect={() => setComposer({ agent: null })} hint="router picks">
            Automatic
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {agents
            .filter((a) => !['supervisor', 'critic', 'refiner', 'writer'].includes(a.id))
            .map((a) => (
              <DropdownMenuItem
                key={a.id}
                selected={composer.agent === a.id}
                onSelect={() => setComposer({ agent: a.id })}
                hint={a.builtin ? undefined : 'custom'}
              >
                {a.name}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
