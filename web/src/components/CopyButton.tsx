import { type ButtonHTMLAttributes, useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/browser.ts';

export function CopyButton({ text, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { text: string }) {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <>
    <button {...props} type="button" onClick={async () => {
      clearTimeout(timer.current);
      try {
        await copyText(text);
        setStatus('Copied');
      } catch {
        setStatus('Copy failed. Select and copy the text.');
      }
      timer.current = setTimeout(() => setStatus(''), 4000);
    }}>{children}</button>
    {status && <span className="small" role="status">{status}</span>}
  </>;
}
