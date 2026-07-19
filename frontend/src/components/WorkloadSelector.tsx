'use client';

import React from 'react';
import { WorkloadState, WorkloadPolicy } from '../types';

interface WorkloadSelectorProps {
  selectedState: WorkloadState;
  onChange: (state: WorkloadState) => void;
  disabled?: boolean;
}

export const WORKLOAD_POLICIES: Record<WorkloadState, WorkloadPolicy> = {
  NORMAL: {
    state: 'NORMAL',
    agents_count: 1,
    verification_loops: 0,
    confidence_threshold: 75,
    detail_level: 'Full explanation with examples',
    description: 'Calm cognitive state. Full detail answers with conceptual and code examples.',
    colorClass: 'border-cyan-500/40 bg-cyan-950/20 hover:border-cyan-400 shadow-[0_0_15px_-3px_rgba(6,182,212,0.1)]',
    textColorClass: 'text-cyan-400',
    borderColorClass: 'border-cyan-500',
    bgClass: 'bg-cyan-500/10',
    agents_used: ['Research Agent'],
  },
  MODERATE: {
    state: 'MODERATE',
    agents_count: 2,
    verification_loops: 1,
    confidence_threshold: 85,
    detail_level: 'Concise explanation',
    description: 'Steady workload. Direct and concise responses checked for correctness.',
    colorClass: 'border-emerald-500/40 bg-emerald-950/20 hover:border-emerald-400 shadow-[0_0_15px_-3px_rgba(16,185,129,0.1)]',
    textColorClass: 'text-emerald-400',
    borderColorClass: 'border-emerald-500',
    bgClass: 'bg-emerald-500/10',
    agents_used: ['Research Agent', 'Verifier Agent'],
  },
  HIGH: {
    state: 'HIGH',
    agents_count: 3,
    verification_loops: 2,
    confidence_threshold: 95,
    detail_level: 'Bullet points only',
    description: 'Elevated workload. Structured bullet-point summaries to optimize readability.',
    colorClass: 'border-amber-500/40 bg-amber-950/20 hover:border-amber-400 shadow-[0_0_15px_-3px_rgba(245,158,11,0.1)]',
    textColorClass: 'text-amber-400',
    borderColorClass: 'border-amber-500',
    bgClass: 'bg-amber-500/10',
    agents_used: ['Planner Agent', 'Research Agent', 'Verifier Agent'],
  },
  OVERLOADED: {
    state: 'OVERLOADED',
    agents_count: 4,
    verification_loops: 3,
    confidence_threshold: 98,
    detail_level: 'Action items only',
    description: 'Extreme cognitive burden. Synthesized checklist of immediate action items.',
    colorClass: 'border-rose-500/40 bg-rose-950/25 hover:border-rose-400 animate-border-pulse shadow-[0_0_20px_-3px_rgba(244,63,94,0.15)]',
    textColorClass: 'text-rose-400',
    borderColorClass: 'border-rose-500',
    bgClass: 'bg-rose-500/10',
    agents_used: ['Planner Agent', 'Research Agent', 'Verifier Agent', 'Summarizer Agent'],
  },
};

export default function WorkloadSelector({ selectedState, onChange, disabled = false }: WorkloadSelectorProps) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-200">Cognitive Workload State Selector</h2>
        <p className="text-xs text-slate-400 mt-1">
          {disabled 
            ? "Autopilot is automatically resolving your cognitive workload using real-time EEG predictions." 
            : "Select the manual user state to adapt the routing policy, response detail level, and verification loops."}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(Object.keys(WORKLOAD_POLICIES) as WorkloadState[]).map((key) => {
          const policy = WORKLOAD_POLICIES[key];
          const isSelected = selectedState === key;
          
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onChange(key)}
              className={`text-left border rounded-xl p-4 transition-all duration-300 relative group flex flex-col justify-between ${
                disabled 
                  ? isSelected 
                    ? `${policy.borderColorClass} ${policy.bgClass} opacity-100 cursor-not-allowed pointer-events-none` 
                    : 'opacity-20 cursor-not-allowed pointer-events-none' 
                  : isSelected
                    ? `${policy.borderColorClass} ${policy.bgClass} scale-[1.02] shadow-[0_0_25px_-5px_rgba(0,0,0,0.3)] ring-1 ${policy.borderColorClass}`
                    : policy.colorClass
              }`}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className={`text-sm font-bold uppercase tracking-wider ${policy.textColorClass}`}>
                    {policy.state}
                  </span>
                  {isSelected && (
                    <span className={`flex h-2 w-2 relative`}>
                      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${policy.borderColorClass} opacity-75`}></span>
                      <span className={`relative inline-flex rounded-full h-2 w-2 ${policy.borderColorClass}`}></span>
                    </span>
                  )}
                </div>
                
                <p className="text-xs text-slate-300 mt-2 line-clamp-2 leading-relaxed">
                  {policy.description}
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap gap-y-2 justify-between text-[10px] text-slate-400 font-mono">
                <div className="flex items-center space-x-1">
                  <span>Agents:</span>
                  <span className={`font-semibold ${isSelected ? policy.textColorClass : 'text-slate-300'}`}>
                    {policy.agents_count}
                  </span>
                </div>
                <div className="flex items-center space-x-1">
                  <span>Loops:</span>
                  <span className={`font-semibold ${isSelected ? policy.textColorClass : 'text-slate-300'}`}>
                    {policy.verification_loops}
                  </span>
                </div>
                <div className="flex items-center space-x-1">
                  <span>Confidence:</span>
                  <span className={`font-semibold ${isSelected ? policy.textColorClass : 'text-slate-300'}`}>
                    {policy.confidence_threshold}%
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
