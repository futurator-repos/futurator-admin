#!/usr/bin/env bash
# One-shot: attach the ISSUED ACM certs to the Dev/Staging routers and claim
# the dev/staging.futurator.ai aliases from the dead account.
#
# Context (2026-07-19): dev.futurator.ai + staging.futurator.ai are still
# alias-claimed by CloudFront distributions in the DEAD AWS account, so a plain
# `sst deploy` 409s (CNAMEAlreadyExists). The supported escape hatch is:
#   1. attach a valid cert for the domain to the TARGET distribution (no alias),
#   2. prove DNS ownership via the _<host> TXT records (already created), and
#   3. call cloudfront associate-alias, which moves the alias cross-account.
# Afterwards run: npx sst refresh --stage production && npx sst deploy --stage production
# so IaC state records what is now reality.
set -euo pipefail

DEV_DIST=E1NZW5UFA64UL4
STG_DIST=E2CFQJ092U2AE6
DEV_CERT=arn:aws:acm:us-east-1:421515025850:certificate/e2762490-9841-42d6-8364-ca12e5c03836
STG_CERT=arn:aws:acm:us-east-1:421515025850:certificate/69842479-66a2-4ae5-b93a-62c53c849658

attach_cert() {
  local dist=$1 cert=$2
  local tmp etag
  tmp=$(mktemp)
  aws cloudfront get-distribution-config --id "$dist" > "$tmp"
  etag=$(python3 -c "import json;print(json.load(open('$tmp'))['ETag'])")
  python3 - "$tmp" "$cert" <<'PY'
import json, sys
path, arn = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))['DistributionConfig']
cfg['ViewerCertificate'] = {
    'ACMCertificateArn': arn,
    'SSLSupportMethod': 'sni-only',
    'MinimumProtocolVersion': 'TLSv1.2_2021',
    'Certificate': arn,
    'CertificateSource': 'acm',
}
json.dump(cfg, open(path + '.new', 'w'))
PY
  aws cloudfront update-distribution --id "$dist" --if-match "$etag" \
    --distribution-config "file://$tmp.new" \
    --query 'Distribution.Status' --output text
}

echo "1/4 attaching cert to DevRouter ($DEV_DIST)…"
attach_cert "$DEV_DIST" "$DEV_CERT"
echo "2/4 attaching cert to StagingRouter ($STG_DIST)…"
attach_cert "$STG_DIST" "$STG_CERT"

echo "3/4 waiting for both distributions to reach Deployed…"
aws cloudfront wait distribution-deployed --id "$DEV_DIST"
aws cloudfront wait distribution-deployed --id "$STG_DIST"

echo "4/4 associating aliases (cross-account move via TXT ownership proof)…"
aws cloudfront associate-alias --target-distribution-id "$DEV_DIST" --alias dev.futurator.ai
aws cloudfront associate-alias --target-distribution-id "$STG_DIST" --alias staging.futurator.ai

echo "DONE. Verify: curl -sI https://dev.futurator.ai/ | head -1"
