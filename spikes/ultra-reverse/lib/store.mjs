// store.mjs — corpus persistence (locked §8.3: DynamoDB + S3, no Postgres).
//
// Pluggable backend so the slice runs on the local FileStore today and graduates to DynamoDB+S3
// without touching the scorers. The corpus is append-mostly (one row per run), which fits DDB+S3
// and Futurator's zero-cost-serverless / one-table-per-concern conventions.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {{ put(record:object):Promise<string>, get(runId:string):Promise<object|null>, list():Promise<object[]> }} Store */

/** Local JSON store — default for the spike. One file per run. */
export class FileStore {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  async put(record) {
    const path = join(this.dir, `${record.runId}.scorecard.json`);
    writeFileSync(path, JSON.stringify(record, null, 2));
    return path;
  }
  async get(runId) {
    const path = join(this.dir, `${runId}.scorecard.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }
  async list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.scorecard.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')));
  }
}

/**
 * DynamoDB + S3 store (locked §8.3). Metadata row → DDB; large artifacts (scriptJs, planSpec,
 * per-rep DecisionPlans) → S3, with the S3 key stored on the DDB row.
 *
 * Table shape (mirrors module-spec §9 / Futurator one-table-per-concern):
 *   UltraReverseRuns { runId (PK), intent, target, rigor, reps, claudeVersion, promptVersion,
 *                      structuralScore, guardrailUplift, verdict, scorecardS3Key, createdAt }
 * S3 layout: s3://<bucket>/ultra-reverse/<runId>/{scriptJs.js, planSpec.json, scorecard.json}
 *
 * Intentionally NOT wired here: it needs AWS creds + the SST-provisioned table/bucket (a deploy-time
 * concern). Construct it only once `UR_RUNS_TABLE` + `UR_ARTIFACTS_BUCKET` are set; otherwise the
 * factory below hands back a FileStore so local runs never block. Wire via the existing
 * functions/shared/repositories pattern (DocumentClient) when promoting out of spikes/.
 */
export class DynamoStore {
  constructor({ tableName, bucket } = {}) {
    this.tableName = tableName || process.env.UR_RUNS_TABLE;
    this.bucket = bucket || process.env.UR_ARTIFACTS_BUCKET;
    if (!this.tableName || !this.bucket) {
      throw new Error('DynamoStore requires UR_RUNS_TABLE + UR_ARTIFACTS_BUCKET (deploy-time). Use FileStore locally.');
    }
  }
  async put() { throw new Error('DynamoStore.put not wired in spikes/ — promote to functions/shared/repositories with DocumentClient + PutObject (locked §8.3).'); }
  async get() { throw new Error('DynamoStore.get not wired in spikes/'); }
  async list() { throw new Error('DynamoStore.list not wired in spikes/'); }
}

/** Pick a backend from env; default to a local FileStore so the slice always runs. */
export function createStore({ dir, backend } = {}) {
  const chosen = backend ?? process.env.UR_STORE ?? 'file';
  if (chosen === 'dynamo') return new DynamoStore();
  return new FileStore(dir ?? join(process.cwd(), 'ultra-reverse-runs'));
}
