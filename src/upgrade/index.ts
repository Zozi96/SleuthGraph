/**
 * `sleuth upgrade`
 *
 * Self-update for the CLI, whatever way it was installed:
 *
 *   - **bundle** — the self-contained runtime+app installed by `install.sh`
 *     (Linux/macOS) or `install.ps1` (Windows). Upgrading re-runs the SAME
 *     canonical installer script (single source of truth) so the download /
 *     version-resolution / PATH logic never drifts between first-install and
 *     upgrade.
 *   - **npm** — installed via `npm i -g @zozi96/sleuthgraph`. Upgrading
 *     shells out to npm.
 *   - **npx** — ephemeral; nothing to upgrade (next `npx` fetches latest).
 *   - **source** — a git checkout running its own `dist/`; `git pull` + rebuild.
 *
 * Detection is structural (see `detectInstallMethod`): a bundle carries a
 * vendored `node` binary and a `bin/sleuth` launcher next to its `lib/`, so
 * we can recognize it from the running file's path without a marker file.
 *
 * Windows wrinkle: a running `node.exe` and a loaded `.node` addon are locked —
 * they can't be overwritten or deleted, by this process or by the MCP servers
 * of open agent sessions. They CAN be renamed, so the Windows upgrade unpacks
 * the new bundle next to `current\` and swaps it in file by file, renaming each
 * replaced file aside and rolling every step back on failure (see
 * `WINDOWS_SWAP_FUNCTION`, shared verbatim with `install.ps1`).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawnSync } from 'child_process';
import { ansiColorsEnabled } from '../ui/color';

export const REPO = 'Zozi96/SleuthGraph';
export const NPM_PACKAGE = '@zozi96/sleuthgraph';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
export const INSTALL_SH_URL = `${RAW_BASE}/install.sh`;
export const INSTALL_PS1_URL = `${RAW_BASE}/install.ps1`;

// ---------------------------------------------------------------------------
// Install-method detection (pure — fully unit-testable via injected probes)
// ---------------------------------------------------------------------------

export type InstallMethod =
  | { kind: 'bundle'; os: 'unix' | 'windows'; bundleRoot: string; installDir: string | null }
  | { kind: 'npm'; scope: 'global' | 'local' }
  | { kind: 'npx' }
  | { kind: 'source'; root: string }
  | { kind: 'unknown'; reason: string };

export interface DetectInput {
  /** `__filename` of the running CLI module — `<…>/dist/bin/sleuth.js`. */
  filename: string;
  platform: NodeJS.Platform;
  cwd: string;
  /** Injectable existence probe (defaults to fs.existsSync) — for tests. */
  exists?: (p: string) => boolean;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Where the bundle installer keeps its install root, derived from the bundle
 * dir so an upgrade reuses a custom `SLEUTH_INSTALL_DIR`. Returns null when
 * the layout isn't the one the installer creates (then the installer falls
 * back to its own default).
 *
 *   unix:    <installDir>/versions/<vX.Y.Z>   (bundleRoot)  → <installDir>
 *   windows: <installDir>\current             (bundleRoot)  → <installDir>
 */
export function deriveInstallDir(
  bundleRoot: string,
  os: 'unix' | 'windows',
  exists: (p: string) => boolean
): string | null {
  // Use the TARGET platform's path semantics (not the host's), so this is
  // deterministic when reasoning about a Windows layout from a POSIX host (CI)
  // and vice-versa. In production `os` always matches the running platform.
  const P = os === 'windows' ? path.win32 : path.posix;
  if (os === 'windows') {
    if (P.basename(bundleRoot).toLowerCase() === 'current') {
      return P.dirname(bundleRoot);
    }
    return null;
  }
  // unix: bundleRoot is <installDir>/versions/<version>
  const parent = P.dirname(bundleRoot);
  if (P.basename(parent) === 'versions') {
    const installDir = P.dirname(parent);
    return exists(installDir) ? installDir : P.dirname(parent);
  }
  return null;
}

