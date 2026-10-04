# Benchmarks — with/without SleuthGraph A/B

A reproducible multi-repo harness that measures what SleuthGraph buys a headless
agent on cross-file architecture questions. It wraps the proven A/B harness in
`scripts/agent-eval/` — it adds no new measurement code, only orchestration
(N reps × M repos) and an aggregate report.

## Hypothesis

An agent answering a structural question with `sleuth_*` MCP tools (with-arm)
uses fewer tool calls, fewer Read/Grep round-trips, fewer processed tokens, less
wall-clock time, and less residual context than the same agent on the same
question with plain Read/Grep/Bash (without-arm). The mechanism: sleuth returns
the connected slice in one call, so the agent stops hunting instead of
accumulating file bytes into its window.

## Fairness controls

The only intended variable is the MCP server. Everything else is held constant
by `run-all.sh` and `no-cli-shim.sh`:

- **Same literal question** per repo, verbatim, both arms (`corpus.json`).
- **Same model**: `claude --model sonnet --effort high` in every session — the
  standing policy (Sonnet is the deliberate floor model; see
  `docs/AGENTS.md`). Never raise it.
- **`--strict-mcp-config`**: with-arm gets a config wiring `sleuth serve --mcp`;
  without-arm gets `{"mcpServers":{}}`. Built-in Read/Grep/Bash stay available
  in both.
- **CLI blocked in both arms** (`no-cli-shim.sh`): sanitized PATH plus a
  PreToolUse hook, so sleuth is reachable only through the MCP server. Without
  this, without-arm agents ran `sleuth explore` via Bash (14/15 runs in one
  campaign) and the arm wasn't "without" anything.
- **Same binary builds and serves the index**: each repo is wiped and
  re-indexed (`rm -rf .sleuth && sleuth init --yes`) with the `sleuth` on PATH
  before its reps, so index version can never drift from server version.
- **Ambient prompt hooks neutralized** (`SLEUTH_NO_PROMPT_HOOK=1` in run-all).

## Metrics and provenance

All parsing is `scripts/agent-eval/parse-run.mjs` (`parseSession`); the reporter
adds only median/range statistics:

| Metric | Source |
|---|---|
| tool calls, Read, Grep/Glob, Bash, `sleuth_*` calls | stream-json tool events (`counts`) |
| tokens processed | per-turn sum of assistant `usage` — **not** `result.usage`, which reports last-turn only in current Claude Code |
| cost | sum of `total_cost_usd` over the session's result events |
| duration | sum of `duration_ms` |
| residual context occupancy | replayed context timeline at end of run; `final context`, `file-access residual`, `sleuth residual` (tokens) |

**Median over N=5 reps**, reported with `[min–max]`: run-to-run variance in
agent trajectories is large, so a single run proves nothing and the range is
part of the result. Never quote one rep.

**Contamination**: a run where a sleuth CLI call *returned output* through Bash
is excluded from the median (`cliContaminated > 0` in parseSession — the
"CLI calls that RETURNED output" row). Blocked attempts don't invalidate.

## Cost

Each rep is two `claude -p --max-budget-usd 4` sessions. Assuming ~$0.5–2 per
session on these small/medium repos (assumption, not a bound), the default
campaign — 4 repos × 2 arms × 5 reps = 40 sessions — costs roughly **$20–80**.
The script prints the plan and requires `--yes` before spending anything.

## Running

```sh
# dry-run: prints the plan, spends nothing
benchmarks/run-benchmark.sh

# full campaign (resumable — finished reps are skipped)
benchmarks/run-benchmark.sh --yes

# subsets / knobs
benchmarks/run-benchmark.sh --yes --runs 2 --repos gin,flask
benchmarks/run-benchmark.sh --yes --out /tmp/my-run --corpus /tmp/sleuth-corpus
```

Results land in `benchmarks/results/<timestamp>/<repo>/run-headless-<arm>-<i>.jsonl`;
`report.mjs` prints per-repo tables and a global median-across-repos summary
(including the with/without ratio) at the end, or standalone:

```sh
node benchmarks/report.mjs benchmarks/results/<timestamp>
```

## Limits

- **Host = `claude -p` (Claude Code) only.** Occupancy shares assume the 200k
  window; absolute numbers don't transfer to other hosts — the arm *ratio*
  is the portable claim.
- `files` in `corpus.json` is an approximate source-file count for sizing.
- Four small/medium repos × one question each is a signal, not a verdict;
  small-n caveats from `docs/benchmarks/agent-eval-feedback-metrics.md` apply.
- Clones are `--depth 1` snapshots under `--corpus` (default
  `/tmp/sleuth-corpus`); upstream drift is a confound across campaigns.
