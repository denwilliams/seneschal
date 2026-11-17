#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/self-maintain.sh [--pr <number-or-url>] [options]

Merge an approved seneschal PR, update the local checkout, install npm
packages, build, and restart the PM2 process that runs the harness.

Options:
  --pr <number-or-url>         Merge this PR before deploying.
  --merge-method <method>      squash | merge | rebase (default: squash).
  --repo <path>                Local repo path (default: this script's repo).
  --branch <branch>            Branch to deploy (default: main).
  --pm2 <name-or-id>           PM2 process to restart (default: autodetect, then harness).
  --restart-delay-seconds <n>  Delay before async restart (default: 5).
  --sync-restart               Wait for pm2 restart instead of scheduling it.
  --skip-install               Do not run npm install.
  --skip-build                 Do not run npm run build.
  --skip-restart               Do not restart PM2.
  --dry-run                    Print the operations without changing anything.
  -h, --help                   Show this help.

Environment:
  HARNESS_REPO                 Default repo path.
  HARNESS_BRANCH               Default branch.
  HARNESS_PM2_NAME             Default PM2 process name/id.
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${HARNESS_REPO:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
BRANCH="${HARNESS_BRANCH:-main}"
PR=""
MERGE_METHOD="squash"
PM2_TARGET="${HARNESS_PM2_NAME:-}"
RESTART_DELAY_SECONDS=5
SYNC_RESTART=0
SKIP_INSTALL=0
SKIP_BUILD=0
SKIP_RESTART=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      [[ $# -ge 2 ]] || { echo "--pr needs a value" >&2; exit 2; }
      PR="$2"; shift 2 ;;
    --merge-method)
      [[ $# -ge 2 ]] || { echo "--merge-method needs a value" >&2; exit 2; }
      MERGE_METHOD="$2"; shift 2 ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "--repo needs a value" >&2; exit 2; }
      REPO_DIR="$2"; shift 2 ;;
    --branch)
      [[ $# -ge 2 ]] || { echo "--branch needs a value" >&2; exit 2; }
      BRANCH="$2"; shift 2 ;;
    --pm2)
      [[ $# -ge 2 ]] || { echo "--pm2 needs a value" >&2; exit 2; }
      PM2_TARGET="$2"; shift 2 ;;
    --restart-delay-seconds)
      [[ $# -ge 2 ]] || { echo "--restart-delay-seconds needs a value" >&2; exit 2; }
      RESTART_DELAY_SECONDS="$2"; shift 2 ;;
    --sync-restart)
      SYNC_RESTART=1; shift ;;
    --skip-install)
      SKIP_INSTALL=1; shift ;;
    --skip-build)
      SKIP_BUILD=1; shift ;;
    --skip-restart)
      SKIP_RESTART=1; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

case "$MERGE_METHOD" in
  squash|merge|rebase) ;;
  *) echo "--merge-method must be squash, merge, or rebase" >&2; exit 2 ;;
esac

case "$RESTART_DELAY_SECONDS" in
  ''|*[!0-9]*) echo "--restart-delay-seconds must be a non-negative integer" >&2; exit 2 ;;
esac

run_in_repo() {
  printf '+ (cd %q &&' "$REPO_DIR"
  for arg in "$@"; do printf ' %q' "$arg"; done
  printf ')\n'
  if [[ "$DRY_RUN" -eq 0 ]]; then
    (cd "$REPO_DIR" && "$@")
  fi
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required executable: $1" >&2
    exit 1
  }
}

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "Not a git repository: $REPO_DIR" >&2
  exit 1
fi

require_bin git
require_bin node
require_bin npm
if [[ -n "$PR" ]]; then require_bin gh; fi
if [[ "$SKIP_RESTART" -eq 0 ]]; then require_bin pm2; fi

PACKAGE_NAME="$(node -e "const p=require(process.argv[1]); console.log(p.name || '')" "$REPO_DIR/package.json" 2>/dev/null || true)"
if [[ "$PACKAGE_NAME" != "seneschal" ]]; then
  echo "Refusing to maintain unexpected package '$PACKAGE_NAME' in $REPO_DIR" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! (cd "$REPO_DIR" && git diff --quiet && git diff --cached --quiet); then
    echo "Refusing to deploy with uncommitted tracked changes in $REPO_DIR" >&2
    exit 1
  fi
fi

if [[ -n "$PR" ]]; then
  merge_flag="--$MERGE_METHOD"
  run_in_repo gh pr merge "$PR" "$merge_flag" --delete-branch
fi

run_in_repo git fetch origin "$BRANCH"
run_in_repo git checkout "$BRANCH"
run_in_repo git pull --ff-only origin "$BRANCH"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  run_in_repo npm install
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  run_in_repo npm run build
fi

if [[ "$SKIP_RESTART" -eq 1 ]]; then
  echo "Skipped PM2 restart."
  exit 0
fi

if [[ -z "$PM2_TARGET" ]]; then
  PM2_TARGET="$(REPO_DIR="$REPO_DIR" node <<'NODE' 2>/dev/null || true
const { spawnSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { isAbsolute, resolve, relative } = require('node:path');
const repo = realpathSync(process.env.REPO_DIR);
const out = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
if (out.status !== 0) process.exit(0);
for (const proc of JSON.parse(out.stdout || '[]')) {
  const env = proc.pm2_env || {};
  const candidates = [env.pm_cwd, env.pm_exec_path].filter(Boolean);
  for (const candidate of candidates) {
    let real;
    try { real = realpathSync(resolve(candidate)); } catch { continue; }
    const rel = relative(repo, real);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      console.log(proc.name || String(proc.pm_id));
      process.exit(0);
    }
  }
}
NODE
)"
fi
PM2_TARGET="${PM2_TARGET:-harness}"

if [[ "$SYNC_RESTART" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
  run_in_repo pm2 restart "$PM2_TARGET" --update-env
else
  LOG_FILE="${TMPDIR:-/tmp}/seneschal-self-maintain-$(date +%Y%m%d%H%M%S).log"
  quoted_repo=$(printf '%q' "$REPO_DIR")
  quoted_pm2=$(printf '%q' "$(command -v pm2)")
  quoted_target=$(printf '%q' "$PM2_TARGET")
  restart_cmd="sleep $RESTART_DELAY_SECONDS; cd $quoted_repo; exec $quoted_pm2 restart $quoted_target --update-env"
  echo "+ scheduling PM2 restart of '$PM2_TARGET' in ${RESTART_DELAY_SECONDS}s (log: $LOG_FILE)"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    nohup bash -lc "$restart_cmd" >"$LOG_FILE" 2>&1 &
  fi
fi

cat <<DONE
Self-maintenance complete:
- repo: $REPO_DIR
- branch: $BRANCH
- installed: $([[ "$SKIP_INSTALL" -eq 0 ]] && echo yes || echo no)
- built: $([[ "$SKIP_BUILD" -eq 0 ]] && echo yes || echo no)
- pm2 target: $PM2_TARGET
DONE
