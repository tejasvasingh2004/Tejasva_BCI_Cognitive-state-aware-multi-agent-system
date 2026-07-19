'use client';

import React from 'react';
import { WorkloadState, ChatMetadata } from '../types';
import { WORKLOAD_POLICIES } from './WorkloadSelector';

interface AgentVisualizerProps {
  currentWorkload: WorkloadState;
  metadata?: ChatMetadata | null;
  isLoading: boolean;
}

interface NodeState {
  name: string;
  role: string;
  description: string;
  status: 'pending' | 'active' | 'completed' | 'skipped';
}

export default function AgentVisualizer({ currentWorkload, metadata, isLoading }: AgentVisualizerProps) {
  const policy = WORKLOAD_POLICIES[currentWorkload];
  const visited = metadata?.visited_nodes ?? [];
  const loopCount = metadata?.verification_loops ?? 0;
  
  // Define the standard agents in the system
  const nodes: NodeState[] = [
    {
      name: 'Planner Agent',
      role: 'Break down question',
      description: 'Generates step-by-step conceptual plan.',
      status: 'skipped'
    },
    {
      name: 'Research Agent',
      role: 'Generate solution',
      description: 'Drafts responses following guidelines.',
      status: 'skipped'
    },
    {
      name: 'Verifier Agent',
      role: 'Check correctness',
      description: 'Validates answers & scores confidence.',
      status: 'skipped'
    },
    {
      name: 'Final Verification Agent',
      role: 'Final audit check',
      description: 'Performs final rigorous sanity and safety check.',
      status: 'skipped'
    }
  ];

  // Resolve statuses based on policy configuration, visited nodes, and loading state
  nodes.forEach(node => {
    const isIncluded = policy.agents_used.includes(node.name);
    
    if (!isIncluded) {
      node.status = 'skipped';
      return;
    }

    if (isLoading) {
      // Simple logic to show active state while loading
      if (node.name === 'Planner Agent') {
        node.status = 'active';
      } else if (node.name === 'Research Agent') {
        node.status = 'active';
      } else if (node.name === 'Verifier Agent' && policy.agents_count >= 3) {
        node.status = 'active';
      } else if (node.name === 'Final Verification Agent' && policy.agents_count === 4) {
        node.status = 'active';
      } else {
        node.status = 'pending';
      }
      return;
    }

    // If loaded, check visited list
    const wasVisited = visited.includes(node.name);
    if (wasVisited) {
      node.status = 'completed';
    } else {
      node.status = 'pending';
    }
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-200">LangGraph Agent Execution Path</h2>
          <p className="text-xs text-slate-400 mt-1">
            Dynamic routing map showing agent node statuses for the selected policy.
          </p>
        </div>
        {loopCount > 0 && (
          <span className="bg-amber-500/10 border border-amber-500/20 text-amber-400 font-mono text-[10px] px-2 py-1 rounded-md animate-pulse">
            Verifier Loops: {loopCount}
          </span>
        )}
      </div>

      <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl p-6 relative overflow-hidden">
        {/* Connection line background */}
        <div className="hidden lg:block absolute top-[60px] left-[10%] right-[10%] h-0.5 bg-slate-800 -z-10"></div>
        
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 relative z-10">
          {nodes.map((node, idx) => {
            // Determine styles based on status
            let borderStyle = 'border-slate-800 bg-slate-900/40 text-slate-500';
            let glowStyle = '';
            let badgeStyle = 'bg-slate-800 text-slate-500';
            let label = 'Skipped';

            if (node.status === 'completed') {
              borderStyle = 'border-emerald-500/50 bg-emerald-950/15 text-slate-200';
              badgeStyle = 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
              label = 'Completed';
            } else if (node.status === 'active') {
              borderStyle = 'border-cyan-500 bg-cyan-950/20 text-slate-100 ring-1 ring-cyan-500';
              glowStyle = 'shadow-[0_0_20px_-3px_rgba(6,182,212,0.25)] animate-pulse';
              badgeStyle = 'bg-cyan-500 text-slate-950 font-bold';
              label = 'Processing';
            } else if (node.status === 'pending') {
              borderStyle = 'border-slate-700 bg-slate-900/80 text-slate-400';
              badgeStyle = 'bg-slate-800 text-slate-400 border border-slate-700';
              label = 'Pending';
            } else if (node.status === 'skipped') {
              borderStyle = 'border-slate-800/40 bg-slate-950/10 text-slate-600 opacity-40';
              badgeStyle = 'bg-slate-900/60 text-slate-600';
              label = 'Skipped';
            }

            return (
              <div key={node.name} className="flex flex-col items-center text-center space-y-3 relative group">
                {/* Node bubble */}
                <div 
                  className={`w-full max-w-[220px] rounded-xl border p-4 transition-all duration-300 flex flex-col justify-between h-[120px] ${borderStyle} ${glowStyle}`}
                >
                  <div>
                    <div className="flex items-center justify-between text-[10px] font-mono">
                      <span className="text-slate-500 font-bold">0{idx + 1}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[8px] tracking-wide uppercase ${badgeStyle}`}>
                        {label}
                      </span>
                    </div>
                    
                    <h3 className="text-xs font-bold mt-2 text-left truncate">{node.name}</h3>
                    <p className="text-[10px] text-slate-400 text-left mt-1 font-semibold truncate text-slate-300">
                      {node.role}
                    </p>
                  </div>
                  
                  <p className="text-[9px] text-slate-500 text-left line-clamp-2 mt-2 leading-relaxed">
                    {node.description}
                  </p>
                </div>
                
                {/* Arrow connector for vertical layout on mobile, indicators on large screens */}
                {idx < 3 && (
                  <div className="lg:hidden h-4 flex items-center justify-center">
                    <svg className="w-3 h-3 text-slate-800" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Verification Loop visualization indicator (curves from Verifier (node index 2) back to Research (node index 1)) */}
        {policy.agents_count >= 2 && (
          <div className="hidden lg:block absolute bottom-1.5 left-[37.5%] right-[37.5%] h-8 border-b-2 border-dashed border-amber-500/20 rounded-b-3xl">
            <div className="absolute left-1/2 -bottom-2 -translate-x-1/2 bg-slate-950 px-2 text-[9px] font-mono text-amber-500/60 uppercase tracking-widest flex items-center space-x-1">
              <span>Verifier Loop Link</span>
              {loopCount > 0 && <span className="animate-ping rounded-full w-1 h-1 bg-amber-500"></span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
