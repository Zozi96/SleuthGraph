#!/usr/bin/env bash
# Reproducible with/without SleuthGraph A/B benchmark over a multi-language
# corpus. Wraps scripts/agent-eval/run-all.sh (one with/without pair per rep)
# and renames its outputs so compare-arms.mjs / report.mjs see each rep as an
# independent run: run-headless-{with,without}-<i>.jsonl.
#
# Usage: run-benchmark.sh [--runs N] [--repos a,b] [--out DIR] [--corpus DIR] [--yes]
#
#   --runs N     reps per arm per repo (default: 5)
#   --repos a,b  only these corpus entries by name (default: all)
#   --out DIR    results dir (default: benchmarks/results/<timestamp>)
#   --corpus DIR corpus checkout dir (default: /tmp/sleuth-corpus)
#   --yes        actually run — without it this prints the plan and exits,
#                because each rep spends real money on `claude -p`
#
# Resumable: a rep whose two run-*.jsonl already exist and are non-empty is
# skipped, so re-launching continues where an interrupted campaign stopped.
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$BENCH_DIR/.." && pwd)"
RUN_ALL="$REPO_ROOT/scripts/agent-eval/run-all.sh"
CORPUS_JSON="$BENCH_DIR/corpus.json"

RUNS=5
REPOS_FILTER=""
OUT=""
CORPUS="/tmp/sleuth-corpus"
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --runs)   RUNS="${2:?--runs needs a value}"; shift 2;;
    --repos)  REPOS_FILTER="${2:?--repos needs a value}"; shift 2;;
    --out)    OUT="${2:?--out needs a value}"; shift 2;;
    --corpus) CORPUS="${2:?--corpus needs a value}"; shift 2;;
    --yes)    YES=1; shift;;
    -h|--help) sed -n '2,17p' "$0"; exit 0;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

[ -z "$OUT" ] && OUT="$BENCH_DIR/results/$(date +%Y%m%d-%H%M%S)"

# Corpus entries as tab-separated lines: name \t repo \t language \t size \t question
corpus_rows() {
  node -e '
    const corpus = require(process.argv[1]);
    const filter = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
    for (const c of corpus) {
      if (filter && !filter.has(c.name)) continue;
      console.log([c.name, c.repo, c.language, c.size, c.question].join("\t"));
    }' "$CORPUS_JSON" "$REPOS_FILTER"
}

ROWS="$(corpus_rows)"
[ -n "$ROWS" ] || { echo "no corpus entries matched (corpus: $CORPUS_JSON, filter: '$REPOS_FILTER')" >&2; exit 1; }
N_REPOS="$(printf '%s\n' "$ROWS" | wc -l | tr -d ' ')"
SESSIONS=$((N_REPOS * 2 * RUNS))

echo "==================== SleuthGraph A/B benchmark ===================="
echo "corpus:     $N_REPOS repos ($(printf '%s\n' "$ROWS" | cut -f1 | paste -sd, -))"
echo "runs:       $RUNS reps/arm -> $SESSIONS headless sessions"
echo "out:        $OUT"
echo "corpus dir: $CORPUS"
echo "model:      sonnet --effort high (standing policy, both arms)"
echo
echo "COST: each session runs 'claude -p' (max-budget-usd 4). Assuming"
echo "~\$0.5-2 per session on a small/medium repo, a full campaign is roughly"
echo "\$$(awk -v s="$SESSIONS" 'BEGIN{printf "%d-%d", s/2, s*2}')."
echo

if [ "$YES" -ne 1 ]; then
  printf '%s\n' "$ROWS" | while IFS=$'\t' read -r name url lang size q; do
    echo "  $name ($lang, $size): $q"
  done
  echo
  echo "Dry run — re-run with --yes to execute."
  exit 0
fi

for tool in git node claude sleuth; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing on PATH: $tool" >&2; exit 1; }
done
[ -f "$RUN_ALL" ] || { echo "missing harness: $RUN_ALL" >&2; exit 1; }

mkdir -p "$OUT" "$CORPUS"

# Emit run-* files from a rep dir into the repo dir as run-<stem>-<i>.jsonl,
# preserving .tN segment suffixes so compare-arms.mjs still stitches turns.
collect_rep() {
  local repdir="$1" repodir="$2" i="$3" f base stem
  shopt -s nullglob
  for f in "$repdir"/run-headless-*.jsonl; do
    base="$(basename "$f" .jsonl)"             # run-headless-with[.tN]
    stem="${base/run-headless-/}"              # with[.tN] / without[.tN]
    if [ -s "$f" ]; then
      mv "$f" "$repodir/run-headless-${stem%%.t*}-$i${stem#"${stem%%.t*}"}.jsonl"
    fi
  done
  shopt -u nullglob
  for f in "$repdir"/run-headless-*.err; do
    mv "$f" "$repodir/$(basename "$f" .err)-$i.err" 2>/dev/null || true
  done
}

printf '%s\n' "$ROWS" | while IFS=$'\t' read -r name url lang size q; do
  repo="$CORPUS/$name"
  repodir="$OUT/$name"
  mkdir -p "$repodir"
  echo "==================== repo: $name ($lang, $size) ===================="

  # Clone once; reuse the checkout on re-launch.
  if [ -d "$repo/.git" ]; then
    echo "==> reusing checkout $repo"
  else
    echo "==> cloning $url"
    git clone --depth 1 "$url" "$repo" || { echo "!! clone failed — skipping $name"; continue; }
  fi

  # Wipe + re-index with the binary under test: the index must be built by the
  # same sleuth that serves it (audit.sh does the same). --yes keeps clack
  # prompts non-interactive; -i is deprecated (indexing runs by default).
  echo "==> re-indexing with $(sleuth --version 2>/dev/null || echo '?')"
  rm -rf "$repo/.sleuth"
  ( cd "$repo" && sleuth init --yes ) || { echo "!! indexing failed — skipping $name"; continue; }

  for i in $(seq 1 "$RUNS"); do
    w="$repodir/run-headless-with-$i.jsonl"
    wo="$repodir/run-headless-without-$i.jsonl"
    if [ -s "$w" ] && [ -s "$wo" ]; then
      echo "-- rep $i/$RUNS: already done, skipping"
      continue
    fi
    repdir="$repodir/rep$i"
    mkdir -p "$repdir"
    echo "-- rep $i/$RUNS: running A/B pair (log: $repdir/run.log)"
    if AGENT_EVAL_OUT="$repdir" bash "$RUN_ALL" "$repo" "$q" headless >"$repdir/run.log" 2>&1; then
      collect_rep "$repdir" "$repodir" "$i"
      if [ -s "$w" ] && [ -s "$wo" ]; then
        echo "   rep $i OK"
      else
        echo "   rep $i INCOMPLETE — a run-headless jsonl is missing/empty; see $repdir/run.log"
      fi
    else
      collect_rep "$repdir" "$repodir" "$i"
      echo "   rep $i FAILED — see $repdir/run.log"
    fi
  done
done

echo
echo "==================== report ===================="
node "$BENCH_DIR/report.mjs" "$OUT" || true
echo
echo "done. results in $OUT"
