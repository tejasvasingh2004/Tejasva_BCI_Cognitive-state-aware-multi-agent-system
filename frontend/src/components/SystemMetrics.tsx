'use client';

import React from 'react';
import { WorkloadState, ChatMetadata } from '../types';
import { WORKLOAD_POLICIES } from './WorkloadSelector';

interface SystemMetricsProps {
  currentWorkload: WorkloadState;
  metadata?: ChatMetadata | null;
  latencyMs?: number | null;
}

export default function SystemMetrics({ currentWorkload, metadata, latencyMs }: SystemMetricsProps) {
  const policy = WORKLOAD_POLICIES[currentWorkload];
  
  // Calculate confidence bar percentage
  const targetThreshold = metadata?.confidence_threshold ?? policy.confidence_threshold;
  const actualScore = metadata?.confidence_score ?? null;
  
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-200">System Metrics</h2>
        <p className="text-xs text-slate-400 mt-1">
          Real-time tracking of adaptive policy variables and LLM output evaluation.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Workload Card */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400">Active State</span>
          <div className="mt-2 flex items-baseline justify-between">
            <span className={`text-xl font-black ${policy.textColorClass}`}>
              {currentWorkload}
            </span>
          </div>
          <span className="text-[10px] text-slate-400 mt-2 block truncate">
            Policy Mode Activated
          </span>
        </div>

        {/* Latency Card */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400">Latency</span>
          <div className="mt-2">
            <span className="text-xl font-black font-mono text-slate-200">
              {latencyMs ? `${(latencyMs / 1000).toFixed(2)}s` : '---'}
            </span>
          </div>
          <span className="text-[10px] text-slate-400 mt-2 block">
            Execution Duration
          </span>
        </div>

        {/* Verification Loops Card */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400">Verification Loops</span>
          <div className="mt-2 flex items-baseline space-x-1">
            <span className="text-xl font-black font-mono text-slate-200">
              {metadata ? metadata.verification_loops : '0'}
            </span>
            <span className="text-xs text-slate-500 font-mono">
              / {policy.verification_loops} max
            </span>
          </div>
          <div className="w-full bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
            <div 
              className={`h-full ${policy.borderColorClass.replace('border-', 'bg-')} transition-all duration-500`}
              style={{ 
                width: `${
                  policy.verification_loops > 0 
                    ? ((metadata?.verification_loops ?? 0) / policy.verification_loops) * 100 
                    : 0
                }%` 
              }}
            />
          </div>
        </div>

        {/* Detail Level Card */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400">Response Detail Level</span>
          <div className="mt-2">
            <span className="text-xs font-bold text-slate-200 block leading-tight">
              {policy.detail_level}
            </span>
          </div>
          <span className="text-[10px] text-slate-400 mt-2 block truncate">
            Configured constraints
          </span>
        </div>
      </div>

      {/* Confidence Score Bar */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex justify-between items-center text-xs">
          <span className="font-mono text-slate-400">Verifier Confidence Rating</span>
          <span className="font-mono text-slate-300">
            {actualScore !== null ? `${actualScore}%` : 'No score'} / Target: {targetThreshold}%
          </span>
        </div>

        <div className="relative pt-1">
          {/* Target marker indicator */}
          <div 
            className="absolute bottom-4 mb-2 flex flex-col items-center z-10 transition-all duration-500"
            style={{ left: `${targetThreshold}%`, transform: 'translateX(-50%)' }}
          >
            <span className="px-1.5 py-0.5 rounded text-[8px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
              Target
            </span>
            <div className="w-0.5 h-3 bg-slate-500 mt-0.5"></div>
          </div>

          <div className="w-full bg-slate-800 h-3 rounded-full overflow-hidden flex relative">
            {/* Target line in the background bar */}
            <div 
              className="absolute top-0 bottom-0 border-l border-dashed border-slate-500 z-0"
              style={{ left: `${targetThreshold}%` }}
            ></div>
            
            {/* Actual Confidence Value bar */}
            {actualScore !== null && (
              <div 
                className={`h-full z-10 rounded-full transition-all duration-500 ${
                  actualScore >= targetThreshold 
                    ? 'bg-emerald-500' 
                    : 'bg-amber-500'
                }`}
                style={{ width: `${actualScore}%` }}
              ></div>
            )}
          </div>
        </div>
        
        <p className="text-[10px] text-slate-400 leading-relaxed">
          {actualScore !== null
            ? actualScore >= targetThreshold
              ? '✔ The response successfully cleared the target confidence threshold.'
              : '⚠ Threshold not cleared. Response returned at maximum loop capacity.'
            : 'Response verification was skipped for this policy.'}
        </p>
      </div>

      {/* BCI Classifier Metrics (New Research-Grade Section) */}
      {metadata && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex justify-between items-center text-xs border-b border-slate-800/80 pb-2">
            <span className="font-semibold text-slate-300 flex items-center space-x-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
              <span>BCI Workload Decoder</span>
            </span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
              metadata.dev_mode 
                ? 'bg-amber-950/40 text-amber-400 border border-amber-800/30' 
                : 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30'
            }`}>
              {metadata.dev_mode ? 'Dev Mode (Override)' : 'Auto EEG Decoded'}
            </span>
          </div>
          
          <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
            <div className="bg-slate-950/30 border border-slate-900 rounded-lg p-2.5">
              <div className="text-[9px] text-slate-400 uppercase tracking-tight">EEG State</div>
              <div className={`mt-1 font-bold ${
                metadata.predicted_workload === 'HIGH' ? 'text-amber-400' :
                metadata.predicted_workload === 'MEDIUM' ? 'text-emerald-400' : 'text-cyan-400'
              }`}>
                {metadata.predicted_workload || 'N/A'}
              </div>
            </div>
            <div className="bg-slate-950/30 border border-slate-900 rounded-lg p-2.5">
              <div className="text-[9px] text-slate-400 uppercase tracking-tight">Decoder Conf</div>
              <div className="mt-1 font-bold text-slate-200">
                {metadata.prediction_confidence !== undefined && metadata.prediction_confidence !== null
                  ? `${Math.round(metadata.prediction_confidence * 100)}%`
                  : 'N/A'}
              </div>
            </div>
            <div className="bg-slate-950/30 border border-slate-900 rounded-lg p-2.5">
              <div className="text-[9px] text-slate-400 uppercase tracking-tight">BCI Latency</div>
              <div className="mt-1 font-bold text-slate-200">
                {metadata.prediction_time_ms !== undefined && metadata.prediction_time_ms !== null
                  ? `${metadata.prediction_time_ms.toFixed(1)} ms`
                  : 'N/A'}
              </div>
            </div>
          </div>
          
          <p className="text-[9px] text-slate-400 leading-normal font-sans">
            {metadata.dev_mode 
              ? 'System is running in Developer / Testing Mode. EEG classifier ran in background but policy routed via manual override.'
              : `Workload classifier successfully analyzed EEG signals in real-time, resolving a ${metadata.predicted_workload} state in ${metadata.prediction_time_ms?.toFixed(1) || '0.0'}ms.`}
          </p>
        </div>
      )}
    </div>
  );
}
