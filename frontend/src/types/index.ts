export type WorkloadState = 'NORMAL' | 'MODERATE' | 'HIGH' | 'OVERLOADED';

export interface ChatMetadata {
  workload: WorkloadState;
  dev_mode: boolean;
  predicted_workload?: string | null;
  prediction_confidence?: number | null;
  prediction_time_ms?: number | null;
  agents_used: number;
  verification_loops: number;
  confidence_threshold: number;
  detail_level: string;
  visited_nodes: string[];
  confidence_score?: number | null;
}

export interface Message {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
  workload?: WorkloadState;
  metadata?: ChatMetadata;
}

export interface WorkloadPolicy {
  state: WorkloadState;
  agents_count: number;
  verification_loops: number;
  confidence_threshold: number;
  detail_level: string;
  description: string;
  colorClass: string;
  textColorClass: string;
  borderColorClass: string;
  bgClass: string;
  agents_used: string[];
}
