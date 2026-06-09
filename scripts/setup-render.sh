#!/usr/bin/env bash
# One-time setup: deploy the order API on Render (required for live cart submissions).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Sweet Tooth Cravings — Render order server setup"
echo "══════════════════════════════════════════════════════════"
echo ""
echo "GitHub Pages only serves static files. Cart orders need"
echo "node serve.js running 24/7 on Render."
echo ""

if command -v render >/dev/null 2>&1; then
  echo "✓ Render CLI installed"
  if render workspaces -o json --confirm 2>/dev/null | grep -q '"name"'; then
    echo "✓ Render CLI authenticated"
    echo ""
    echo "Create service from blueprint:"
    echo "  render blueprints validate render.yaml"
    echo "  Then use Dashboard → New → Blueprint → SweetToothGravings"
  else
    echo "→ Run:  render login"
    echo "  (opens browser to authorize, then retry this script)"
  fi
else
  echo "→ Install Render CLI:  brew install render"
  echo "→ Then run:            render login"
fi

echo ""
echo "── One-click deploy (browser) ──"
echo "https://render.com/deploy?repo=https://github.com/SebastianGrokBuild/SweetToothGravings"
echo ""

echo "── After the service is created, add Environment variables ──"
if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    if [[ "$key" == *PASS* || "$key" == *SECRET* || "$key" == *KEY* ]]; then
      echo "  $key=(set from your .env — do not paste in chat)"
    else
      echo "  $key=$val"
    fi
  done < .env
  echo "  APP_URL=https://sweettooth-cravings.onrender.com"
else
  echo "  (copy values from .env.example and your local .env)"
fi

echo ""
echo "── Secret Files (Render → Environment → Secret Files) ──"
for f in \
  credentials/google-service-account.json \
  credentials/oauth-client.json \
  credentials/google-drive-token.json
do
  if [[ -f "$f" ]]; then
    echo "  ✓ $f"
  else
    echo "  ✗ $f  (missing — upload when ready)"
  fi
done

echo ""
echo "── Verify ──"
echo "  curl https://sweettooth-cravings.onrender.com/api/health"
echo "  Expect: \"ok\": true"
echo ""
echo "── Live shop ──"
echo "  config.js already points to https://sweettooth-cravings.onrender.com"
echo "  Push to GitHub if you change it."
echo ""