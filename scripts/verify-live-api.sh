#!/usr/bin/env bash
# Quick check: live shop config + Render order API (cart checkout depends on this).
set -euo pipefail

API="${STC_API_URL:-https://sweettooth-cravings-api.onrender.com}"
SHOP="${STC_SHOP_URL:-https://sweettoothcravings.shop}"
EXPECTED_SHEET="13ch_g0giBozxwFqh1OVV-gTEqttmfC23xU9pNYFVxRs"
EXPECTED_DRIVE="1r-3-RrGjLbE4JHO32bMCDbId4O0jwKPE"

echo "Shop:  $SHOP"
curl -fsS -o /dev/null -w "  HTTP %{http_code}\n" "$SHOP/" || echo "  (shop unreachable)"

echo ""
echo "config.js PRODUCTION_API:"
curl -fsS "$SHOP/config.js" | grep -E 'PRODUCTION_API|STC_API' || true

echo ""
echo "Order API health: $API/api/health"
body="$(curl -sS -m 90 -w '\n__HTTP__%{http_code}' "$API/api/health" 2>&1 || true)"
http="${body##*__HTTP__}"
text="${body%__HTTP__*}"

if [[ "$http" == "200" ]] && echo "$text" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo "  OK — checkout can reach the order server."
  echo "$text" | head -c 800
  echo ""
  if echo "$text" | grep -q "$EXPECTED_SHEET"; then
    echo "  Sheet ID: OK ($EXPECTED_SHEET)"
  else
    echo "  WARN: expected sheet ID $EXPECTED_SHEET not found in health JSON"
  fi
  if echo "$text" | grep -q "$EXPECTED_DRIVE"; then
    echo "  Drive folder: OK ($EXPECTED_DRIVE)"
  else
    echo "  WARN: expected Drive folder $EXPECTED_DRIVE not found in health JSON"
  fi
  if echo "$text" | grep -q '"stripe"[[:space:]]*:[[:space:]]*true'; then
    echo "  Stripe: OK (deposit invoices enabled)"
  else
    echo "  WARN: Stripe not configured — set STRIPE_SECRET_KEY on Render for Send Deposit Invoice"
  fi
  exit 0
fi

echo "  FAIL (HTTP ${http:-?})"
echo "$text" | head -c 500
echo ""
echo ""
echo "Fix: redeploy node serve.js on Render (see DEPLOY.md or run ./scripts/setup-render.sh)."
exit 1