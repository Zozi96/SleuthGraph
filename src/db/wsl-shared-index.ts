/**
 * Windows + WSL sharing one index on a Windows drive (issue #995).
 *
 * A repo under `/mnt/<drive>/` can be used from both sides: Windows-native
 * SleuthGraph and WSL SleuthGraph then open the same `.sleuth/sleuth.db`
 * across the 9p/DrvFs bridge, where SQLite's file locking and its `-shm`
 * shared memory don't hold between the two OSes. WSL's connection fails with a
 * bare "disk I/O error" (SQLITE_IOERR). A private WSL index on the same drive
 * works fine, so a fresh WSL project there already gets its own
 * `.sleuth-wsl` (`sleuthGraphDirNameFor`). An index already in `.sleuth` —
 * built by Windows first, or by WSL before that default — is kept as it is,
 * and when it fails this way the SQLite adapter rewrites the error into the
 * `SLEUTH_DIR=.sleuth-wsl` instruction instead of letting it reach the
 * user as an unexplained I/O failure.
 */

import * as path from 'path';
import { DEFAULT_SLEUTH_DIR, WSL_SLEUTH_DIR } from '../directory';
import { isWindowsDriveMount, isWslWindowsDrive } from '../sync/watch-policy';

/** SQLite's primary result code for an I/O failure; extended codes keep it in the low byte. */
const SQLITE_IOERR = 10;

/**
 * Is `err` a SQLite I/O error? node:sqlite reports the EXTENDED result code on
 * `errcode` (SQLITE_IOERR_LOCK = 3850, SQLITE_IOERR_SHMMAP = 5130, ...), whose
 * low byte is the primary code. An error without one (re-wrapped somewhere
 * along the way) is matched by SQLite's message for the whole family.
 */
export function isSqliteIoError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { errcode, message } = err as { errcode?: unknown; message?: unknown };
  if (typeof errcode === 'number') return (errcode & 0xff) === SQLITE_IOERR;
  return typeof message === 'string' && /disk I\/O error/i.test(message);
}

/**
 * A SQLite I/O error on an index that Windows SleuthGraph most likely shares.
 * Keeps the original as `cause` and carries its SQLite codes, so a caller that
 * branches on them sees the same values as before the rewrite.
 */
export class WslSharedIndexError extends Error {
  readonly code: unknown;
  readonly errcode: unknown;
  readonly errstr: unknown;

  constructor(original: Error, dataDir: string) {
    super(
      `${original.message} on the SleuthGraph index at ${dataDir}\n` +
        "This project is on a Windows drive, where SQLite's file locking doesn't work across " +
        'the Windows/WSL boundary, so this usually means SleuthGraph on Windows is using the same ' +
        "index. Windows and WSL can't share one index on a Windows drive; give WSL its own:\n" +
        `  1. Set SLEUTH_DIR=${WSL_SLEUTH_DIR} in the WSL environment (your shell profile, ` +
        'or the env of the MCP server your agent starts).\n' +
        `  2. Run "sleuth init" in WSL to build that index. Windows keeps using ${DEFAULT_SLEUTH_DIR}.`,
      { cause: original }
    );
    this.name = 'WslSharedIndexError';
    const codes = original as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
    this.code = codes.code;
    this.errcode = codes.errcode;
    this.errstr = codes.errstr;
  }
}

/**
 * Inputs that can be overridden in tests so the decision is deterministic
 * without touching `/proc/version` (see `WatchProbe`).
 */
export interface WslSharedIndexProbe {
  /** Defaults to `detectWsl()` (through `isWslWindowsDrive`). */
  isWsl?: boolean;
}

/**
 * The error to throw in place of `err`: a {@link WslSharedIndexError} when a
 * SQLite I/O error hit the default-named index of a project on a Windows drive
 * under WSL, else `null` (throw `err` unchanged).
 *
 * Only the default `.sleuth` counts: it is the directory Windows SleuthGraph
 * opens too. A WSL that already has its own directory (`.sleuth-wsl`, or
 * any `SLEUTH_DIR`) hit some other I/O failure, and pointing it at
 * `SLEUTH_DIR` would mislead.
 */
export function toWslSharedIndexError(
  err: unknown,
  dbPath: string,
  probe: WslSharedIndexProbe = {}
): WslSharedIndexError | null {
  if (err instanceof WslSharedIndexError) return err;
  if (!(err instanceof Error) || !isSqliteIoError(err)) return null;
  const dataDir = path.dirname(dbPath);
  if (path.basename(dataDir) !== DEFAULT_SLEUTH_DIR) return null;
  const onWslWindowsDrive = probe.isWsl === undefined
    ? isWslWindowsDrive(dbPath)
    : probe.isWsl && isWindowsDriveMount(dbPath);
  return onWslWindowsDrive ? new WslSharedIndexError(err, dataDir) : null;
}