export function detectInstallMethod(input: DetectInput): InstallMethod {
  const exists = input.exists ?? fs.existsSync;
  const isWin = input.platform === 'win32';
  // Path math keyed on the TARGET platform so detection is host-independent
  // (a Windows layout resolves correctly even when unit-tested on macOS/Linux).
  const P = isWin ? path.win32 : path.posix;
  const binDir = P.dirname(input.filename); // <…>/bin

  const norm = toPosix(input.filename);

  // Path-based checks come FIRST. The npm thin-installer's per-platform
  // package (@zozi96/sleuthgraph-<platform>-<arch>) is itself a complete
  // bundle — vendored node + bin/ launcher — living inside node_modules, so
  // the layout sniff below would misread every npm install as a standalone
  // bundle. `upgrade` would then curl install.sh into ~/.sleuth: a SECOND
  // install that never wins the PATH race against npm's shim, leaving
  // `sleuth -v` permanently on the old version (the #1071 shadow,
  // self-inflicted). A path under node_modules is authoritative about HOW the
  // user installed, whatever the artifact inside looks like.

  // npx cache: <…>/_npx/<hash>/node_modules/@zozi96/sleuthgraph/…
  // (checked before npm — the npx cache path also contains /node_modules/).
  if (norm.includes('/_npx/')) {
    return { kind: 'npx' };
  }

  // npm install (global or local): lives under a node_modules tree.
  if (norm.includes('/node_modules/')) {
    const underCwd = norm.startsWith(toPosix(P.resolve(input.cwd)) + '/');
    return { kind: 'npm', scope: underCwd ? 'local' : 'global' };
  }

  // Bundle: <root>/lib/dist/bin/sleuth.js → <root> is up 3 from bin/.
  // A bundle has a vendored node + a launcher script as siblings of lib/.
  const bundleRoot = P.resolve(binDir, '..', '..', '..');
  const vendoredNode = P.join(bundleRoot, isWin ? 'node.exe' : 'node');
  const launcher = P.join(bundleRoot, 'bin', isWin ? 'sleuth.cmd' : 'sleuth');
  if (exists(vendoredNode) && exists(launcher)) {
    const os = isWin ? 'windows' : 'unix';
    return { kind: 'bundle', os, bundleRoot, installDir: deriveInstallDir(bundleRoot, os, exists) };
  }

  // Source checkout: running <repo>/dist/bin/sleuth.js with a sibling .git.
  const repoRoot = P.resolve(binDir, '..', '..');
  if (exists(P.join(repoRoot, 'package.json')) && exists(P.join(repoRoot, '.git'))) {
    return { kind: 'source', root: repoRoot };
  }

  return { kind: 'unknown', reason: `unrecognized install layout at ${input.filename}` };
}

// ---------------------------------------------------------------------------
// Version helpers (pure)
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function parseSemver(version: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return null;
  return {
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    pre: m[4] ?? null,
  };
}

/** Returns >0 if a>b, <0 if a<b, 0 if equal. Throws on unparseable input. */
export function compareVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa || !sb) throw new Error(`cannot compare versions: "${a}" vs "${b}"`);
  if (sa.major !== sb.major) return sa.major - sb.major;
  if (sa.minor !== sb.minor) return sa.minor - sb.minor;
  if (sa.patch !== sb.patch) return sa.patch - sb.patch;
  // A prerelease is "less than" its release (1.0.0-rc < 1.0.0).
  if (sa.pre && !sb.pre) return -1;
  if (!sa.pre && sb.pre) return 1;
  if (sa.pre && sb.pre) return sa.pre < sb.pre ? -1 : sa.pre > sb.pre ? 1 : 0;
  return 0;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
  try {
    return compareVersions(latest, current) > 0;
  } catch {
    // If either is unparseable (e.g. a dev "0.0.0-unknown"), treat differing
    // strings as "update available" so the user isn't stuck.
    return normalizeVersion(current) !== normalizeVersion(latest);
  }
}

/** `0.9.9` / `v0.9.9` → `v0.9.9` (release tags are v-prefixed). */
export function normalizeVersion(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t : `v${t}`;
}

/** Strip a leading `v`: `v0.9.9` → `0.9.9`. */
export function stripV(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t.slice(1) : t;
}

/**
 * Parse the release tag out of the `Location` header GitHub returns for
 * `/releases/latest` → `…/releases/tag/v0.9.9`. Pure so it's unit-tested.
 */
export function parseLatestTagFromLocation(location: string | undefined): string | null {
  if (!location) return null;
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location);
  return m ? decodeURIComponent(m[1]!) : null;
}

// ---------------------------------------------------------------------------
// Latest-version resolution (network)
// ---------------------------------------------------------------------------

function httpsGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
  });
}

/**
 * Resolve the latest release tag (e.g. `v0.9.9`).
 *
 * Primary: read the redirect `Location` from `github.com/<repo>/releases/latest`
 * — same trick install.sh uses, because the unauthenticated GitHub API is
 * rate-limited to 60 req/h/IP and 403s on shared/cloud hosts (issue #325). The
 * redirect has no such limit. Fall back to the API only if the redirect can't
 * be read.
 */
