/**
 * Anonymous usage telemetry — DISABLED in the SleuthGraph fork.
 *
 * Pins the fork's contract: the API surface is preserved so callers compile,
 * but telemetry is always off — nothing is recorded, nothing is persisted,
 * and no socket is ever opened.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Telemetry, getTelemetry } from '../src/telemetry';

type FetchCall = { url: string; body: Record<string, unknown> };

function mockFetch(calls: FetchCall[], opts: { fail?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.fail) throw new Error('network down');
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
}

describe('Telemetry (disabled in SleuthGraph)', () => {
  let dir: string;
  let calls: FetchCall[];
  let stderrLines: string[];
  let nowValue: Date;

  const make = (overrides: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) =>
    new Telemetry({
      dir,
      fetchImpl: mockFetch(calls),
      now: () => nowValue,
      env: {},
      stderr: (line) => stderrLines.push(line),
      installExitHook: false,
      ...overrides,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-telemetry-'));
    calls = [];
    stderrLines = [];
    nowValue = new Date('2026-06-12T08:00:00.000Z');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('always disabled', () => {
    it('isEnabled() is false and status reports disabled by default', () => {
      const t = make();
      expect(t.isEnabled()).toBe(false);
      expect(t.getStatus()).toMatchObject({ enabled: false, decidedBy: 'default', machineId: null });
    });

    it('no env var can turn it on', () => {
      for (const env of [
        { CODEGRAPH_TELEMETRY: '1' },
        { CODEGRAPH_TELEMETRY: 'true' },
        { DO_NOT_TRACK: '0' },
        {},
      ]) {
        expect(make({ env }).isEnabled()).toBe(false);
      }
    });

    it('setEnabled persists nothing and cannot turn it on', () => {
      const t = make();
      t.setEnabled(true, 'cli');
      t.setEnabled(true, 'installer');
      expect(t.isEnabled()).toBe(false);
      expect(fs.existsSync(t.configPath)).toBe(false);
      expect(t.hasStoredChoice()).toBe(false);
    });
  });

  describe('off is off', () => {
    it('records nothing, sends nothing, creates no files', async () => {
      const fetchSpy = mockFetch(calls);
      const t = make({ fetchImpl: fetchSpy });
      t.recordUsage('mcp_tool', 'codegraph_explore', true);
      t.recordUsage('cli_command', 'init', true, { name: 'Claude Code', version: '2.1' });
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      t.persistSync();
      t.maybeFlush();
      await t.flushNow();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(t.configPath)).toBe(false);
      expect(fs.existsSync(t.queuePath)).toBe(false);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('telemetry'))).toEqual([]);
      expect(stderrLines).toEqual([]);
    });

    it('a pre-existing queue file is never sent or touched', async () => {
      const t = make();
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ v: 2, d: '2026-06-11', k: 'cli_command', n: 'serve', c: 1, e: 0 });
      fs.writeFileSync(t.queuePath, `${line}\n`);
      await t.flushNow();
      t.persistSync();
      expect(calls).toHaveLength(0);
      expect(fs.readFileSync(t.queuePath, 'utf8')).toBe(`${line}\n`);
    });

    it('flushNow resolves even when the injected fetch would fail', async () => {
      const t = make({ fetchImpl: mockFetch(calls, { fail: true }) });
      await expect(t.flushNow()).resolves.toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it('startInterval never schedules sends', async () => {
      vi.useFakeTimers();
      const t = make();
      t.startInterval(1000);
      await vi.advanceTimersByTimeAsync(10_000);
      t.stopInterval();
      vi.useRealTimers();
      expect(calls).toHaveLength(0);
    });
  });

  describe('protocol safety', () => {
    it('never writes to stdout', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write');
      const t = make({ env: { CODEGRAPH_TELEMETRY_DEBUG: '1' } });
      t.recordUsage('mcp_tool', 'codegraph_explore', true);
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      await t.flushNow();
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });
  });

  it('getTelemetry returns a process-wide singleton', () => {
    expect(getTelemetry()).toBe(getTelemetry());
    expect(getTelemetry().isEnabled()).toBe(false);
  });
});
