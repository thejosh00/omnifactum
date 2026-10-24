#!/usr/bin/env bash
# Installer for omnifactum: installs its dependencies and puts `omni` on your PATH.
#
#   ./install.sh             # after every pull; then `omni service restart` to run the new code
#   ./install.sh --service   # also install the background service, if it isn't installed yet
#
# Safe to re-run. The service runs straight from this checkout, so updating is always the same
# two steps: ./install.sh, then omni service restart.
set -euo pipefail

with_service=0
for arg in "$@"; do
	case "$arg" in
	--service) with_service=1 ;;
	*) echo "usage: $0 [--service]" >&2; exit 2 ;;
	esac
done

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

if ! command -v bun >/dev/null 2>&1; then
	echo "omnifactum needs Bun: brew install bun (or see https://bun.sh)" >&2
	exit 1
fi

echo "==> bun install"
bun install

echo "==> bun link (puts omni on your PATH)"
bun link

bin_dir="${BUN_INSTALL:-$HOME/.bun}/bin"
omni="$bin_dir/omni"
case ":$PATH:" in
*":$bin_dir:"*) ;;
*) echo "note: $bin_dir is not on your PATH — add it to your shell profile to run omni directly." >&2 ;;
esac

status="$("$omni" service status 2>/dev/null | head -n 1 || true)"
case "$status" in
"not installed")
	if [ "$with_service" = 1 ]; then
		echo "==> omni service install"
		"$omni" service install
	fi
	;;
installed* | running*)
	echo "note: the service still runs the old code — \`omni service restart\` to run this one"
	;;
esac

echo "==> done"
