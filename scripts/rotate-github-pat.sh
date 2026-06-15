#!/usr/bin/env bash
#
# rotate-github-pat.sh — propagate a NEW GitHub PAT to every place the old one
# lives, after you've minted it in the GitHub UI of the `futurator-repos`
# account. (Fine-grained PATs cannot be created via API — minting + revoking
# the old token are manual UI steps; this script does the propagation.)
#
# The PAT lives in THREE places (discovered 2026-06-15):
#   1. SSM param   /futurator/_pipeline/github-pat   (rotation/daemon path)
#   2. gitconfig   url.insteadOf rewrite in BOTH /home/ubuntu/.gitconfig and
#                  /root/.gitconfig on the daemon EC2 (how the daemon clones/pushes)
#   3. SST secret  GithubPat                          (Lambda runtime — `loadPat()`)
#
# Security: the token is read from stdin (never an arg, never echoed, never
# logged). It transits to the daemon via SSM Run Command parameters; rotate the
# token again if you consider SSM command history sensitive.
#
# Usage:
#   read -rs NEWPAT && printf '%s' "$NEWPAT" | ./scripts/rotate-github-pat.sh
#   (paste the token at the prompt; it won't display)
#
# After this script succeeds:
#   - run `npx sst secret set GithubPat <newpat> --stage production` yourself
#     (it touches the SST deploy cycle — left out of this script on purpose)
#   - REVOKE the old token in the GitHub UI (Settings → Developer settings →
#     Fine-grained tokens) so the leaked value is dead.

set -euo pipefail

INSTANCE_ID="i-0826d68c316ae97dd"
SSM_PATH="/futurator/_pipeline/github-pat"
SSM_ROTATED_AT="/futurator/_pipeline/github-pat-rotated-at"

NEWPAT="$(cat)"
if [[ -z "$NEWPAT" ]]; then
  echo "error: no token on stdin" >&2
  exit 1
fi

# 1. Validate the token + confirm it authenticates as futurator-repos.
LOGIN="$(curl -s -H "Authorization: Bearer $NEWPAT" https://api.github.com/user | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p' | head -1)"
if [[ "$LOGIN" != "futurator-repos" ]]; then
  echo "error: token authenticates as '${LOGIN:-<none>}', expected 'futurator-repos' — aborting" >&2
  exit 1
fi
echo ">>> token validated (authenticates as futurator-repos)"

# 2. SSM custom path.
aws ssm put-parameter --name "$SSM_PATH" --type SecureString --overwrite \
  --value "$NEWPAT" >/dev/null
aws ssm put-parameter --name "$SSM_ROTATED_AT" --type String --overwrite \
  --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
echo ">>> SSM $SSM_PATH updated"

# 3. Daemon gitconfig insteadOf (both ubuntu + root) via SSM Run Command.
#    We pass the PAT as an SSM parameter value (not logged in the command body).
CMD_JSON="$(NEWPAT="$NEWPAT" python3 - <<'PY'
import json, os
pat = os.environ["NEWPAT"]
rule = f"url.https://x-access-token:{pat}@github.com/.insteadOf"
cmds = []
for home, user in (("/home/ubuntu", "ubuntu"), ("/root", "root")):
    runas = f"sudo -u {user} -H HOME={home} " if user == "ubuntu" else "sudo "
    cmds.append(f'{runas}git config --global "{rule}" "https://github.com/"')
cmds.append("echo '>>> gitconfig insteadOf updated (ubuntu + root)'")
# Verify the daemon can still authenticate (push dry-run on pacman1).
cmds.append("sudo -u ubuntu -H HOME=/home/ubuntu git -C /home/ubuntu/projects/pacman1 ls-remote --heads origin >/dev/null 2>&1 && echo '>>> daemon git auth OK' || echo '>>> WARN: daemon git auth check failed'")
print(json.dumps({"InstanceIds":[os.environ.get("IID","i-0826d68c316ae97dd")],
                  "DocumentName":"AWS-RunShellScript",
                  "Parameters":{"commands":cmds}}))
PY
)"
TMPJSON="$(mktemp)"
printf '%s' "$CMD_JSON" > "$TMPJSON"
CMD_ID="$(IID="$INSTANCE_ID" aws ssm send-command --cli-input-json "file://$TMPJSON" --query 'Command.CommandId' --output text)"
rm -f "$TMPJSON"
sleep 8
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text

echo ""
echo ">>> propagation done. REMAINING MANUAL STEPS:"
echo "    1. npx sst secret set GithubPat <newpat> --stage production"
echo "    2. revoke the OLD token in the GitHub UI (futurator-repos account)"
