/**
 * Telemetry opt-out across running instances — DISABLED in SleuthGraph.
 *
 * The upstream suite pinned cross-instance consent propagation. In this fork
 * telemetry is always off, so the contract is simpler: no instance, env var,
 * or stored choice can ever turn recording, persistence, or sending back on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Telemetry } from '../src/telemetry';

describe('telemetry disabled across instances', () => {
  let dir: string;
  let now: Date;
  let sends: any[];
  const make = (env = {}, fetchImpl: typeof fetch = async (_url, init) => {
    sends.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) => new Telemetry({ dir, env, fetchImpl, now: () => now, stderr: () => {}, installExitHook: false });
  const telemetryFiles = () => fs.readdirSync(dir).filter(n => n.startsWith('telemetry'));
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-telemetry-off-')); now = new Date('2026-06-12T08:00:00Z'); sends = []; });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('setEnabled on one instance never enables another', async () => {
    const a = make();
    make().setEnabled(true, 'cli');
    expect(a.isEnabled()).toBe(false);
    a.recordLifecycle('install', {});
    a.recordUsage('mcp_tool', 'sleuth_explore', true);
    a.persistSync();
    await a.flushNow();
    expect(sends).toEqual([]);
    expect(telemetryFiles()).toEqual([]);
  });

  it.each(['DO_NOT_TRACK', 'SLEUTH_TELEMETRY'])('an env var cannot revive recording or sending: %s', async key => {
    const a = make({ [key]: key === 'DO_NOT_TRACK' ? '0' : '1' });
    a.setEnabled(true, 'cli');
    a.recordLifecycle('install', {});
    await a.flushNow();
    a.persistSync();
    expect(sends).toEqual([]);
    expect(telemetryFiles()).toEqual([]);
  });

  it('startInterval never flushes, even after an opt-in attempt', async () => {
    vi.useFakeTimers();
    const a = make();
    a.setEnabled(true, 'cli');
    a.recordUsage('cli_command', 'query', true);
    a.startInterval();
    try {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
      expect(sends).toEqual([]);
      expect(telemetryFiles()).toEqual([]);
    } finally {
      a.stopInterval();
    }
  });
});
