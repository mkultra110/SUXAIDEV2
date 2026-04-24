import { useState } from 'react';
import './CodeBlock.css';

interface Props {
  code: string;
  language: string;
  onApply?: (code: string) => void;
  onDiff?: (code: string) => void;
}

export function CodeBlock({ code, language, onApply, onDiff }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="codeblk">
      <div className="codeblk__head">
        <span className="codeblk__lang">{language}</span>
        <div className="codeblk__actions">
          <button className="codeblk__btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {onDiff && (
            <button className="codeblk__btn" onClick={() => onDiff(code)} title="Review as a diff with accept/reject">
              Diff
            </button>
          )}
          {onApply && (
            <button className="codeblk__btn codeblk__btn--primary" onClick={() => onApply(code)}>
              Apply
            </button>
          )}
        </div>
      </div>
      <pre className="codeblk__pre"><code>{code}</code></pre>
    </div>
  );
}
