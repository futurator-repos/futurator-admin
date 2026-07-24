'use client';
/**
 * The standalone Queues module was folded into the Servers module as the
 * "Queue" tab. This route is kept as a redirect so existing bookmarks and
 * cross-page links (?tab=queue) still land in the right place.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function QueuesRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/development/servers?tab=queue');
  }, [router]);
  return <p className="p-4 text-sm text-muted-foreground">Redirecting to Servers → Queue…</p>;
}
