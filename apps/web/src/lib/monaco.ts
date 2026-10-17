import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

/**
 * Monaco is bundled locally (no CDN). Language workers provide IntelliSense and diagnostics for
 * TypeScript/JavaScript, JSON, CSS and HTML; other languages get syntax highlighting.
 */
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

const ts = (monaco.languages as unknown as {
  typescript: {
    typescriptDefaults: { setCompilerOptions(o: object): void; setDiagnosticsOptions(o: object): void; setEagerModelSync(v: boolean): void };
    javascriptDefaults: { setCompilerOptions(o: object): void; setEagerModelSync(v: boolean): void };
    ScriptTarget: Record<string, number>;
    ModuleKind: Record<string, number>;
    ModuleResolutionKind: Record<string, number>;
    JsxEmit: Record<string, number>;
  };
}).typescript;
if (ts) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowJs: true,
    allowNonTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    strict: true,
  };
  ts.typescriptDefaults.setCompilerOptions(options);
  ts.javascriptDefaults.setCompilerOptions(options);
  // Open files share one project so cross-file IntelliSense works for files the user opened.
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);
  // Unresolved module imports are expected (dependencies are not loaded into the browser).
  ts.typescriptDefaults.setDiagnosticsOptions({ diagnosticCodesToIgnore: [2307, 2792, 7016] });
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', swift: 'swift', sql: 'sql', sh: 'shell', bash: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', svg: 'xml', dockerfile: 'dockerfile', vue: 'html', graphql: 'graphql',
};

export function languageFor(path: string): string {
  const name = path.split('/').pop()!.toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return LANG_BY_EXT[ext] ?? 'plaintext';
}

export { monaco };
