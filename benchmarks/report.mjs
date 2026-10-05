#!/usr/bin/env node
// Aggregate a benchmarks/run-benchmark.sh output dir into per-repo median
// tables plus a cross-repo summary. One row per metric, one column per arm;
// every cell is `median [min–max]` over VALID runs — a run is invalid when the
// session did not end in success or the agent reached sleuth through the CLI
// (cliContaminated > 0 — that run was not what its arm claims to be).
//
// Usage: node benchmarks/report.mjs <out-dir>
//   <out-dir>/<repo>/run-headless-{with,without}-<i>.jsonl   (what run-benchmark
//   writes; discoverRuns also stitches any .tN turn segments)
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseSession } from '../scripts/agent-eval/parse-run.mjs';
import { discoverRuns } from '../scripts/agent-eval/compare-arms.mjs';

const ARMS = ['with', 'without'];

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** All metrics one run contributes. Kept flat so table rows can enumerate them. */
function measure(files) {
  const s = parseSession(files);
  const o = s.occupancy;
  return {
    ok: s.ok,
    raced: s.raced,
    contaminated: s.cliContaminated > 0,
    metrics: {
      'duration (s)': s.dur,
      'tool calls': s.tools,
      'Read': s.reads,
      'Grep/Glob': s.grep,
      'Bash': s.counts.Bash || 0,
      'sleuth calls': s.cg,
      'tokens processed': s.processed,
      'cost ($)': s.cost,
      'final context (tok)': o.ctxFinal,
      'file-access residual (tok)': o.residualFileAccess,
      'sleuth residual (tok)': o.residual.sleuth,
    },
  };
}

const int = (x) => Math.round(x).toLocaleString('en-US');
const money = (x) => `$${x.toFixed(3)}`;
const FMT = { 'cost ($)': money };

/** median [min–max]; '' when the arm has no valid runs. */
function span(runs, key) {
  const xs = runs.map((r) => r.metrics[key]).filter((x) => Number.isFinite(x));
  if (!xs.length) return '—';
  const fmt = FMT[key] || int;
  const m = fmt(median(xs));
  if (xs.length === 1) return m;
  const lo = fmt(Math.min(...xs)); const hi = fmt(Math.max(...xs));
  return lo === hi ? m : `${m} [${lo}–${hi}]`;
}

const METRICS = [
  'duration (s)', 'tool calls', 'Read', 'Grep/Glob', 'Bash', 'sleuth calls',
  'tokens processed', 'cost ($)', 'final context (tok)',
  'file-access residual (tok)', 'sleuth residual (tok)',
];

/** Per-repo table lines. `runs[arm]` = { valid, excluded: [{name, why}] }. */
function repoTable(name, runs) {
  const W = 32; const C = 26;
  const row = (label, cells) => '  ' + label.padEnd(W) + cells.map((c) => ' ' + String(c).padStart(C - 1)).join('');
  const out = [`\n===== ${name} =====`];
  out.push(row('', ARMS.map((a) => `headless-${a}`)));
  out.push(row('valid runs', ARMS.map((a) => runs[a].valid.length)));
  const excl = ARMS.flatMap((a) => runs[a].excluded.map((e) => `headless-${a}: ${e}`));
  if (excl.length) out.push('  excluded: ' + excl.join(' | '));
  out.push('');
  for (const key of METRICS) out.push(row(key, ARMS.map((a) => span(runs[a].valid, key))));
  return out;
}

const dir = process.argv[2];
if (!dir) { console.error('usage: report.mjs <out-dir>'); process.exit(1); }
if (!existsSync(dir)) { console.error(`no such dir: ${dir}`); process.exit(1); }

const repos = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory()
    && readdirSync(join(dir, d.name)).some((f) => /^run-headless-(with|without)-\d+.*\.jsonl$/.test(f)))
  .map((d) => d.name)
  .sort();

if (!repos.length) { console.error(`no run-headless-*-<i>.jsonl under ${dir}`); process.exit(1); }

const summary = []; // { repo, medians: { arm: { metric: median } } }
for (const repo of repos) {
  const repoDir = join(dir, repo);
  const runs = {};
  const medians = {};
  for (const arm of ARMS) {
    const valid = []; const excluded = [];
    for (const r of discoverRuns(repoDir, `headless-${arm}`)) {
      let m;
      try { m = measure(r.files); } catch (e) { excluded.push(`${r.name} (parse error: ${e.message})`); continue; }
      if (m.contaminated) { excluded.push(`${r.name} (CLI contamination)`); continue; }
      if (!m.ok) { excluded.push(`${r.name} (session not successful)`); continue; }
      valid.push(m);
    }
    runs[arm] = { valid, excluded };
    medians[arm] = Object.fromEntries(METRICS.map((k) => {
      const xs = valid.map((r) => r.metrics[k]).filter(Number.isFinite);
      return [k, xs.length ? median(xs) : null];
    }));
  }
  for (const line of repoTable(repo, runs)) console.log(line);
  summary.push({ repo, medians });
}

// Global summary: median of the per-repo arm medians, plus the with/without
// ratio — the hypothesis is comparative, so the ratio is the number to quote.
console.log('\n===== GLOBAL (median across repos) =====');
const W = 32; const C = 26;
const row = (label, cells) => '  ' + label.padEnd(W) + cells.map((c) => ' ' + String(c).padStart(C - 1)).join('');
console.log(row('', [...ARMS.map((a) => `headless-${a}`), 'with/without']));
for (const key of METRICS) {
  const meds = ARMS.map((a) => median(summary.map((s) => s.medians[a][key]).filter((x) => x !== null)));
  const fmt = FMT[key] || int;
  const ratio = meds[0] && meds[1] ? (meds[0] / meds[1]).toFixed(2) : '—';
  console.log(row(key, [...meds.map((m) => (m === null ? '—' : fmt(m))), ratio]));
}
const reposDone = summary.filter((s) => ARMS.every((a) => Object.values(s.medians[a]).some((v) => v !== null))).length;
console.log(`\n  repos with ≥1 valid run in each arm: ${reposDone}/${summary.length}`);
