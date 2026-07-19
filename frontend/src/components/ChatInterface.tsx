'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Message, WorkloadState } from '../types';
import { WORKLOAD_POLICIES } from './WorkloadSelector';

interface ChatInterfaceProps {
  messages: Message[];
  onSendMessage: (text: string) => void;
  isLoading: boolean;
  activeWorkload: WorkloadState;
}

export default function ChatInterface({ messages, onSendMessage, isLoading, activeWorkload }: ChatInterfaceProps) {
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isLoading) return;
    onSendMessage(inputText);
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl h-[600px] flex flex-col justify-between overflow-hidden shadow-[0_4px_30px_rgba(0,0,0,0.2)]">
      {/* Header */}
      <div className="bg-slate-950/60 border-b border-slate-800/80 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="text-sm font-bold text-slate-200">Adaptive AI Session</span>
        </div>
        <span className="text-xs text-slate-400 font-mono">
          Model: qwen3:8b
        </span>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center space-y-3 opacity-60">
            <svg className="w-10 h-10 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-slate-300">No messages yet</p>
              <p className="text-xs text-slate-500 mt-1">Start a conversation by typing a query below.</p>
            </div>
          </div>
        ) : (
          messages.map((message) => {
            const isUser = message.sender === 'user';
            
            return (
              <div 
                key={message.id} 
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} space-y-1`}
              >
                {/* Sender name & time */}
                <div className="flex items-center space-x-2 text-[10px] text-slate-500 font-mono">
                  <span>{isUser ? 'You' : 'Adaptive Agent System'}</span>
                  <span>•</span>
                  <span>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>

                {/* Message Bubble */}
                <div 
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    isUser 
                      ? 'bg-slate-100 text-slate-900 rounded-tr-none font-semibold' 
                      : 'bg-slate-950/80 border border-slate-800 text-slate-200 rounded-tl-none font-normal'
                  }`}
                >
                  <div className="whitespace-pre-wrap font-sans break-words">
                    {message.text}
                  </div>

                  {/* Metadata report for AI messages */}
                  {!isUser && message.metadata && (
                    <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap gap-2 text-[9px] font-mono text-slate-400 select-none">
                      <span className="bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-md">
                        Workload State: <strong className={message.workload ? WORKLOAD_POLICIES[message.workload].textColorClass : 'text-slate-300'}>{message.workload}</strong>
                      </span>
                      <span className="bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-md">
                        Agents: <strong>{message.metadata.agents_used}</strong>
                      </span>
                      {message.metadata.verification_loops > 0 && (
                        <span className="bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-md">
                          Loops: <strong>{message.metadata.verification_loops}</strong>
                        </span>
                      )}
                      {message.metadata.confidence_score !== undefined && message.metadata.confidence_score !== null && (
                        <span className="bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-md">
                          Confidence: <strong>{message.metadata.confidence_score}%</strong>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {/* Typing indicator */}
        {isLoading && (
          <div className="flex flex-col items-start space-y-1">
            <div className="flex items-center space-x-2 text-[10px] text-slate-500 font-mono">
              <span>Adaptive Agent System</span>
              <span>•</span>
              <span>Thinking...</span>
            </div>
            
            <div className="bg-slate-950/40 border border-slate-850 rounded-2xl rounded-tl-none px-4 py-3 flex items-center space-x-1.5 h-10 select-none">
              <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
              <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
              <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="bg-slate-950/60 border-t border-slate-800/80 px-6 py-4 flex items-end space-x-3">
        <textarea
          rows={1}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Type a question (e.g. "Explain recursion") in ${activeWorkload} state...`}
          disabled={isLoading}
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-slate-700 resize-none max-h-[80px] min-h-[38px] scrollbar-none disabled:opacity-50"
        />
        
        <button
          type="submit"
          disabled={!inputText.trim() || isLoading}
          className="h-[38px] bg-slate-100 hover:bg-slate-200 text-slate-950 disabled:bg-slate-850 disabled:text-slate-600 disabled:cursor-not-allowed px-4 rounded-xl flex items-center justify-center font-semibold text-xs tracking-wide transition-all duration-200 shrink-0"
        >
          Send
        </button>
      </form>
    </div>
  );
}
