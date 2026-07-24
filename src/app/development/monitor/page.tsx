'use client';
/**
 * The standalone EC2 Monitor was folded into the Servers module as the
 * "Dashboard" tab. This route is kept as a redirect so existing bookmarks
 * and cross-page links (e.g. the agentic-office board deep-link) still land
 * in the right place.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function MonitorRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/development/servers?tab=dashboard');
  }, [router]);
  return <p className="p-4 text-sm text-muted-foreground">Redirecting to Servers → Dashboard…</p>;
}
