'use client';
import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from 'next-themes';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
  readOnly?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  placeholder,
  minHeight = '120px',
  readOnly = false,
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(() => [markdown()], []);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={resolvedTheme === 'dark' ? oneDark : undefined}
      placeholder={placeholder}
      readOnly={readOnly}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
      }}
      style={{ minHeight, fontSize: '13px' }}
      className="overflow-hidden rounded-md border border-input"
    />
  );
}
