'use client';
import { LoginButton } from '@/components/auth/login-button';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold">Futurator Admin</h1>
        <p className="mt-2 text-muted-foreground">Portfolio cost observatory & control plane</p>
      </div>
      <LoginButton />
    </div>
  );
}
