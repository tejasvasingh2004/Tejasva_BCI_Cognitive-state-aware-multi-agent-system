import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="prose-nf" data-testid="assistant-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-caret rounded bg-accent align-middle" />}
    </div>
  );
});
