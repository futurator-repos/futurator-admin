'use client';
import { useEffect, Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/stores/auth-store';
import { API_BASE_URL } from '@/lib/constants';

function CallbackContent() {
  const searchParams = useSearchParams();
  const { setAuth } = useAuthStore();
  const [status, setStatus] = useState('Signing you in...');

  useEffect(() => {
    const error = searchParams.get('error');
    if (error) {
      window.location.href = `/login/?error=${error}`;
      return;
    }

    const code = searchParams.get('code');
    if (!code) {
      window.location.href = '/login/';
      return;
    }

    // Exchange OTP code with the API Lambda (server-side exchange with broker)
    const apiBase = API_BASE_URL.replace(/\/+$/, '');
    fetch(`${apiBase}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || 'Exchange failed');
        }
        return res.json();
      })
      .then((data) => {
        setAuth(data.user, {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          familyId: data.familyId,
          tokenId: data.tokenId,
          expiresIn: data.expiresIn,
        });
        window.location.href = '/';
      })
      .catch((err) => {
        setStatus(`Sign in failed: ${err.message}`);
        setTimeout(() => {
          window.location.href = '/login/';
        }, 2000);
      });
  }, [searchParams, setAuth]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      <p className="text-sm text-muted-foreground">{status}</p>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
        </div>
      }
    >
      <CallbackContent />
    </Suspense>
  );
}
