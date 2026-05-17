import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { ThemeProvider } from '@/components/theme-provider';
import { FreeAgentWidget } from '@/components/free-agent/widget';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Futurator Admin Hub',
  description: 'Centralised cost observatory and control plane for Futurator projects',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          <Providers>
            {children}
            {/* Story 18.4 — Free Claude Code Agent widget. Self-gates on
                auth via the inner useAuthStore subscription, so mounting
                here doesn't expose pre-auth state.
                Suspense boundary required because the widget's scope hook
                calls useSearchParams() — Next 16 requires a boundary for
                client-side query reads during static prerender. */}
            <Suspense fallback={null}>
              <FreeAgentWidget />
            </Suspense>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
