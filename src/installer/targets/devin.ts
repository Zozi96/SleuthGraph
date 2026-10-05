/**
 * Devin CLI target.
 *
 *   - MCP server entry to `mcp_config.json`: user scope
 *     `~/.config/devin/mcp_config.json` (POSIX honors `$XDG_CONFIG_HOME`;
 *     `%APPDATA%\devin` on Windows) or project scope
 *     `./.devin/mcp_config.json`. Devin's stdio schema is only
 *     command/args/env/disabled — there is NO `type` field — so the
 *     entry is `{command: 'sleuth', args: ['serve', '--mcp']}`.
 *   - Permissions + hooks to `config.json` beside it:
 *     `permissions.allow` takes the same `mcp__sleuth__*` glob as
 *     Claude (auto-approves all sleuth tools), and `hooks.
 *     UserPromptSubmit` takes Claude-shaped matcher groups running
 *     `sleuth prompt-hook` (Devin also reads `.claude/settings.json`
 *     hooks, so the Claude-format command is the right payload).
 *   - Instructions to `AGENTS.md` — Devin's rules file:
 *     `<user config dir>/AGENTS.md` (global), `./AGENTS.md` (local).
 *
 * Pre-v3000.3 Devin stored `mcpServers` inside `config.json`; newer
 * versions auto-migrate it out to `mcp_config.json`. `detect()` counts
 * a legacy `config.json.mcpServers.sleuth` entry as already-configured,
 * and `install()`/`uninstall()` strip it so an upgrade self-heals —
 * the same idiom as claude.ts's cleanupLegacyLocalMcp.
 *
 * Known overlap: Devin also loads `.claude/settings.json` hooks by
 * default, so a user who installed the prompt hook for BOTH claude and
 * devin gets two `sleuth prompt-hook` invocations per prompt under
 * Devin — duplicated injected context, harmless but wasteful. We don't
 * dedupe across targets here: skipping the write on a detected Claude
 * hook would couple this target to claude.ts's paths and silently lose
 * the hook if the user later uninstalls Claude.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  getSleuthGraphPermissions,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  upsertInstructionsEntry,
  writeJsonFile,
} from './shared';
import {
  SLEUTH_SECTION_END,
  SLEUTH_SECTION_START,
} from '../instructions-template';

function configDir(loc: Location): string {
  if (loc !== 'global') return path.join(process.cwd(), '.devin');
  // User dir: %APPDATA%\devin on Windows; $XDG_CONFIG_HOME (else
  // ~/.config)/devin on POSIX — the same resolution Devin itself uses.
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA && process.env.APPDATA.trim().length > 0
      ? process.env.APPDATA
      : path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'devin');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(
    xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), '.config'),
    'devin',
  );
}
function mcpConfigPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp_config.json');
}
function configJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'config.json');
}
function instructionsPath(loc: Location): string {
  // Global AGENTS.md lives under the user config dir; the local one is
  // the project-root AGENTS.md Devin reads for repo instructions —
  // same layout the codex target uses, NOT under .devin/.
  return loc === 'global'
    ? path.join(configDir('global'), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

/**
 * Devin's stdio MCP-server entry: command/args only. The shared
 * `getMcpServerConfig()` carries `type: 'stdio'`, which Devin's schema
 * does not have — so we take just the command and args from it.
 */
function getDevinMcpServerConfig(): { command: string; args: string[] } {
  const { command, args } = getMcpServerConfig();
  return { command, args };
}

class DevinTarget implements AgentTarget {
  readonly id = 'devin' as const;
  readonly displayName = 'Devin CLI';
  readonly docsUrl = 'https://docs.devin.ai/cli';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpConfigPath(loc);
    const config = readJsonFile(mcpPath);
    // A pre-v3000.3 install left `mcpServers` inside config.json — count
    // it as configured so refresh/uninstall still reach it.
    const legacy = readJsonFile(configJsonPath(loc));
    const alreadyConfigured =
      !!config.mcpServers?.sleuth || !!legacy.mcpServers?.sleuth;
    const installed =
      fs.existsSync(configDir(loc)) || fs.existsSync(mcpPath);
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry → mcp_config.json
    files.push(writeMcpEntry(loc));

    // 1b. Migrate a legacy `mcpServers.sleuth` out of config.json so the
    // project isn't left with a dead pre-v3000.3 copy (see file header).
    const migrated = stripLegacyMcpEntry(loc);
    if (migrated) files.push(migrated);

