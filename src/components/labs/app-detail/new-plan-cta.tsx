'use client';

import { Button } from '@/components/ui/button';

export function NewPlanCta({
  canStart,
  blockReason,
  isFirst,
  onClick,
}: {
  canStart: boolean;
  blockReason?: string;
  isFirst: boolean;
  onClick: () => void;
}) {
  const label = isFirst ? 'Start your first Plan' : '+ New Plan';

  if (canStart) {
    return (
      <Button onClick={onClick} variant="default" size="default">
        {label}
      </Button>
    );
  }

  return (
    <Button
      disabled
      variant="outline"
      size="default"
      title={blockReason ?? 'Cannot start a new Plan right now.'}
    >
      {label}
    </Button>
  );
}
