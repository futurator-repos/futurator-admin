'use client';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { PlanStatus } from '@/types/plan';

const LABEL: Record<PlanStatus, string> = {
  concept: 'Concept',
  developing: 'Developing',
  fixing: 'Fixing',
  review: 'Review',
  delivered: 'Delivered',
  abandoned: 'Abandoned',
  archived: 'Archived',
};

const VARIANT: Record<PlanStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  concept: 'secondary',
  developing: 'default',
  fixing: 'destructive',
  review: 'secondary',
  delivered: 'outline',
  abandoned: 'outline',
  archived: 'outline',
};

const EXTRA_CLASS: Record<PlanStatus, string> = {
  concept: '',
  developing: '',
  fixing: '',
  review: '',
  delivered: 'border-success text-success',
  abandoned: 'opacity-60',
  archived: 'opacity-60',
};

export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  return (
    <Badge variant={VARIANT[status]} className={cn(EXTRA_CLASS[status])}>
      {LABEL[status]}
    </Badge>
  );
}