    // 2. Permissions → config.json `permissions.allow` (autoAllow only)
    if (opts.autoAllow) {
      files.push(writePermissionsEntry(loc));
    }

    // 3. Front-load prompt hook → config.json `hooks.UserPromptSubmit`.
    // `true` writes it; `false` strips what a prior install wrote so
    // opting out round-trips; `undefined` leaves it untouched.
    if (opts.promptHook === true) {
      files.push(writePromptHookEntry(loc));
    } else if (opts.promptHook === false) {
      const removed = removePromptHookEntry(loc);
      if (removed.action === 'removed') files.push(removed);
    }

    // 4. AGENTS.md — the marker-fenced SleuthGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry from mcp_config.json
    const mcpPath = mcpConfigPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.sleuth) {
      delete config.mcpServers.sleuth;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 1b. Also strip the legacy config.json key so uninstall fully
    // reverses a pre-v3000.3 install.
    const migrated = stripLegacyMcpEntry(loc);
    if (migrated) files.push(migrated);

    // 2. Permissions
    const cfgPath = configJsonPath(loc);
    const cfg = readJsonFile(cfgPath);
    if (Array.isArray(cfg.permissions?.allow)) {
      const before = cfg.permissions.allow.length;
      cfg.permissions.allow = cfg.permissions.allow.filter(
        (p: unknown) => typeof p !== 'string' || !p.startsWith('mcp__sleuth__'),
      );
      if (cfg.permissions.allow.length !== before) {
        if (cfg.permissions.allow.length === 0) {
          delete cfg.permissions.allow;
        }
        if (Object.keys(cfg.permissions).length === 0) {
          delete cfg.permissions;
        }
        writeJsonFile(cfgPath, cfg);
        files.push({ path: cfgPath, action: 'removed' });
      } else {
        files.push({ path: cfgPath, action: 'not-found' });
      }
    } else {
      files.push({ path: cfgPath, action: 'not-found' });
    }

    // 3. Remove the front-load prompt hook this installer may have written.
    const promptHookCleanup = removePromptHookEntry(loc);
    if (promptHookCleanup.action === 'removed') files.push(promptHookCleanup);

    // 4. Instructions — strip the marker-fenced block if present.
    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpConfigPath(loc);
    const snippet = JSON.stringify({ mcpServers: { sleuth: getDevinMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpConfigPath(loc), configJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpConfigPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.sleuth;
  const after = getDevinMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.sleuth = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Strip a legacy `mcpServers.sleuth` key out of `config.json` — the
 * shape pre-v3000.3 Devin used before MCP servers moved to their own
 * `mcp_config.json`. Surgical: only our `sleuth` key is removed;
 * sibling config keys are preserved, and the file is deleted only when
 * removal leaves it completely empty. Returns the file action for
 * reporting, or `null` when there's nothing to migrate.
 */
function stripLegacyMcpEntry(loc: Location): WriteResult['files'][number] | null {
  const file = configJsonPath(loc);
  if (!fs.existsSync(file)) return null;
  const config = readJsonFile(file);
  if (!config.mcpServers?.sleuth) return null;
  delete config.mcpServers.sleuth;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  if (Object.keys(config).length === 0) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  } else {
    writeJsonFile(file, config);
  }
  return { path: file, action: 'removed' };
}

/**
 * The front-load prompt-hook command written into Devin's
 * `hooks.UserPromptSubmit`. Same platform spelling as Claude's (see
 * PROMPT_HOOK_COMMAND in claude.ts): `sleuth.cmd` on Windows, where
 * the hook shell applies no PATHEXT (#1466).
 */
const PROMPT_HOOK_COMMAND = process.platform === 'win32'
  ? 'sleuth.cmd prompt-hook'
  : 'sleuth prompt-hook';

/**
 * Every spelling the installer has ever written — matched by substring,
 * same as claude.ts, so a config carried across platforms or an
 * `npx @zozi96/sleuthgraph …` form is recognized too.
 */
const PROMPT_HOOK_FORMS = ['sleuth prompt-hook', 'sleuth.cmd prompt-hook', 'sleuthgraph prompt-hook'];
function isPromptHookCommand(command: unknown): boolean {
  return typeof command === 'string' && PROMPT_HOOK_FORMS.some((f) => command.includes(f));
}

/**
 * Remove hook commands matching `match` from Devin `config.json` — the
 * claude.ts removeHookCommandsMatching algorithm pointed at Devin's
 * hooks surface. Surgical at the individual-command level: a matcher
 * group is pruned only once its `hooks` array is empty, an event only
 * once it has no groups left, `hooks` only once every event is gone —
 * and none of that runs unless a sleuth command was actually removed.
 */
function removeHookCommandsMatching(
  loc: Location,
  match: (command: unknown) => boolean,
): WriteResult['files'][number] {
  const file = configJsonPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const config = readJsonFile(file);
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { path: file, action: 'unchanged' };
  }

  // Pass 1: drop matching command(s) from inside every matcher group.
  let removedAny = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h: any) => !match(h?.command));
      if (group.hooks.length !== before) removedAny = true;
    }
  }

  if (!removedAny) return { path: file, action: 'unchanged' };

  // Pass 2: prune empty matcher groups, then empty events, then an
  // empty top-level `hooks` — guarded by `removedAny` so a config.json
  // with no matching hooks is left byte-for-byte untouched.
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.filter(
      (g: any) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0),
    );
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete config.hooks;

  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

