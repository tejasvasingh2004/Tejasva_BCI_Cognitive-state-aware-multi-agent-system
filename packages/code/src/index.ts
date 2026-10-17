import type { ToolDefinition } from '@neuroflow/tools';
import type { CodeServices } from './services';
import { editingTools } from './tools/editing';
import { executionTools } from './tools/execution';
import { gitTools } from './tools/git';
import { githubTools } from './tools/github';
import { repositoryTools } from './tools/repository';

export * from './paths';
export * from './git';
export * from './sandbox';
export * from './policy';
export * from './detect';
export * from './repo-index';
export * from './patch';
export * from './begin-patch';
export * from './workspace';
export * from './github';
export * from './services';
export * from './secrets';
export * from './test-summary';
export { emitDiffUpdate, highImpactReason } from './tools/editing';
export { runInSandbox } from './tools/execution';
export { AGENT_BRANCH_PREFIX, agentBranchName } from './tools/git';

/** Tool families of the Code Agent (PRD §56.10), in registry order. */
export const CODE_TOOL_FAMILIES = {
  repository: ['list_files', 'read_file', 'search_code', 'find_symbol', 'find_references'],
  editing: ['create_file', 'edit_file', 'rename_file', 'delete_file', 'apply_patch'],
  execution: ['run_command', 'run_tests', 'run_linter', 'run_build'],
  git: ['git_status', 'git_diff', 'git_log', 'create_branch', 'commit', 'push'],
  github: ['get_repository', 'get_branch', 'get_pull_requests', 'get_issues', 'create_issue', 'create_pull_request', 'review_pull_request'],
} as const;

export const CODE_TOOL_NAMES: string[] = Object.values(CODE_TOOL_FAMILIES).flat();
/** Tools still available in Restricted (read-only) mode. */
export const READ_ONLY_CODE_TOOLS: string[] = [
  ...CODE_TOOL_FAMILIES.repository,
  'git_status',
  'git_diff',
  'git_log',
  'get_repository',
  'get_branch',
  'get_pull_requests',
  'get_issues',
];

/** All Code Agent tools, registered in the shared Tool Registry like any other capability. */
export function createCodeTools(services: CodeServices): ToolDefinition[] {
  return [...repositoryTools(services), ...editingTools(services), ...executionTools(services), ...gitTools(services), ...githubTools(services)].map(
    (t) => ({ ...t, requiresWorkspace: true }),
  );
}
export * from './db-services';