export async function resolveLatestVersion(repo = REPO, timeoutMs = 12000): Promise<string> {
  try {
    const res = await httpsGet(
      `https://github.com/${repo}/releases/latest`,
      { 'User-Agent': 'sleuth-upgrade' },
      timeoutMs
    );
    const loc = res.headers.location;
    const tag = parseLatestTagFromLocation(Array.isArray(loc) ? loc[0] : loc);
    if (tag) return normalizeVersion(tag);
  } catch {
    /* fall through to API */
  }
  try {
    const res = await httpsGet(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { 'User-Agent': 'sleuth-upgrade', Accept: 'application/vnd.github+json' },
      timeoutMs
    );
    const tag = JSON.parse(res.body)?.tag_name;
    if (typeof tag === 'string' && tag) return normalizeVersion(tag);
  } catch {
    /* fall through to error */
  }
  throw new Error(
    'could not resolve the latest version from GitHub. Check your network, or pin a version: `sleuth upgrade <version>`.'
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  /** Pin a specific version (positional arg or SLEUTH_VERSION). */
  version?: string;
  /** Report current vs latest, don't change anything. */
  check?: boolean;
  /** Reinstall even if already on the resolved version. */
  force?: boolean;
}

/** Injectable side-effects so the orchestrator stays unit-testable. */
export interface UpgradeDeps {
  currentVersion: string;
  method: InstallMethod;
  resolveLatest: (pin?: string) => Promise<string>;
  /** Run a command inheriting stdio; returns its exit code (-1 = spawn failed). */
  run: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => number;
  /** Run a command capturing stdout (nothing reaches the terminal); null = spawn failed. */
  capture: (cmd: string, args: string[]) => { code: number; stdout: string } | null;
  hasCommand: (cmd: string) => boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  platform: NodeJS.Platform;
  /**
   * Wire Claude Code's front-load prompt hook into the GLOBAL Claude profile
   * when that profile already has SleuthGraph configured; resolves true when it
   * changed the settings file. That file is the user's real
   * `~/.claude/settings.json`, so the writer is injected like every other side
   * effect here — the CLI passes {@link defaultWirePromptHook}, unit tests a
   * recorder (#2275: tests that reached the real one rewrote the developer's).
   */
  wirePromptHook: () => Promise<boolean>;
}

// Colors off when piped / NO_COLOR / --no-color (#1281).
const useColor = ansiColorsEnabled();
const c = {
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

/** The honest, additive re-index reminder shown after a successful upgrade. */
export function reindexAdvisory(): string {
  return [
    c.dim('Your existing project indexes keep working, but were built by the previous version.'),
    c.dim('To pick up this version’s extraction improvements, refresh each project:'),
    `  ${c.cyan('sleuth sync')}        ${c.dim('# incremental, fast')}`,
    `  ${c.cyan('sleuth index -f')}    ${c.dim('# full rebuild')}`,
    c.dim('(`sleuth status` flags any index that predates the engine you’re running.)'),
  ].join('\n');
}

/**
 * Returns the process exit code (0 = success / nothing to do, 1 = failure).
 */
export async function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<number> {
  const { currentVersion, method } = deps;

  // Resolve the target version (pinned or latest).
  let latest: string;
  try {
    latest = normalizeVersion(opts.version || (await deps.resolveLatest()));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const currentDisplay = normalizeVersion(currentVersion);
  deps.log(`${c.bold('SleuthGraph')}  current ${c.cyan(currentDisplay)}  ${opts.version ? 'target' : 'latest'} ${c.cyan(latest)}`);

  const updateAvailable = isUpdateAvailable(currentVersion, latest);

  if (opts.check) {
    if (updateAvailable) {
      deps.log(c.yellow(`An update is available: ${currentDisplay} → ${latest}`));
      deps.log(c.dim('Run `sleuth upgrade` to install it.'));
    } else {
      deps.log(c.green(`You’re on the latest version (${currentDisplay}).`));
    }
    return 0;
  }

  if (!updateAvailable && !opts.force && !opts.version) {
    deps.log(c.green(`Already up to date (${currentDisplay}).`));
    deps.log(c.dim('Use `--force` to reinstall, or `sleuth upgrade <version>` to change versions.'));
    return 0;
  }

  // Dispatch by install method. bundle/npm perform a real binary update, so
  // after they succeed we self-heal the front-load hook (below); npx/source/
  // unknown don't update anything here, so they return directly.
  let code: number;
  switch (method.kind) {
    case 'bundle':
      code = await (method.os === 'windows'
        ? upgradeWindowsBundle(method, latest, deps)
        : upgradeUnixBundle(method, opts.version ? latest : undefined, deps));
      break;
    case 'npm':
      // npm version specs have no leading "v" (`@0.9.8`, not `@v0.9.8` — the
      // latter resolves as a nonexistent dist-tag).
      code = await upgradeNpm(method, opts.version ? stripV(latest) : 'latest', deps);
      break;
    case 'npx':
      deps.log(c.green('npx always runs the latest version on demand — nothing to upgrade.'));
      deps.log(c.dim(`Force a fresh fetch with: npx ${NPM_PACKAGE}@latest`));
      return 0;
    case 'source':
      deps.warn(`Running from a source checkout at ${method.root}.`);
      deps.log(c.dim('Upgrade it with: git pull && npm run build'));
      return 0;
    default:
      deps.error(`Couldn’t determine how SleuthGraph was installed (${method.reason}).`);
      deps.log(c.dim(`Reinstall manually — see https://github.com/${REPO}#install`));
      return 1;
  }

  // After a successful update, ensure the front-load prompt hook is wired for an
  // already-configured global Claude install — so existing users pick it up on
  // upgrade, not only on a fresh `install` (the hook config is version-agnostic,
  // so the still-running old binary can write it safely). Idempotent + gated on
  // an existing Claude config, and skipped entirely by the kill-switch. Never
  // fatal to the upgrade.
  if (code === 0) {
    let probe: VersionProbe = 'inconclusive';
    try {
      probe = reportResolvedVersion(latest, deps);
    } catch {
      /* an inconclusive probe must not fail the upgrade */
    }
    try {
      await selfHealPromptHook(deps);
    } catch {
      /* a hook-wiring hiccup must not fail the upgrade */
    }
    // The refresh executes whatever `sleuth` PATH resolves. If the probe
    // just proved that's a stale shadowed install, spawning it would rewrite
    // the agent surfaces with the very templates the refresh exists to heal —
    // skip, and point at the manual command for after the PATH is fixed.
    if (probe !== 'mismatch') {
      try {
        selfHealInstalledSurfaces(deps);
      } catch {
        /* a refresh hiccup must not fail the upgrade */
      }
    } else {
      deps.log(c.dim('Skipped refreshing agent instructions/config — run `sleuth install --refresh` once the PATH is fixed.'));
    }
  }
  return code;
}

type VersionProbe = 'match' | 'mismatch' | 'inconclusive';

/**
 * Prove the upgrade actually took: spawn the `sleuth` this terminal's PATH
 * resolves and compare its reported version to the target. Catches the silent
 * failure mode where ANOTHER install shadows the one we just upgraded (issue
 * #1071 — e.g. a stale `npm i -g` copy earlier on PATH than the bundle
 * launcher): the upgrade "succeeds" but `sleuth -v` — in this terminal and
 * every future one — keeps serving the old version. Exported for unit tests.
 */
export function verifyResolvedVersion(latest: string, deps: UpgradeDeps): VersionProbe {
  if (!deps.hasCommand('sleuth')) return 'inconclusive';
  // Windows installs expose sleuth through a .cmd launcher; Node can't
  // spawn .cmd files without a shell, so route through cmd.exe there.
  const probe = deps.platform === 'win32'
    ? deps.capture('cmd.exe', ['/d', '/s', '/c', 'sleuth --version'])
    : deps.capture('sleuth', ['--version']);
  if (!probe || probe.code !== 0) return 'inconclusive';
  // `sleuth --version` prints the bare version; take the last non-empty
  // line so a stray runtime warning above it can't spoil the parse.
  const reported = probe.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
  if (!parseSemver(reported)) return 'inconclusive';
  return compareVersions(reported, latest) === 0 ? 'match' : 'mismatch';
}

/**
 * Log the outcome of the post-upgrade version probe. On a match the user
 * knows the current terminal is already serving the new version; on a
 * mismatch they get told exactly which stale install is hijacking their PATH
 * instead of discovering it via a mysteriously unchanged `sleuth -v`.
 * Inconclusive probes fall back to the old soft hint — never a scare on
 * setups we can't inspect (no `sleuth` on PATH yet, exotic wrappers).
 * Returns the probe result so the caller can gate the post-upgrade refresh
 * (which spawns the PATH-resolved binary) on it.
 */
function reportResolvedVersion(latest: string, deps: UpgradeDeps): VersionProbe {
  const { method } = deps;
  // A project-local npm install isn't served by PATH's `sleuth` (that
  // would be some other install) — a probe could only false-alarm.
  if (method.kind === 'npm' && method.scope === 'local') return 'inconclusive';
  const probe = verifyResolvedVersion(latest, deps);
  switch (probe) {
    case 'match':
      deps.log(c.green(`✓ \`sleuth\` on your PATH now reports ${latest} — this terminal is already using it.`));
      break;
    case 'mismatch':
      deps.warn(`Installed ${latest}, but the \`sleuth\` this terminal resolves still reports an older version.`);
      deps.log(c.dim('Another SleuthGraph install earlier on your PATH is shadowing the one just upgraded.'));
      deps.log(c.dim('Find every copy with `which -a sleuth` (Windows: `where sleuth`) and remove or upgrade the stale one.'));
      break;
    case 'inconclusive':
      deps.log(c.dim('Open a new terminal if `sleuth --version` looks unchanged (PATH cache).'));
      break;
  }
  return probe;
}

/**
 * Refresh the agent surfaces previous installs wrote — the marker-fenced
 * instructions sections (CLAUDE.md / AGENTS.md / GEMINI.md), MCP entries,
 * legacy-hook cleanups — so they match the version that will serve them.
 * Unlike the prompt hook above, this content is NOT version-agnostic: the
 * templates are baked into the binary, so the still-running old process
 * would only rewrite its own stale copy — the exact staleness this heals.
 * We therefore spawn the freshly-installed binary (`sleuth install
 * --refresh`), which is refresh-only: agents never configured stay
 * untouched, and permission / prompt-hook choices are preserved. Gated on
 * `sleuth` being resolvable on PATH (an npm-local install isn't) and on
 * the kill-switch; never fatal to the upgrade.
 */
function selfHealInstalledSurfaces(deps: UpgradeDeps): void {
  if (process.env.SLEUTH_NO_INSTALL_REFRESH === '1') return;
  if (!deps.hasCommand('sleuth')) return;
  deps.log(c.dim('Refreshing agent instruction sections and config written by previous versions…'));
  // Windows installs expose sleuth through a .cmd launcher. Node cannot
  // spawn .cmd files directly without a shell, so route the constant command
  // through cmd.exe there (the same launcher a terminal would resolve).
  const code = deps.platform === 'win32'
    ? deps.run('cmd.exe', ['/d', '/s', '/c', 'sleuth install --refresh'])
    : deps.run('sleuth', ['install', '--refresh']);
  if (code !== 0) {
    deps.warn('Could not refresh the installed agent surfaces — run `sleuth install --refresh` manually.');
  }
}

/**
 * Wire the Claude `UserPromptSubmit` front-load hook on upgrade for an
 * already-configured global Claude install. No-op when Claude isn't configured,
 * when the hook is already present, or when the kill-switch is set.
 */
async function selfHealPromptHook(deps: UpgradeDeps): Promise<void> {
  if (process.env.SLEUTH_NO_PROMPT_HOOK === '1' || process.env.SLEUTH_PROMPT_HOOK === '0') return;
  if (await deps.wirePromptHook()) {
    deps.log(
      c.dim('Enabled the SleuthGraph front-load hook for Claude Code (structural prompts). Disable any time: SLEUTH_NO_PROMPT_HOOK=1'),
    );
  }
}

function upgradeUnixBundle(
  method: Extract<InstallMethod, { kind: 'bundle' }>,
  pinned: string | undefined,
  deps: UpgradeDeps
): number {
  const downloader = deps.hasCommand('curl')
    ? `curl -fsSL ${INSTALL_SH_URL}`
    : deps.hasCommand('wget')
      ? `wget -qO- ${INSTALL_SH_URL}`
      : null;
  if (!downloader) {
    deps.error('Neither curl nor wget is available to download the installer.');
    deps.log(c.dim(`Install curl, or run manually:  ${INSTALL_SH_URL} | sh`));
    return 1;
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (method.installDir) env.SLEUTH_INSTALL_DIR = method.installDir;
  if (pinned) env.SLEUTH_VERSION = pinned;

  deps.log(c.dim(`Running the installer (${downloader} | sh)…`));
  const code = deps.run('sh', ['-c', `${downloader} | sh`], env);
  if (code !== 0) {
    deps.error(`Installer exited with code ${code}.`);
    return 1;
  }
  deps.log('');
  // No "open a new terminal" hedge here — after the swap, runUpgrade probes
  // the PATH-resolved `sleuth --version` and reports the real outcome.
  deps.log(c.green('✓ Upgrade complete.'));
  deps.log(reindexAdvisory());
  return 0;
}

/**
 * The PowerShell function that moves an unpacked Windows bundle into the
 * install's `current\` dir. Shared VERBATIM with `install.ps1` (a test pins the
 * two copies equal), so a first install, a re-run of the installer, and
 * `sleuth upgrade` all replace files the same way.
 *
 * Why file-by-file renames (#2185): every open agent session runs a SleuthGraph
 * MCP server from `current\`, which keeps `node.exe` and the native kernel
 * (`lib\kernel\sleuth-kernel.node`) locked. Windows refuses to overwrite or
 * delete a running exe or a loaded DLL but does let it be renamed. The old
 * upgrade renamed only `node.exe` and then `Copy-Item`ed over the rest, so the
 * locked kernel failed the copy halfway — leaving no `node.exe` and a mix of
 * versions, which no `sleuth` command could repair. Now each file being
 * replaced (or dropped by the new version) is renamed aside to
 * `<name>.old-<token>` before the staged file is moved in; any failure undoes
 * every step, and the renamed-aside files are deleted on the next successful
 * run once nothing holds them.
 */
export const WINDOWS_SWAP_FUNCTION = String.raw`function Install-SleuthGraphFiles([string]$Stage, [string]$Dest) {
  # Move an unpacked bundle into $Dest. Windows can't overwrite or delete a
  # running node.exe or a loaded .node addon, but it can rename one, so every
  # file being replaced (or dropped by the new version) is first renamed aside
  # to <name>.old-<token>. Any failure puts every file back, so the install is
  # never left half-replaced or without its node.exe.
  $ErrorActionPreference = 'Stop'
  $stageDir = (Resolve-Path -LiteralPath $Stage).ProviderPath.TrimEnd('\')
  foreach ($need in 'node.exe', 'bin\sleuth.cmd') {
    if (-not (Test-Path -LiteralPath (Join-Path $stageDir $need))) { throw "The SleuthGraph download is incomplete (no $need); nothing was changed." }
  }
  $token = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $asideName = '\.old-[0-9a-f]{8,32}$'
  $files = @{}; $dirs = @{}
  foreach ($i in @(Get-ChildItem -LiteralPath $stageDir -Recurse -Force)) {
    $rel = $i.FullName.Substring($stageDir.Length)
    if ($i.PSIsContainer) { $dirs[$rel] = $true } else { $files[$rel] = $true }
  }
  $undo = New-Object System.Collections.ArrayList
  function Move-Logged([string]$From, [string]$To) { [IO.File]::Move($From, $To); [void]$undo.Add(@($From, $To)) }
  function Undo-Logged {
    $lost = 0
    for ($n = $undo.Count - 1; $n -ge 0; $n--) {
      $u = $undo[$n]
      try { if ($u.Count -eq 2) { [IO.File]::Move($u[1], $u[0]) } else { [IO.Directory]::Delete($u[0]) } } catch { if ($u.Count -eq 2) { $lost++ } }
    }
    $undo.Clear()
    $lost
  }
  $done = $false; $at = $Dest
  try {
    if (-not (Test-Path -LiteralPath $Dest)) { [void][IO.Directory]::CreateDirectory($Dest); [void]$undo.Add(@($Dest)) }
    $destDir = (Resolve-Path -LiteralPath $Dest).ProviderPath.TrimEnd('\')
    foreach ($f in @(Get-ChildItem -LiteralPath $destDir -Recurse -Force -File)) {
      if (-not $files.ContainsKey($f.FullName.Substring($destDir.Length)) -and $f.Name -notmatch $asideName) {
        $at = $f.FullName; Move-Logged $at "$at.old-$token"
      }
    }
    foreach ($rel in @($dirs.Keys | Sort-Object Length)) {
      $at = $destDir + $rel
      if (-not [IO.Directory]::Exists($at)) { [void][IO.Directory]::CreateDirectory($at); [void]$undo.Add(@($at)) }
    }
    foreach ($rel in @($files.Keys)) {
      $at = $destDir + $rel
      if ([IO.File]::Exists($at)) { Move-Logged $at "$at.old-$token" }
      Move-Logged ($stageDir + $rel) $at
    }
    $done = $true
  } catch {
    $x = $_.Exception; while ($x.InnerException) { $x = $x.InnerException }
    $lost = Undo-Logged
    $msg = "Could not replace $at ($($x.Message))."
    if ($lost) {
      $msg += " $lost file(s) could not be put back, so the install may not start. Close your agent sessions and any running sleuth commands, then reinstall: irm https://raw.githubusercontent.com/Zozi96/SleuthGraph/main/install.ps1 | iex"
    } else {
      $msg += " Nothing was changed: the existing install still works. If another program has SleuthGraph's files open, close your agent sessions (they run the SleuthGraph MCP server) and any running sleuth commands, then try again."
    }
    $e = New-Object System.Exception($msg); $e.Data['sleuthDamaged'] = [bool]$lost; throw $e
  } finally {
    # Interrupted (Ctrl+C) without reaching catch: still put everything back.
    if (-not $done) { [void](Undo-Logged) }
  }
  # Delete what this run and earlier ones renamed aside. A file a running
  # process still holds can't be deleted yet; the next install retries it.
  foreach ($f in @(Get-ChildItem -LiteralPath $destDir -Recurse -Force -File -ErrorAction SilentlyContinue)) {
    if ($f.Name -match $asideName) { try { [IO.File]::Delete($f.FullName) } catch {} }
  }
  foreach ($d in @(Get-ChildItem -LiteralPath $destDir -Recurse -Force -Directory -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } -Descending)) {
    if (-not $dirs.ContainsKey($d.FullName.Substring($destDir.Length))) { try { [IO.Directory]::Delete($d.FullName) } catch {} }
  }
}
`;

/** Single-quote a value for PowerShell (a `'` inside is doubled). */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Exit code of the upgrade script when files could not all be put back. */
export const WINDOWS_UPGRADE_DAMAGED = 2;

/** Build the in-place Windows upgrade script (exported for unit-testing). */
export function buildWindowsUpgradeScript(bundleRoot: string, version: string, arch: string): string {
  const target = `win32-${arch}`;
  const url = `https://github.com/${REPO}/releases/download/${version}/sleuthgraph-${target}.zip`;
  // Synchronous, no detached helper (which dies under SSH/job objects and has
  // worse UX). The bundle is unpacked into a sibling of current\ — the same
  // volume, so the swap is renames, never a half-finished copy — and nothing
  // in current\ changes until it is fully unpacked. The running process keeps
  // its renamed node.exe mapped; the NEXT `sleuth` invocation uses the new
  // one. Exit codes: 0 installed, 1 failed with the install unchanged,
  // WINDOWS_UPGRADE_DAMAGED when the rollback could not restore every file.
  return [
    `$ErrorActionPreference='Stop'`,
    WINDOWS_SWAP_FUNCTION,
    `$dest=${psQuote(bundleRoot)}`,
    `$url=${psQuote(url)}`,
    `$tmp=Join-Path $env:TEMP ('cg-up-'+[guid]::NewGuid().ToString('N'))`,
    `$stage=Join-Path (Split-Path -Parent $dest) ('.staging-'+[guid]::NewGuid().ToString('N').Substring(0,8))`,
    `$code=0`,
    `try {`,
    `  Write-Host "Downloading $url"`,
    `  New-Item -ItemType Directory -Force -Path $tmp | Out-Null`,
    `  $zip=Join-Path $tmp 'cg.zip'`,
    `  Invoke-WebRequest -Uri $url -OutFile $zip`,
    `  Expand-Archive -Path $zip -DestinationPath $stage -Force`,
    `  $inner=Join-Path $stage 'sleuthgraph-${target}'`,
    `  Install-SleuthGraphFiles $(if(Test-Path $inner){$inner}else{$stage}) $dest`,
    `  Write-Host "Installed SleuthGraph ${version} to $dest"`,
    `} catch {`,
    `  [Console]::Error.WriteLine($_.Exception.Message)`,
    `  $code=if($_.Exception.Data['sleuthDamaged']){${WINDOWS_UPGRADE_DAMAGED}}else{1}`,
    `}`,
    `Remove-Item -LiteralPath $stage,$tmp -Recurse -Force -ErrorAction SilentlyContinue`,
    `exit $code`,
  ].join('\n');
}

function upgradeWindowsBundle(
  method: Extract<InstallMethod, { kind: 'bundle' }>,
  latest: string,
  deps: UpgradeDeps
): number {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const script = buildWindowsUpgradeScript(method.bundleRoot, latest, arch);
  // -EncodedCommand (base64 UTF-16LE), NOT -Command: Node's Windows argv→command
  // -line quoting mangles a long multi-statement script, so PowerShell never
  // parses it. Encoding sidesteps all shell quoting — the canonical approach.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  deps.log(c.dim(`Downloading and installing ${latest}…`));
  const code = deps.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  if (code !== 0) {
    // The script has already printed what went wrong and what to do.
    if (code === WINDOWS_UPGRADE_DAMAGED) {
      deps.error('The upgrade failed and some files could not be put back.');
      deps.log(c.dim(`Close your agent sessions and any running sleuth commands, then reinstall:  irm ${INSTALL_PS1_URL} | iex`));
    } else if (code === 1) {
      deps.error(`The upgrade to ${latest} did not complete; your existing install was left as it was.`);
    } else {
      deps.error(`Installer exited with code ${code}.`);
    }
    return 1;
  }
  deps.log('');
  // The running node.exe was renamed aside, so the version probe in
  // runUpgrade already exercises the NEW binary — no terminal hedge needed.
  deps.log(c.green('✓ Upgrade complete.'));
  deps.log(reindexAdvisory());
  return 0;
}

/**
 * How to invoke npm. On Windows npm is a .cmd batch file, which Node refuses
 * to spawn without a shell (EINVAL since the CVE-2024-27980 hardening) — a
 * direct `npm.cmd` spawn fails on every current Node, so route it through
 * cmd.exe, the same way the surface-refresh step invokes the .cmd launcher.
 * (Verified live on the Windows VM: `spawnSync('npm.cmd')` → EINVAL;
 * `cmd.exe /d /s /c npm …` → works.)
 */
export function npmInvocation(platform: NodeJS.Platform, npmArgs: string[]): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...npmArgs].join(' ')] };
  }
  return { cmd: 'npm', args: npmArgs };
}

