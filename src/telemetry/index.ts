/**
 * Anonymous usage telemetry — DISABLED in the SleuthGraph fork.
 *
 * TODO(SleuthGraph): telemetry fully disabled — reimplement against our own
 * endpoint if desired.
 *
 * The upstream client sent anonymous usage stats to the upstream ingest
 * endpoint. This fork ships no telemetry: nothing is recorded, nothing is
 * persisted, and no socket is ever opened — off means off.
 *
 * The public API surface is preserved so every caller compiles unchanged;
 * every method below is a no-op.
 */

import * as path from 'path';
import * as os from 'os';

export type UsageKind = 'mcp_tool' | 'cli_command';
export type LifecycleEvent = 'install' | 'index' | 'uninstall';

/** Coarse buckets — kept as pure helpers; nothing consumes their output. */
export function bucketFileCount(n: number): '<100' | '100-1k' | '1k-10k' | '10k+' {
  if (n < 100) return '<100';
  if (n < 1000) return '100-1k';
  if (n < 10000) return '1k-10k';
  return '10k+';
}

export function bucketDuration(ms: number): '<10s' | '10-60s' | '1-5m' | '5m+' {
  if (ms < 10_000) return '<10s';
  if (ms < 60_000) return '10-60s';
  if (ms < 300_000) return '1-5m';
  return '5m+';
}

/**
 * Shared "a full index completed" event — a no-op: nothing is recorded or
 * sent. Kept so callers don't change.
 */
export function recordIndexEvent(
  cg: { getStats(): { filesByLanguage: Record<string, number> } },
  result: { filesIndexed: number; durationMs: number },
): void {
  try {
    const languages = Object.entries(cg.getStats().filesByLanguage)
      .filter(([, count]) => count > 0)
      .map(([lang]) => lang);
    getTelemetry().recordLifecycle('index', {
      languages,
      file_count_bucket: bucketFileCount(result.filesIndexed),
      duration_bucket: bucketDuration(result.durationMs),
    });
  } catch {
    /* telemetry must never break indexing */
  }
}

export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface TelemetryStatus {
  enabled: boolean;
  /** What decided the current state — always 'default' while telemetry is disabled. */
  decidedBy: 'DO_NOT_TRACK' | 'CODEGRAPH_TELEMETRY' | 'config' | 'default';
  machineId: string | null;
  configPath: string;
}

export interface TelemetryOptions {
  /** Global state dir; defaults to ~/.codegraph. Tests inject a temp dir. */
  dir?: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
  /** Tests opt out so short-lived instances don't pile onto process 'exit'. */
  installExitHook?: boolean;
}

export class Telemetry {
  private readonly dir: string;

  constructor(opts: TelemetryOptions = {}) {
    this.dir = opts.dir ?? path.join(os.homedir(), '.codegraph');
  }

  // ---------------------------------------------------------------- consent

  get configPath(): string {
    return path.join(this.dir, 'telemetry.json');
  }
  get queuePath(): string {
    return path.join(this.dir, 'telemetry-queue.jsonl');
  }

  /** Always disabled in this build — no env var or stored choice overrides it. */
  getStatus(): TelemetryStatus {
    return { enabled: false, decidedBy: 'default', machineId: null, configPath: this.configPath };
  }

  isEnabled(): boolean {
    return false;
  }

  /**
   * No-op: telemetry is disabled in this build, so there is nothing to
   * persist — no config file and no queue file are ever written.
   */
  setEnabled(_enabled: boolean, _source: 'installer' | 'cli'): void {
    // TODO(SleuthGraph): telemetry fully disabled — reimplement against our
    // own endpoint if desired.
  }

  /** Always false: no consent state is ever stored. */
  hasStoredChoice(): boolean {
    return false;
  }

  // -------------------------------------------------------------- recording

  recordUsage(_kind: UsageKind, _name: string, _ok: boolean, _client?: ClientInfo): void {
    /* no-op — telemetry disabled */
  }

  recordLifecycle(_event: LifecycleEvent, _props: Record<string, unknown>): void {
    /* no-op — telemetry disabled */
  }

  // ---------------------------------------------------------------- sending

  maybeFlush(): void {
    /* no-op — telemetry disabled */
  }

  async flushNow(_timeoutMs?: number): Promise<void> {
    /* no-op — telemetry disabled */
  }

  startInterval(_everyMs?: number): void {
    /* no-op — telemetry disabled */
  }

  stopInterval(): void {
    /* no-op — telemetry disabled */
  }

  // -------------------------------------------------------------- internals

  /** No-op: nothing is ever buffered, so there is nothing to persist. */
  persistSync(): void {
    /* no-op — telemetry disabled */
  }
}

// Process-wide singleton — app code goes through this; tests construct their own.
let singleton: Telemetry | null = null;

export function getTelemetry(): Telemetry {
  if (!singleton) singleton = new Telemetry();
  return singleton;
}
