'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, GitBranch, KeyRound, Loader2, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateMigration } from '@/hooks/use-migrations';
import { EnvVarEditor, parseEnvText, type ParseResult } from './env-var-editor';

interface MigrationWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Mirrors functions/shared/types/party.ts (PROJECT_ID_REGEX) +
// GITHUB_HTTPS_URL_REGEX. Server re-validates via zod; this just gates
// the Submit button.
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const URL_REGEX = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;
const BRANCH_REGEX = /^\S+$/;
const PAT_PREFIX_REGEX = /^(github_pat_|ghp_|github_token_)/;

type Step = 1 | 2 | 3 | 4;

/**
 * 4-step migration wizard for the Migrate page.
 *   1. Source — GitHub URL + branch + derived name
 *   2. Auth — fine-grained PAT (write-only)
 *   3. Env — runtime env vars (KEY=value editor)
 *   4. Confirm — summary card + Start migration button
 *
 * On success, navigates to `/debates?sessionId=...` — wait no, the
 * bootstrap doesn't create a session. Navigates back to /migrate to
 * show the new card with INSTALLING state; the operator can drill in.
 */
export function MigrationWizard({ open, onOpenChange }: MigrationWizardProps) {
  const router = useRouter();
  const create = useCreateMigration();

  const [step, setStep] = useState<Step>(1);
  const [gitRepoUrl, setGitRepoUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [name, setName] = useState('');
  const [pat, setPat] = useState('');
  const [envText, setEnvText] = useState('');
  const [envParse, setEnvParse] = useState<ParseResult>({ vars: {}, errors: [], count: 0 });
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Auto-derive name from URL on step-1 change (operator can override).
  const derivedName = useMemo(() => {
    const m = gitRepoUrl.match(/^https:\/\/github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?$/);
    if (!m) return '';
    return m[1]
      .toLowerCase()
      .replace(/[._]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }, [gitRepoUrl]);

  const effectiveName = name.trim() || derivedName;
  const nameValid = NAME_REGEX.test(effectiveName);
  const urlValid = URL_REGEX.test(gitRepoUrl);
  const branchValid = BRANCH_REGEX.test(gitBranch);
  const patValid = PAT_PREFIX_REGEX.test(pat);

  const step1Valid = urlValid && branchValid && nameValid;
  const step2Valid = patValid;
  const step3Valid = envParse.errors.length === 0; // empty allowed
  const step4Valid = step1Valid && step2Valid && step3Valid;

  function resetForm() {
    setStep(1);
    setGitRepoUrl('');
    setGitBranch('main');
    setName('');
    setPat('');
    setEnvText('');
    setEnvParse({ vars: {}, errors: [], count: 0 });
    setSubmitError(null);
  }

  function handleClose(nextOpen: boolean) {
    if (create.isPending) return;
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  async function handleSubmit() {
    if (!step4Valid || create.isPending) return;
    setSubmitError(null);
    try {
      const result = await create.mutateAsync({
        name: effectiveName,
        gitRepoUrl,
        gitBranch,
        pat,
        envVars: envParse.count > 0 ? envParse.vars : undefined,
      });
      resetForm();
      onOpenChange(false);
      router.push(`/migrate?highlight=${encodeURIComponent(result.projectId)}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start migration');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px]" data-testid="migration-wizard">
        <DialogHeader>
          <DialogTitle>Migrate a brownfield project — step {step} of 4</DialogTitle>
          <DialogDescription>{stepDescription(step)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {step === 1 && (
            <Step1Source
              gitRepoUrl={gitRepoUrl}
              onGitRepoUrlChange={setGitRepoUrl}
              gitBranch={gitBranch}
              onGitBranchChange={setGitBranch}
              name={name}
              derivedName={derivedName}
              onNameChange={setName}
              urlValid={urlValid}
              branchValid={branchValid}
              nameValid={nameValid}
              effectiveName={effectiveName}
            />
          )}
          {step === 2 && (
            <Step2Auth
              pat={pat}
              onPatChange={setPat}
              patValid={patValid}
              projectId={effectiveName}
              gitRepoUrl={gitRepoUrl}
            />
          )}
          {step === 3 && (
            <Step3Env
              envText={envText}
              onEnvTextChange={(t) => {
                setEnvText(t);
                setEnvParse(parseEnvText(t));
              }}
              onParseChange={setEnvParse}
            />
          )}
          {step === 4 && (
            <Step4Confirm
              gitRepoUrl={gitRepoUrl}
              gitBranch={gitBranch}
              projectId={effectiveName}
              envVarCount={envParse.count}
              patPrefix={pat.slice(0, 10) + '…'}
            />
          )}

          {submitError && (
            <p className="text-[11px] text-red-400" role="alert">
              {submitError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleClose(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          {step > 1 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setStep((s) => (s - 1) as Step)}
              disabled={create.isPending}
            >
              <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back
            </Button>
          )}
          {step < 4 ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setStep((s) => (s + 1) as Step)}
              disabled={
                (step === 1 && !step1Valid) ||
                (step === 2 && !step2Valid) ||
                (step === 3 && !step3Valid)
              }
              data-testid={`wizard-next-step-${step}`}
            >
              Next <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit}
              disabled={!step4Valid || create.isPending}
              data-testid="wizard-submit"
            >
              {create.isPending ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Starting…
                </>
              ) : (
                'Start migration'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function stepDescription(step: Step): string {
  switch (step) {
    case 1:
      return 'Where does the project live? Paste the upstream HTTPS GitHub URL.';
    case 2:
      return 'Provide a fine-grained PAT scoped to read this repo. Stored encrypted in AWS Secrets Manager.';
    case 3:
      return 'Optional. Runtime env vars are written to <projectPath>/.env after clone so the project can run.';
    case 4:
      return 'Review and start. The daemon clones the repo, verifies BMAD, and writes your .env in ~30 seconds.';
  }
}

// ── Step components ────────────────────────────────────────────────────

interface Step1Props {
  gitRepoUrl: string;
  onGitRepoUrlChange: (v: string) => void;
  gitBranch: string;
  onGitBranchChange: (v: string) => void;
  name: string;
  derivedName: string;
  onNameChange: (v: string) => void;
  urlValid: boolean;
  branchValid: boolean;
  nameValid: boolean;
  effectiveName: string;
}

function Step1Source(p: Step1Props) {
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="mw-url">GitHub HTTPS URL</Label>
        <Input
          id="mw-url"
          data-testid="wizard-git-url"
          value={p.gitRepoUrl}
          onChange={(e) => p.onGitRepoUrlChange(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="font-mono text-sm"
          aria-invalid={p.gitRepoUrl.length > 0 && !p.urlValid ? 'true' : undefined}
        />
        {p.gitRepoUrl.length > 0 && !p.urlValid && (
          <p className="text-[11px] text-red-400">Must be an HTTPS GitHub URL.</p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="mw-branch">Branch</Label>
        <Input
          id="mw-branch"
          data-testid="wizard-branch"
          value={p.gitBranch}
          onChange={(e) => p.onGitBranchChange(e.target.value)}
          placeholder="main"
          className="font-mono text-sm"
          aria-invalid={!p.branchValid ? 'true' : undefined}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="mw-name">
          Project name <span className="text-muted-foreground">(kebab-case)</span>
        </Label>
        <Input
          id="mw-name"
          data-testid="wizard-name"
          value={p.name}
          onChange={(e) => p.onNameChange(e.target.value)}
          placeholder={p.derivedName || 'songster'}
          className="font-mono text-sm"
          aria-invalid={p.effectiveName.length > 0 && !p.nameValid ? 'true' : undefined}
        />
        <p className="text-[10.5px] text-muted-foreground">
          {p.name
            ? 'Override active'
            : p.derivedName
              ? `Derived from URL → "${p.derivedName}"`
              : 'Will derive from URL'}
        </p>
        {p.effectiveName.length > 0 && !p.nameValid && (
          <p className="text-[11px] text-red-400">Must match ^[a-z0-9][a-z0-9-]{'{0,63}'}$</p>
        )}
      </div>
    </>
  );
}

interface Step2Props {
  pat: string;
  onPatChange: (v: string) => void;
  patValid: boolean;
  projectId: string;
  gitRepoUrl: string;
}

function Step2Auth(p: Step2Props) {
  return (
    <>
      <div className="rounded-md border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-3.5 w-3.5" /> Fine-grained GitHub PAT
        </div>
        <p className="mt-1.5">
          Generate at{' '}
          <span className="font-mono">github.com/settings/personal-access-tokens/new</span> with:
        </p>
        <ul className="mt-1 list-disc pl-5">
          <li>
            Resource owner: the account/org that owns{' '}
            <span className="font-mono">{p.gitRepoUrl || '<your repo>'}</span>
          </li>
          <li>Repository access: only this repo</li>
          <li>Permissions → Repository → Contents: Read-only</li>
        </ul>
        <p className="mt-1.5">
          Stored as{' '}
          <span className="font-mono">futurator/brownfield-pat/{p.projectId || '<projectId>'}</span>{' '}
          in AWS Secrets Manager. The PAT is never shown again after save.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="mw-pat">PAT</Label>
        <Input
          id="mw-pat"
          data-testid="wizard-pat"
          type="password"
          value={p.pat}
          onChange={(e) => p.onPatChange(e.target.value)}
          placeholder="github_pat_…"
          className="font-mono text-sm"
          aria-invalid={p.pat.length > 0 && !p.patValid ? 'true' : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        {p.pat.length > 0 && !p.patValid && (
          <p className="text-[11px] text-red-400">
            Must start with github_pat_, ghp_, or github_token_.
          </p>
        )}
      </div>
    </>
  );
}

interface Step3Props {
  envText: string;
  onEnvTextChange: (v: string) => void;
  onParseChange: (p: ParseResult) => void;
}

function Step3Env(p: Step3Props) {
  return (
    <>
      <div className="rounded-md border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground">
        Optional runtime env vars. Written to{' '}
        <span className="font-mono">&lt;projectPath&gt;/.env</span> after every clone + refresh so
        the project can boot. Values stay encrypted in DDB and are never displayed in lists.
      </div>
      <EnvVarEditor
        value={p.envText}
        onChange={p.onEnvTextChange}
        onValidityChange={p.onParseChange}
        helperText="Skip this step if the project doesn't need runtime env vars."
      />
    </>
  );
}

interface Step4Props {
  gitRepoUrl: string;
  gitBranch: string;
  projectId: string;
  envVarCount: number;
  patPrefix: string;
}

function Step4Confirm(p: Step4Props) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-4 text-[12.5px]">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-accent-purple" />
        <span className="font-medium">Ready to migrate</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">Project name</dt>
        <dd className="font-mono">{p.projectId}</dd>
        <dt className="text-muted-foreground">Repository</dt>
        <dd className="flex items-center gap-1 font-mono">
          <GitBranch className="h-3 w-3" /> {p.gitRepoUrl}
        </dd>
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="font-mono">{p.gitBranch}</dd>
        <dt className="text-muted-foreground">PAT (preview)</dt>
        <dd className="font-mono">{p.patPrefix}</dd>
        <dt className="text-muted-foreground">Env vars</dt>
        <dd className="font-mono">{p.envVarCount === 0 ? 'none' : `${p.envVarCount} key(s)`}</dd>
      </dl>
      <p className="mt-2 text-[10.5px] text-muted-foreground">
        After Start, the daemon will create the per-project secret, clone the repo, verify BMAD,
        write the .env file, and persist the project as HEALTHY. Typically ~30 seconds.
      </p>
    </div>
  );
}
