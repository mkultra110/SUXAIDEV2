#!/usr/bin/env bash
# test-quatarly.sh — probe the Quatarly upstream to figure out which
# auth header + endpoint combo works.
#
# Usage (on the VPS):
#   source /opt/suxai/.env && ./server/deploy/test-quatarly.sh

set -u

if [[ -z "${QUATARLY_API_KEY:-}" ]]; then
  echo "QUATARLY_API_KEY not set. Run: source /opt/suxai/.env" >&2
  exit 1
fi

BASE=${QUATARLY_BASE_URL:-https://api.quatarly.cloud}
BASE=${BASE%/}

ANTHROPIC_BODY='{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
OPENAI_BODY='{"model":"gpt-5.4","messages":[{"role":"user","content":"hi"}]}'

run() {
  local label=$1 url=$2 body=$3 auth_name=$4 auth_value=$5
  local extra=${6:-}
  echo "=========================================="
  echo "TEST: $label"
  echo "  URL:   $url"
  echo "  Auth:  $auth_name"
  local out
  out=$(mktemp)
  local code
  if [[ -n "$extra" ]]; then
    code=$(curl -sS -o "$out" -w "%{http_code}" \
      "$url" \
      -H "content-type: application/json" \
      -H "$auth_name: $auth_value" \
      -H "$extra" \
      -d "$body" || echo "curl-fail")
  else
    code=$(curl -sS -o "$out" -w "%{http_code}" \
      "$url" \
      -H "content-type: application/json" \
      -H "$auth_name: $auth_value" \
      -d "$body" || echo "curl-fail")
  fi
  echo "  HTTP:  $code"
  echo "  Body:  $(head -c 400 "$out")"
  echo
  rm -f "$out"
}

echo "Probing $BASE with key $(echo "$QUATARLY_API_KEY" | cut -c1-6)...$(echo "$QUATARLY_API_KEY" | tail -c 6)"
echo

# Anthropic endpoint — 4 auth variations
run "Anthropic + Bearer"     "$BASE/v1/messages" "$ANTHROPIC_BODY" "authorization" "Bearer $QUATARLY_API_KEY" "anthropic-version: 2023-06-01"
run "Anthropic + x-api-key"  "$BASE/v1/messages" "$ANTHROPIC_BODY" "x-api-key"     "$QUATARLY_API_KEY"         "anthropic-version: 2023-06-01"
run "Anthropic + apiKey"     "$BASE/v1/messages" "$ANTHROPIC_BODY" "apiKey"        "$QUATARLY_API_KEY"         "anthropic-version: 2023-06-01"
run "Anthropic (no /v1)"     "$BASE/messages"    "$ANTHROPIC_BODY" "x-api-key"     "$QUATARLY_API_KEY"         "anthropic-version: 2023-06-01"

# OpenAI endpoint — 3 auth variations
run "OpenAI + Bearer"        "$BASE/v1/chat/completions" "$OPENAI_BODY" "authorization" "Bearer $QUATARLY_API_KEY"
run "OpenAI + x-api-key"     "$BASE/v1/chat/completions" "$OPENAI_BODY" "x-api-key"     "$QUATARLY_API_KEY"
run "OpenAI + apiKey"        "$BASE/v1/chat/completions" "$OPENAI_BODY" "apiKey"        "$QUATARLY_API_KEY"

echo "=========================================="
echo "Look for a test that returned HTTP 200 (or at least NOT 404 with 'missing key')."
