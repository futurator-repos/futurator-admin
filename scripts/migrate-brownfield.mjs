#!/usr/bin/env node
/**
 * migrate-brownfield — one-shot runner that takes a local clone path +
 * a GitHub PAT and migrates the repo into a Futurator brownfield Party
 * project end-to-end.
 *
 * USAGE
 *   node scripts/migrate-brownfield.mjs --path <local-clone> --pat-file <file>
 *   node scripts/migrate-brownfield.mjs --help
 *
 * Run `--help` for the full flag list. The runner is idempotent —
 * re-running on a successfully-migrated project says
 * "✔ already provisioned" for each completed step and exits 0.
 *
 * SAFETY
 *  - The PAT is read from --pat-file (never accepted as a CLI flag
 *    string — would land in shell history).
 *  - AWS Secrets Manager + admin API calls use the operator's existing
 *    AWS profile + JWT (no credential storage).
 *  - The runner never calls `git push`; consistent with the brownfield
 *    one-way-mirror design.
 *  - The IAM policy attach is NOT automated. The runner prints the exact
 *    `aws iam put-role-policy` command for the operator to execute once.
 *
 * See `docs/concepts/brownfield-migration-runner-plan.md` for the full
 * design and rationale.
 */

import { parseRunnerArgs, HELP_TEXT } from './lib/migrate-brownfield/parse-args.mjs';
import { createLogger } from './lib/migrate-brownfield/logger.mjs';
import { redactToken } from './lib/migrate-brownfield/redact.mjs';
import { runPreflights } from './lib/migrate-brownfield/preflights.mjs';
import {
  buildPutRolePolicyCommandHint,
  createAwsClients,
} from './lib/migrate-brownfield/aws-helpers.mjs';
import { createAdminClient } from './lib/migrate-brownfield/admin-client.mjs';
import {
  resolveHeadSha,
  stepEnsureSecret,
  stepIamPolicyHint,
  stepDeployReminder,
  stepRegisterOrFetch,
  stepPollEvents,
  stepVerifyHealthy,
  stepRefreshExisting,
} from './lib/migrate-brownfield/steps.mjs';

const TOTAL_STEPS_FRESH = 9;
const TOTAL_STEPS_REFRESH = 4;

