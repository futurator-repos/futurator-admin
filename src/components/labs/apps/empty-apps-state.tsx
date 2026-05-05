'use client';

import { Button } from '@/components/ui/button';

export function EmptyAppsState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-4 text-6xl" aria-hidden>
        📦
      </div>
      <h2 className="text-2xl font-semibold">No Apps yet.</h2>
      <p className="mt-2 max-w-md text-muted-foreground">
        Each App is a product you&apos;re building. Start with your first one.
      </p>
      <Button onClick={onCreate} className="mt-6">
        + Create your first App
      </Button>
    </div>
  );
}