function upgradeNpm(
  method: Extract<InstallMethod, { kind: 'npm' }>,
  versionSpec: string,
  deps: UpgradeDeps
): number {
  const args = method.scope === 'global'
    ? ['install', '-g', `${NPM_PACKAGE}@${versionSpec}`]
    : ['install', `${NPM_PACKAGE}@${versionSpec}`];
  deps.log(c.dim(`Running: npm ${args.join(' ')}`));
  const inv = npmInvocation(deps.platform, args);
  const code = deps.run(inv.cmd, inv.args, process.env);
  if (code !== 0) {
    deps.error(`npm exited with code ${code}.`);
    if (method.scope === 'global') {
      deps.log(c.dim('If this is a permissions error (EACCES), your global prefix needs sudo, or use a'));
      deps.log(c.dim('Node version manager (nvm/fnm) so global installs don’t require root.'));
    }
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.'));
  deps.log(reindexAdvisory());
  return 0;
}

// ---------------------------------------------------------------------------
// Production deps wiring (used by the CLI)
// ---------------------------------------------------------------------------

/**
 * True if `cmd` resolves to an executable on PATH. A pure-Node PATH scan — NOT
 * a spawned `command -v`/`which`: `command` is a shell builtin (no standalone
 * binary on Debian, though macOS ships one), and `which` isn't guaranteed
 * present on minimal images, so spawning either is unreliable. Scanning PATH
 * ourselves behaves identically on every platform.
 */
export function hasCommand(cmd: string): boolean {
  const isWin = process.platform === 'win32';
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (isWin) return true;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        /* not here / not executable — keep scanning */
      }
    }
  }
  return false;
}

export function defaultRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: env ?? process.env, windowsHide: true });
  if (r.error) return -1;
  return r.status ?? -1;
}

export function defaultCapture(cmd: string, args: string[]): { code: number; stdout: string } | null {
  // stdio is piped (the default with `encoding`), so nothing the probed
  // command prints reaches the user's terminal. The timeout keeps a wedged
  // probe from hanging the upgrade's last step.
  const r = spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, timeout: 30_000 });
  if (r.error) return null;
  return { code: r.status ?? -1, stdout: r.stdout ?? '' };
}

/**
 * The production `UpgradeDeps.wirePromptHook`: writes the hook only when the
 * global Claude profile already carries SleuthGraph's MCP entry, and leaves the
 * file byte-for-byte alone once the hook is there.
 */
export async function defaultWirePromptHook(): Promise<boolean> {
  const { claudeTarget, writePromptHookEntry } = await import('../installer/targets/claude');
  if (!claudeTarget.detect('global').alreadyConfigured) return false;
  const res = writePromptHookEntry('global');
  return res.action === 'created' || res.action === 'updated';
}
