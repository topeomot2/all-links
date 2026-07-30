#!/usr/bin/env bash
# Checks the two acceptance criteria that only a deployed stack can answer:
#
#   1. the deployed URL returns renderer HTML, and a second request is a HIT
#   2. the *.lambda-url.*.on.aws hostname returns 403 when hit directly
#
# Usage: ./tools/verify-deployment.sh [stack-name]   (default: AllLinks-dev)
set -euo pipefail

STACK="${1:-AllLinks-dev}"

output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

SITE_URL="$(output SiteUrl)"
FUNCTION_URL="$(output RendererFunctionUrl)"

if [[ -z "$SITE_URL" || "$SITE_URL" == "None" ]]; then
  echo "could not read SiteUrl from $STACK — is it deployed?" >&2
  exit 1
fi

echo "site:     $SITE_URL"
echo "function: $FUNCTION_URL"
echo

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. HTML from the renderer, through CloudFront, on an arbitrary path.
path="/verify-$(date +%s)"
headers="$(curl -sS -D - -o /tmp/all-links-body "$SITE_URL$path")"

grep -qi '^HTTP/[0-9.]* 200' <<<"$headers" || fail "expected 200 from $SITE_URL$path"
grep -qi '^content-type: text/html' <<<"$headers" || fail 'expected an HTML content-type'
grep -qi '^cache-control: public, s-maxage=60, max-age=0' <<<"$headers" \
  || fail 'expected Cache-Control: public, s-maxage=60, max-age=0'
grep -q '<!DOCTYPE html>' /tmp/all-links-body || fail 'expected a renderer document'
echo "ok  renderer HTML through CloudFront"

# 2. The same path again is served from the edge.
second="$(curl -sS -D - -o /dev/null "$SITE_URL$path")"
grep -qi '^x-cache: Hit from cloudfront' <<<"$second" \
  || fail "second request was not a HIT: $(grep -i '^x-cache' <<<"$second")"
echo "ok  second request is a CloudFront HIT"

# 3. The Function URL is not addressable without a SigV4 signature.
direct="$(curl -sS -o /dev/null -w '%{http_code}' "$FUNCTION_URL")"
[[ "$direct" == "403" ]] || fail "expected 403 direct from the Function URL, got $direct"
echo "ok  Function URL returns 403 when hit directly"

echo
echo "$STACK verified"
