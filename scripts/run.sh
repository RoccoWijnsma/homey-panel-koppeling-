#!/usr/bin/env bash
#
# Get the latest build of this app onto your Homey, in one command.
#
# Two things went wrong often enough by hand to be worth automating: running
# the CLI from the wrong directory (it looks for the app in your current
# folder, not in this repo), and Docker being asleep - which the CLI reports
# in a way that does not obviously mean "start Docker Desktop".
#
# `run` is the live mode: the app runs from your Mac, logs stream to this
# terminal, and it STOPS when you close the terminal. `--install` puts the app
# on the Homey for good, so it survives a closed lid and a reboot.
#
# Usage:
#   ./scripts/run.sh             # live, with logs (Ctrl-C to stop)
#   ./scripts/run.sh --install   # install permanently on the Homey
#   ./scripts/run.sh --no-pull   # skip the git pull, run what is on disk

set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1" >&2; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

MODE="run"
PULL="yes"
for arg in "$@"; do
  case "$arg" in
    --install) MODE="install" ;;
    --no-pull) PULL="no" ;;
    -h|--help) awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/, ""); print}' "$0"; exit 0 ;;
    *) fail "Unknown option '$arg'. Try --help." ;;
  esac
done

# The CLI resolves the app from the working directory, so put us in the repo
# no matter where this was called from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f app.json ] || fail "No app.json here - is this the right checkout?"

command -v homey >/dev/null 2>&1 \
  || fail "The Homey CLI is missing. Install it with: npm install -g homey"

if [ "$PULL" = "yes" ]; then
  bold "Fetching the latest build..."
  if ! git pull --ff-only; then
    warn "Could not fast-forward. You have local commits or uncommitted work."
    warn "Sort that out, or re-run with --no-pull to use what is on disk."
    exit 1
  fi
fi
printf 'On %s at %s\n\n' "$(git rev-parse --abbrev-ref HEAD)" "$(git log --oneline -1)"

if [ "$MODE" = "run" ]; then
  # Live mode builds a container on your Mac first; without Docker the CLI
  # fails several steps later with a message that does not name the cause.
  if ! docker info >/dev/null 2>&1; then
    fail "Docker is not running. Open Docker Desktop, wait for the whale in the menu bar, then try again."
  fi
  bold "Starting the app (Ctrl-C stops it, and the app stops with it)..."
  exec homey app run
fi

bold "Installing the app on your Homey (it stays there after you close this)..."
exec homey app install
