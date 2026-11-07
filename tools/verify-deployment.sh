#!/usr/bin/env bash
# Checks the two acceptance criteria that only a deployed stack can answer:
#
#   1. the deployed URL returns renderer HTML, and repeat requests come from the edge
#   2. the *.lambda-url.*.on.aws hostnames return 403 when hit directly
#   3. a reserved name answers honestly rather than offering to sell itself
#   4. /api/* reaches the api through OAC, and refuses a request with no token
#   5. the dashboard shell and its config are served uncached from S3
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
API_FUNCTION_URL="$(output ApiFunctionUrl)"

if [[ -z "$SITE_URL" || "$SITE_URL" == "None" ]]; then
  echo "could not read SiteUrl from $STACK — is it deployed?" >&2
  exit 1
fi

echo "site:     $SITE_URL"
echo "function: $FUNCTION_URL"
echo

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. HTML from the renderer, through CloudFront, on an arbitrary path.
#    Since T2 an unclaimed username is a 404 carrying the "claim it" body —
#    still a renderer document, still cached for 60 s at the edge.
path="/verify-$(date +%s)"
headers="$(curl -sS -D - -o /tmp/all-links-body "$SITE_URL$path")"

grep -qi '^HTTP/[0-9.]* 404' <<<"$headers" || fail "expected 404 from $SITE_URL$path"
grep -qi '^content-type: text/html' <<<"$headers" || fail 'expected an HTML content-type'
grep -qi '^cache-control: public, s-maxage=60, max-age=0' <<<"$headers" \
  || fail 'expected Cache-Control: public, s-maxage=60, max-age=0'
grep -q '<!DOCTYPE html>' /tmp/all-links-body || fail 'expected a renderer document'
grep -qi 'is available' /tmp/all-links-body || fail 'expected the unclaimed-username body'
echo "ok  unclaimed username renders the claim-it 404 through CloudFront"

# 2. Both kinds of response are served from the edge.
#    A cached 404 still reports `x-cache: Error from cloudfront`, so only a 200
#    can show a HIT. The 404's proof is `age`, which only a cached copy carries;
#    the wait lets it reach at least 1, since it can be absent or 0 before that.
curl -sS -o /dev/null "$SITE_URL/"
second="$(curl -sS -D - -o /dev/null "$SITE_URL/")"
grep -qi '^HTTP/[0-9.]* 200' <<<"$second" || fail "expected 200 from $SITE_URL/"
grep -qi '^x-cache: Hit from cloudfront' <<<"$second" \
  || fail "second request to / was not a HIT: $(grep -i '^x-cache' <<<"$second")"
echo "ok  second request to / is a CloudFront HIT"

sleep 2
repeat="$(curl -sS -D - -o /dev/null "$SITE_URL$path")"
grep -qiE '^age: [1-9]' <<<"$repeat" || fail "the 404 at $path was not served from the edge cache"
echo "ok  repeated 404 is served from the edge cache"

# 3. The Function URL is not addressable without a SigV4 signature.
direct="$(curl -sS -o /dev/null -w '%{http_code}' "$FUNCTION_URL")"
[[ "$direct" == "403" ]] || fail "expected 403 direct from the Function URL, got $direct"
echo "ok  Function URL returns 403 when hit directly"

# 4. A reserved name is answered above the table, and is not for sale.
reserved="$(curl -sS -D - -o /tmp/all-links-reserved "$SITE_URL/support")"
grep -qi '^HTTP/[0-9.]* 404' <<<"$reserved" || fail 'expected 404 for a reserved name'
grep -qi 'reserved' /tmp/all-links-reserved || fail 'expected the reserved-name body for /support'
if grep -q 'href="/app/"' /tmp/all-links-reserved; then
  fail '/support offered a signup CTA — a reserved name is not for sale'
fi
echo "ok  reserved name answers honestly, with no CTA"

# 5. The api answers through CloudFront — a JSON 401, not a CloudFront 403,
#    proves OAC signed the request and the Lambda ran — and is never cached.
api="$(curl -sS -D - -o /tmp/all-links-api "$SITE_URL/api/me")"
grep -qi '^HTTP/[0-9.]* 401' <<<"$api" || fail "expected 401 from /api/me without a token"
grep -qi '^cache-control: no-store' <<<"$api" || fail 'expected /api/me to be no-store'
grep -q '"unauthenticated"' /tmp/all-links-api || fail 'expected the api JSON error body'
echo "ok  /api/me reaches the api through OAC and refuses an anonymous request"

direct_api="$(curl -sS -o /dev/null -w '%{http_code}' "$API_FUNCTION_URL")"
[[ "$direct_api" == "403" ]] || fail "expected 403 direct from the api Function URL, got $direct_api"
echo "ok  api Function URL returns 403 when hit directly"

# 6. The dashboard: shell, a deep link that must fall back to the shell, and
#    the runtime config — all no-store, so a deploy needs no invalidation.
for path in /app/ /app/some/deep/link /app/config.json; do
  shell="$(curl -sS -D - -o /tmp/all-links-shell "$SITE_URL$path")"
  grep -qi '^HTTP/[0-9.]* 200' <<<"$shell" || fail "expected 200 from $path"
  grep -qi '^cache-control: no-store' <<<"$shell" || fail "expected $path to be no-store"
done
grep -q 'userPoolClientId' /tmp/all-links-shell || fail 'expected config.json to name the app client'
echo "ok  dashboard shell, deep links and config are served uncached"

echo
echo "$STACK verified"
