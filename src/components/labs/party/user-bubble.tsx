'use client';

interface Props {
  content: string;
}

export function UserBubble({ content }: Props) {
  return (
    <div className="flex justify-end my-1">
      <div
        className="max-w-[70%] bg-card border border-border px-3 py-2 text-[12.5px] font-mono text-foreground whitespace-pre-wrap"
        style={{ borderRadius: '12px 12px 4px 12px' }}
      >
        {content}
      </div>
    </div>
  );
}
