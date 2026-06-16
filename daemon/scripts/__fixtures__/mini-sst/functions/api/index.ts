// Fixture Hono app for route-extract (Story SG-1.4).
// Mirrors the real functions/api/index.ts shape: public routes, an
// authMiddleware-guarded route, and a :param route. NOT deployed.

import { Hono } from 'hono';
import { authMiddleware } from './auth-middleware';

const app = new Hono();

// Public — no auth.
app.get('/api/health', (c) => c.json({ ok: true }));

// Public — no auth.
app.post('/api/scores', async (c) => {
  const body = await c.req.json();
  return c.json({ saved: body });
});

// Public — no auth.
app.get('/api/leaderboard', async (c) => c.json({ scores: [] }));

// Auth-guarded — authMiddleware in the chain → endpoint.auth === true.
app.get('/api/me', authMiddleware, (c) => c.json({ user: null }));

// Param route — endpoint.path keeps the :id template.
app.get('/api/scores/:id', async (c) => c.json({ id: c.req.param('id') }));

export const handler = app;