/**
 * Remove the front-load `UserPromptSubmit` hook this installer writes.
 * Used by `uninstall`, and by `install` when the user opts out, so the
 * choice round-trips.
 */
function removePromptHookEntry(loc: Location): WriteResult['files'][number] {
  return removeHookCommandsMatching(loc, isPromptHookCommand);
}

function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
  const file = configJsonPath(loc);
  const config = readJsonFile(file);
  const created = !fs.existsSync(file);

  if (!config.permissions) config.permissions = {};
  if (!Array.isArray(config.permissions.allow)) config.permissions.allow = [];

  const want = getSleuthGraphPermissions();
  const before = [...config.permissions.allow];
  for (const perm of want) {
    if (!config.permissions.allow.includes(perm)) {
      config.permissions.allow.push(perm);
    }
  }
  if (jsonDeepEqual(before, config.permissions.allow) && !created) {
    return { path: file, action: 'unchanged' };
  }
  writeJsonFile(file, config);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Write the front-load `UserPromptSubmit` hook into Devin `config.json`
 * — a `command` hook running `sleuth prompt-hook`, which injects
 * sleuth_explore context for structural prompts. Devin uses Claude's
 * hook-group shape, `matcher` field included (Claude omits it; Devin
 * supports it). Idempotent and sibling-preserving, same semantics as
 * claude.ts's writePromptHookEntry.
 */
function writePromptHookEntry(loc: Location): WriteResult['files'][number] {
  const file = configJsonPath(loc);
  const created = !fs.existsSync(file);
  const config = readJsonFile(file);

  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  if (!Array.isArray(config.hooks.UserPromptSubmit)) config.hooks.UserPromptSubmit = [];

  // Self-heal (#1466): rewrite an installer-written command to this
  // platform's spelling in place — a config carried across platforms
  // can hold the other form. Only the exact installer spellings
  // migrate; hand-edited variants are the user's own and stay.
  let migrated = false;
  for (const group of config.hooks.UserPromptSubmit) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (h && PROMPT_HOOK_FORMS.includes(h.command) && h.command !== PROMPT_HOOK_COMMAND) {
        h.command = PROMPT_HOOK_COMMAND;
        migrated = true;
      }
    }
  }

  const already = config.hooks.UserPromptSubmit.some(
    (g: any) => g && Array.isArray(g.hooks) && g.hooks.some((h: any) => isPromptHookCommand(h?.command)),
  );
  if (already) {
    if (!migrated) return { path: file, action: 'unchanged' };
    writeJsonFile(file, config);
    return { path: file, action: 'updated' };
  }

  config.hooks.UserPromptSubmit.push({
    matcher: '',
    hooks: [{ type: 'command', command: PROMPT_HOOK_COMMAND }],
  });
  writeJsonFile(file, config);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Strip the marker-delimited SleuthGraph block from AGENTS.md if a
 * prior install wrote one — see claude.ts's removeInstructionsEntry.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, SLEUTH_SECTION_START, SLEUTH_SECTION_END);
  return { path: file, action };
}

export const devinTarget: AgentTarget = new DevinTarget();