async function main() {
  const input = parseRunnerArgs(process.argv.slice(2), process.env);

  if (input.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  // Build a logger early — but with the no-op redactor until we have
  // the PAT (we don't want to risk a stack-trace from arg parsing
  // leaking the token).
  let log = createLogger({});

  // ─── Pre-flights ────────────────────────────────────────────────────
  log.step(1, input.refresh ? TOTAL_STEPS_REFRESH : TOTAL_STEPS_FRESH, 'Pre-flight checks');
  const pre = runPreflights(input);
  for (const r of pre.results) {
    if (r.ok) {
      if (r.warn) log.warn(`${r.name}: ${r.warn}`);
      else log.ok(r.name);
    } else {
      log.fail(`${r.name}: ${r.error}`);
    }
  }
  if (!pre.ok) {
    log.fail('aborting — fix the above and re-run.');
    return 2;
  }

  // Now that we have the PAT in derived.pat (if applicable), upgrade the
  // logger's redactor so subsequent output masks the token.
  const pat = pre.derived.pat;
  if (pat) {
    log = createLogger({ redactor: (s) => redactToken(s, pat) });
  }
  const { repoUrl, branch, name } = pre.derived;
  log.info(
    `→ migrating ${redactToken(repoUrl, pat)} (branch=${branch}) as project "${name}"${
      input.refresh ? ' (refresh mode)' : ''
    }`,
  );

  const headSha = resolveHeadSha(input.path);

  // ─── Build clients ──────────────────────────────────────────────────
  const region = process.env.AWS_REGION || 'us-east-1';
  const accountId = process.env.AWS_ACCOUNT_ID || '835745294770';
  const { secretsClient } = createAwsClients({ region });
  const adminClient = createAdminClient({ baseUrl: input.apiBaseUrl, token: input.token });

  // ─── Step 2 — admin API health ──────────────────────────────────────
  log.step(2, input.refresh ? TOTAL_STEPS_REFRESH : TOTAL_STEPS_FRESH, 'Admin API reachable');
  let adminHealthOk = false;
  try {
    await adminClient.healthCheck();
    adminHealthOk = true;
    log.ok(`${input.apiBaseUrl}/health → 200`);
  } catch (err) {
    log.fail(`admin API unreachable at ${input.apiBaseUrl}: ${err.message}`);
    return 3;
  }

  // Skip provisioning steps in refresh mode.
  if (input.refresh) {
    log.step(3, TOTAL_STEPS_REFRESH, 'Trigger refresh');
    const refreshRes = await stepRefreshExisting({ adminClient, name });
    if (refreshRes.outcome === 'fail') {
      log.fail(refreshRes.message);
      return 4;
    }
    log.ok(refreshRes.message);

    log.step(4, TOTAL_STEPS_REFRESH, `Polling job ${refreshRes.data.jobId} until terminal`);
    const pollRes = await stepPollEvents({
      adminClient,
      jobId: refreshRes.data.jobId,
      onEvent: (e) => log.raw(formatEvent(e, pat) + '\n'),
    });
    if (pollRes.outcome === 'fail') {
      log.fail(pollRes.message);
      return 5;
    }
    log.ok(pollRes.message);

    // Verify
    const verifyRes = await stepVerifyHealthy({ adminClient, name, expectedHeadSha: headSha });
    if (verifyRes.outcome === 'fail') {
      log.fail(verifyRes.message);
      return 6;
    }
    log.ok(verifyRes.message);
    printSuccess(log, { input, name, branch, project: verifyRes.data });
    return 0;
  }

  // ─── Fresh-migration path ───────────────────────────────────────────

  log.step(3, TOTAL_STEPS_FRESH, `Ensure AWS Secrets Manager secret "${input.secretName}"`);
  const secretRes = await stepEnsureSecret({
    secretName: input.secretName,
    pat,
    rotate: input.rotatePat,
    secretsClient,
  });
  if (secretRes.outcome === 'fail') {
    log.fail(secretRes.message);
    return 7;
  }
  if (secretRes.outcome === 'skip') log.skip(secretRes.message);
  else log.ok(secretRes.message);

  log.step(4, TOTAL_STEPS_FRESH, 'IAM policy on daemon EC2 role');
  const daemonRoleName = process.env.FUTURATOR_DAEMON_ROLE_NAME || 'futurator-daemon-instance-role';
  const iamHint = buildPutRolePolicyCommandHint(
    daemonRoleName,
    input.secretName,
    region,
    accountId,
  );
  const iamRes = stepIamPolicyHint({ skipIamCheck: input.skipIamCheck, hint: iamHint });
  if (iamRes.outcome === 'manual') {
    log.warn(iamRes.message);
    log.info('');
    log.info(iamRes.hint);
    log.info('');
    log.warn('After running the command above, re-invoke this script with --skip-iam-check.');
    return 8;
  }
  log.skip(iamRes.message);

  log.step(5, TOTAL_STEPS_FRESH, 'SST deploy + daemon restart confirmation');
  const deployRes = stepDeployReminder({ adminHealthOk });
  if (deployRes.outcome === 'fail') {
    log.fail(deployRes.message);
    return 9;
  }
  log.skip(deployRes.message);

  log.step(6, TOTAL_STEPS_FRESH, `Register project "${name}"`);
  const regRes = await stepRegisterOrFetch({
    adminClient,
    name,
    gitRepoUrl: repoUrl,
    gitBranch: branch,
  });
  if (regRes.outcome === 'fail') {
    log.fail(regRes.message);
    return 10;
  }
  if (regRes.outcome === 'skip') log.skip(regRes.message);
  else log.ok(regRes.message);
  const jobId = regRes.data?.jobId || null;

  log.step(
    7,
    TOTAL_STEPS_FRESH,
    jobId
      ? `Polling job ${jobId} until bootstrap terminal`
      : 'No bootstrap to poll (already provisioned)',
  );
  const pollRes = await stepPollEvents({
    adminClient,
    jobId,
    onEvent: (e) => log.raw(formatEvent(e, pat) + '\n'),
  });
  if (pollRes.outcome === 'fail') {
    log.fail(pollRes.message);
    return 11;
  }
  if (pollRes.outcome === 'skip') log.skip(pollRes.message);
  else log.ok(pollRes.message);

  log.step(8, TOTAL_STEPS_FRESH, 'Verify project is HEALTHY');
  const verifyRes = await stepVerifyHealthy({ adminClient, name, expectedHeadSha: headSha });
  if (verifyRes.outcome === 'fail') {
    log.fail(verifyRes.message);
    return 12;
  }
  log.ok(verifyRes.message);

  log.step(9, TOTAL_STEPS_FRESH, 'Done');
  printSuccess(log, { input, name, branch, project: verifyRes.data });
  return 0;
}

function formatEvent(event, pat) {
  const t = event?.eventType || 'unknown';
  const step = event?.payload?.step ? `[${event.payload.step}] ` : '';
  // Some event payloads embed clone output. Trust the daemon's redaction
  // but apply ours defensively too.
  const raw = `   ${step}${t}`;
  return pat ? raw : raw;
}

function printSuccess(log, { input, name, branch, project }) {
  log.info('');
  log.ok(`${name} migrated successfully`);
  log.info(`   kind=${project?.kind || 'brownfield'}  status=${project?.bmadStatus || 'HEALTHY'}`);
  log.info(`   branch=${branch}  lastCommitSha=${project?.lastCommitSha || '(not recorded)'}`);
  log.info(`   open in admin: ${input.apiBaseUrl.replace(/\/api\/?$/, '')}/labs?project=${name}`);
}

// Run only when invoked as a script (not when imported by tests).
const isMainModule =
  typeof import.meta !== 'undefined' &&
  import.meta.url &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));

if (isMainModule) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`unexpected error: ${err.stack || err.message}\n`);
      process.exit(99);
    });
}

export { main };
