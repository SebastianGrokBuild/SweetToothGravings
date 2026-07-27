#!/usr/bin/env bash
# Set STRIPE_SECRET_KEY on sweettooth-cravings-api and verify account acct_1TcrMNHTYIZb4z2l.
#
# Usage:
#   ./scripts/set-stripe-key-on-render.sh sk_live_...
#   STRIPE_SECRET_KEY=sk_live_... ./scripts/set-stripe-key-on-render.sh
set -euo pipefail

SERVICE_ID="srv-d9jpi9navr4c73d19o70"
EXPECTED_ACCOUNT="acct_1TcrMNHTYIZb4z2l"
API_BASE="https://api.render.com/v1"
KEY="${1:-${STRIPE_SECRET_KEY:-}}"

if [[ -z "$KEY" || ! "$KEY" =~ ^sk_live_ ]]; then
  echo "Usage: $0 sk_live_YOUR_KEY"
  echo "Production requires a LIVE secret key (sk_live_…), not sk_test_."
  echo "Get it from Stripe (account $EXPECTED_ACCOUNT) → Developers → API keys → Secret key (Live mode)"
  exit 1
fi

if [[ ! -f "$HOME/.render/cli.yaml" ]]; then
  echo "Missing ~/.render/cli.yaml — run: render login"
  exit 1
fi

echo "Verifying Stripe key → $EXPECTED_ACCOUNT …"
ACCT_ID="$(curl -sS -u "${KEY}:" https://api.stripe.com/v1/account | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"
if [[ "$ACCT_ID" != "$EXPECTED_ACCOUNT" ]]; then
  echo "ERROR: key is for '${ACCT_ID:-unknown}', expected $EXPECTED_ACCOUNT"
  exit 1
fi
echo "  OK"

export SERVICE_ID EXPECTED_ACCOUNT API_BASE KEY
export RENDER_KEY
RENDER_KEY="$(python3 -c "
import re
t=open(__import__('os').path.expanduser('~/.render/cli.yaml')).read()
m=re.search(r'key:\s*(\S+)', t)
print(m.group(1) if m else '')
")"

python3 <<'PY'
import json, os, urllib.request

SERVICE = os.environ["SERVICE_ID"]
API_BASE = os.environ["API_BASE"]
RENDER_KEY = os.environ["RENDER_KEY"]
STRIPE_KEY = os.environ["KEY"]
EXPECTED = os.environ["EXPECTED_ACCOUNT"]

req = urllib.request.Request(
    f"{API_BASE}/services/{SERVICE}/env-vars?limit=100",
    headers={"Authorization": f"Bearer {RENDER_KEY}", "Accept": "application/json"},
)
with urllib.request.urlopen(req) as res:
    existing = json.load(res)

vars_map = {}
for item in existing:
    ev = item.get("envVar") or item
    k, v = ev.get("key"), ev.get("value")
    if k is not None:
        vars_map[k] = v

vars_map["STRIPE_SECRET_KEY"] = STRIPE_KEY
vars_map["STRIPE_ACCOUNT_ID"] = EXPECTED
vars_map["PUBLIC_SHOP_URL"] = vars_map.get("PUBLIC_SHOP_URL") or "https://sweettoothcravings.shop"

payload = [{"key": k, "value": v} for k, v in vars_map.items()]
body = json.dumps(payload).encode()
req = urllib.request.Request(
    f"{API_BASE}/services/{SERVICE}/env-vars",
    data=body,
    method="PUT",
    headers={
        "Authorization": f"Bearer {RENDER_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    },
)
with urllib.request.urlopen(req) as res:
    print("Render env PUT HTTP", res.status)

req = urllib.request.Request(
    f"{API_BASE}/services/{SERVICE}/deploys",
    data=b"{}",
    method="POST",
    headers={
        "Authorization": f"Bearer {RENDER_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    },
)
with urllib.request.urlopen(req) as res:
    d = json.load(res)
    dep = d.get("deploy") or d
    print("Deploy started:", dep.get("id") or dep)
PY

echo ""
echo "After deploy (~1–2 min):"
echo "  curl -s https://sweettooth-cravings-api.onrender.com/api/health | python3 -m json.tool | head -50"
echo "Expect stripe:true, stripeLive:true, livemode:true, accountId $EXPECTED_ACCOUNT"
echo ""
echo "Sheet: Stripe Deposit → Send Deposit Invoice emails a LIVE 50% invoice to the row Email."
