#!/usr/bin/env bash
# Verify that one native macOS release package is Developer ID-signed,
# notarized, and stapled before it can be published.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="${1:-apps/desktop/release}"

# Read the packaged app name from the build config instead of hardcoding it.
# This script used to pin "PI-Desktop", which silently stopped matching once the
# app was rebranded — the gate then failed with "expected exactly one
# PI-Desktop.app" on a perfectly good package.
PRODUCT_NAME="$(node -p "require('${REPO_ROOT}/apps/desktop/package.json').build.productName" 2>/dev/null || true)"
if [[ -z "$PRODUCT_NAME" ]]; then
  echo "error: could not read build.productName from apps/desktop/package.json." >&2
  exit 1
fi

# Optional. When set, the signature must match it. When unset, the checks below
# run against whatever Developer ID authority actually signed the bundle, so a
# fork does not have to configure a name to get a meaningful gate. Upstream
# hardcoded its own identity here.
IDENTITY_NAME="${MAC_SIGNING_IDENTITY:-}"
IDENTITY_NAME="${IDENTITY_NAME#Developer ID Application: }"

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "error: release directory does not exist: $RELEASE_DIR" >&2
  exit 1
fi

shopt -s nullglob
APPS=("$RELEASE_DIR"/mac*/"$PRODUCT_NAME".app)
DMGS=("$RELEASE_DIR"/*.dmg)

if [[ "${#APPS[@]}" -ne 1 ]]; then
  echo "error: expected exactly one $PRODUCT_NAME.app under $RELEASE_DIR/mac*/." >&2
  exit 1
fi

if [[ "${#DMGS[@]}" -ne 1 ]]; then
  echo "error: expected exactly one DMG under $RELEASE_DIR/." >&2
  exit 1
fi

APP="${APPS[0]}"
DMG="${DMGS[0]}"
HOST_CORE="$APP/Contents/Resources/bin/pi-desktop-host-core"

echo "==> Inspecting Developer ID signature: $APP"
SIGNATURE_INFO="$(codesign -dv --verbose=4 "$APP" 2>&1)"
printf '%s\n' "$SIGNATURE_INFO"

ACTUAL_IDENTITY="$(printf '%s\n' "$SIGNATURE_INFO" | sed -n 's/^Authority=//p' | head -n 1)"
if [[ "$ACTUAL_IDENTITY" != "Developer ID Application: "* ]]; then
  echo "error: $APP is not signed with a Developer ID Application certificate (got: ${ACTUAL_IDENTITY:-no Authority line})." >&2
  exit 1
fi

if [[ -n "$IDENTITY_NAME" ]]; then
  EXPECTED_IDENTITY="Developer ID Application: ${IDENTITY_NAME}"
  if [[ "$SIGNATURE_INFO" != *"Authority=${EXPECTED_IDENTITY}"* ]]; then
    echo "error: $APP is not signed with $EXPECTED_IDENTITY (got: $ACTUAL_IDENTITY)." >&2
    exit 1
  fi
  echo "==> Signature matches MAC_SIGNING_IDENTITY: $EXPECTED_IDENTITY"
else
  echo "==> MAC_SIGNING_IDENTITY not set; accepting the bundle's own Developer ID authority: $ACTUAL_IDENTITY"
fi
if [[ "$SIGNATURE_INFO" != *"flags=0x10000(runtime)"* && "$SIGNATURE_INFO" != *"flags=runtime"* && "$SIGNATURE_INFO" != *"runtime"* ]]; then
  echo "warning: hardened runtime flag not found in codesign -dv output; continuing with --deep --strict."
fi

echo "==> Verifying code-signing integrity: $APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [[ -f "$HOST_CORE" ]]; then
  echo "==> Verifying host-core sidecar signature: $HOST_CORE"
  codesign --verify --strict --verbose=2 "$HOST_CORE"
else
  echo "error: missing host-core sidecar at $HOST_CORE" >&2
  exit 1
fi

echo "==> Assessing Gatekeeper notarization: $APP"
ASSESSMENT="$(spctl --assess --type execute --verbose=4 "$APP" 2>&1)"
printf '%s\n' "$ASSESSMENT"
if [[ "$ASSESSMENT" != *"source=Notarized Developer ID"* ]]; then
  echo "error: Gatekeeper did not recognize $APP as notarized." >&2
  exit 1
fi

echo "==> Validating stapled notarization tickets"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

echo "==> macOS release verification passed: $APP and $DMG"
