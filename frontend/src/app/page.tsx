'use client';

import React, { useState } from 'react';
import { Message, WorkloadState, ChatMetadata } from '../types';
import WorkloadSelector from '../components/WorkloadSelector';
import AgentVisualizer from '../components/AgentVisualizer';
import SystemMetrics from '../components/SystemMetrics';
import ChatInterface from '../components/ChatInterface';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function Home() {
  const [workload, setWorkload] = useState<WorkloadState>('NORMAL');
  const [devMode, setDevMode] = useState<boolean>(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentMetadata, setCurrentMetadata] = useState<ChatMetadata | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const handleSendMessage = async (text: string) => {
    // 1. Setup user message
    const userMessage: Message = {
      id: Math.random().toString(36).substring(7),
      sender: 'user',
      text,
      timestamp: new Date().toISOString(),
      workload,
    };
    
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);
    setCurrentMetadata(null);
    setLatencyMs(null);

    const startTime = performance.now();

    try {
      // 2. Query FastAPI server with dev_mode and workload override
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question: text,
          workload,
          dev_mode: devMode,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Server returned an error');
      }

      const data = await response.json();
      const endTime = performance.now();
      const duration = Math.round(endTime - startTime);

      // Map backend 'LOW'/'MEDIUM'/'HIGH' back to frontend 'NORMAL'/'MODERATE'/'HIGH'
      let activeState = workload;
      if (data.metadata && data.metadata.workload) {
        const resolved = data.metadata.workload;
        if (resolved === 'LOW') activeState = 'NORMAL';
        else if (resolved === 'MEDIUM') activeState = 'MODERATE';
        else activeState = 'HIGH';
      }

      // 3. Setup AI message
      const aiMessage: Message = {
        id: Math.random().toString(36).substring(7),
        sender: 'ai',
        text: data.answer,
        timestamp: new Date().toISOString(),
        workload: activeState,
        metadata: data.metadata,
      };

      setMessages((prev) => [...prev, aiMessage]);
      setCurrentMetadata(data.metadata);
      setLatencyMs(duration);

      // Auto update active workload panel based on predicted workload in non-dev mode
      if (!devMode && data.metadata && data.metadata.workload) {
        setWorkload(activeState);
      }
    } catch (error: any) {
      console.error('API Error:', error);
      const endTime = performance.now();
      const duration = Math.round(endTime - startTime);

      const errorMessage: Message = {
        id: Math.random().toString(36).substring(7),
        sender: 'ai',
        text: `❌ Pipeline Connection Error: Failed to communicate with the adaptive agent backend.\n\nDetails: ${error.message || 'Check if the FastAPI backend is running and reachable.'}`,
        timestamp: new Date().toISOString(),
        workload,
      };

      setMessages((prev) => [...prev, errorMessage]);
      setLatencyMs(duration);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="flex-1 min-h-screen bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(15,23,42,0.6),rgba(3,7,18,1))] text-slate-100 flex flex-col">
      {/* Top Navigation */}
      <header className="border-b border-slate-900 bg-slate-950/40 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="h-6 w-6 rounded-lg bg-gradient-to-br from-cyan-400 via-emerald-400 to-rose-400 flex items-center justify-center font-bold text-xs text-slate-950 font-mono shadow-[0_0_15px_rgba(34,211,238,0.2)]">
              Ω
            </span>
            <span className="font-bold font-mono tracking-tight text-sm text-slate-200">
              COGNITIVE WORKLOAD ADAPTIVE AI
            </span>
          </div>
          <div className="flex items-center space-x-4">
            <span className={`px-2.5 py-1 rounded-full text-[10px] font-semibold font-mono transition-all duration-300 ${
              devMode 
                ? 'bg-amber-950/40 border border-amber-800/30 text-amber-400' 
                : 'bg-cyan-950/40 border border-cyan-800/30 text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.15)]'
            }`}>
              {devMode ? '🔧 Developer Mode Override' : '🧠 BCI Autopilot: Active'}
            </span>
          </div>
        </div>
      </header>

      {/* Main Grid Workspace */}
      <div className="flex-1 max-w-7xl mx-auto w-full px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Hand Column: Chat System (7/12 width) */}
        <section className="lg:col-span-7 flex flex-col space-y-4">
          <div className="border-l-2 border-slate-700 pl-4 py-1">
            <h1 className="text-xl font-bold tracking-tight text-slate-200 font-sans">
              Cognitive-Aware Chat Assistant
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              The agent routing flow and response syntax will automatically adapt to your chosen workload state.
            </p>
          </div>
          <ChatInterface 
            messages={messages} 
            onSendMessage={handleSendMessage} 
            isLoading={isLoading} 
            activeWorkload={workload} 
          />
        </section>

        {/* Right Hand Column: Metrics, Visualization, Controllers (5/12 width) */}
        <section className="lg:col-span-5 flex flex-col space-y-6">
          {/* Workload Control Card */}
          <div className="bg-slate-900/20 border border-slate-900 rounded-2xl p-6 backdrop-blur-sm space-y-4">
            {/* Dev Mode Override Toggle */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-800/80">
              <div>
                <span className="text-xs font-bold font-mono tracking-wider text-slate-200 uppercase">Dev Mode Override</span>
                <p className="text-[10px] text-slate-400 mt-0.5">Manually choose workload state</p>
              </div>
              <button
                type="button"
                onClick={() => setDevMode(!devMode)}
                className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors duration-300 ${
                  devMode ? 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.3)]' : 'bg-slate-800 border border-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-slate-950 transition-transform duration-300 ${
                    devMode ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            
            <WorkloadSelector 
              selectedState={workload} 
              onChange={setWorkload} 
              disabled={!devMode}
            />
          </div>

          {/* Graph visualizer */}
          <div className="bg-slate-900/20 border border-slate-900 rounded-2xl p-6 backdrop-blur-sm">
            <AgentVisualizer 
              currentWorkload={workload} 
              metadata={currentMetadata} 
              isLoading={isLoading} 
            />
          </div>

          {/* Dynamic Metrics */}
          <div className="bg-slate-900/20 border border-slate-900 rounded-2xl p-6 backdrop-blur-sm">
            <SystemMetrics 
              currentWorkload={workload} 
              metadata={currentMetadata} 
              latencyMs={latencyMs} 
            />
          </div>
        </section>
      </div>
    </main>
  );
}
