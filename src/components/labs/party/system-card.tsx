'use client';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

export function SystemCard({ children }: Props) {
  return (
    <div className="my-1 ml-[52px] pl-3 border-l-2 border-border text-[13px] text-muted-foreground py-1.5">
      {children}
    </div>
  );
}
