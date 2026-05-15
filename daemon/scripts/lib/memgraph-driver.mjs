/**
 * Memgraph Driver Factory
 *
 * Single source of truth for Memgraph bolt URI + auth across all scripts.
 * Reads from env so EC2 (`/opt/futurator-daemon/.env`) can carry credentials
 * without each script duplicating the resolution.
 *
 * Env:
 *   MEMGRAPH_URI       — bolt URI (default: bolt://localhost:7687)
 *   MEMGRAPH_USER      — optional; if set, basic auth is enabled
 *   MEMGRAPH_PASSWORD  — optional; paired with MEMGRAPH_USER
 */

import neo4j from 'neo4j-driver';

export const BOLT_URI = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';

export function createDriver() {
  const user = process.env.MEMGRAPH_USER;
  const password = process.env.MEMGRAPH_PASSWORD;
  return user
    ? neo4j.driver(BOLT_URI, neo4j.auth.basic(user, password || ''))
    : neo4j.driver(BOLT_URI);
}
