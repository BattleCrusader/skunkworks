/**
 * `test/helpers/full-disk.ts` — a real filesystem with no space left (S4c).
 *
 * The export's disk refusal has two halves and both need a filesystem that actually says
 * `ENOSPC`; a mocked `writeFileSync` would prove the catch block and nothing about the
 * kernel. macOS can create and mount a small disk image without privileges
 * (`hdiutil create -size … -fs HFS+`), which is the only unprivileged POSIX way to get one.
 *
 * On a platform that cannot do that, this **throws** rather than skipping: a skip is a
 * failure in this repository (`E-15`), and a green gate that quietly did not run the
 * refusal is the exact failure mode the S4c report exists to avoid.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, statfsSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SmallVolume {
  /** The mount point — a directory on a filesystem with `sizeMb` of total space. */
  root: string;
  freeBytes(): number;
  detach(): void;
}

export function makeSmallVolume(sizeMb = 1): SmallVolume {
  if (process.platform !== 'darwin') {
    throw new Error(
      `a full-disk gate needs an unprivileged small filesystem; this platform is ${process.platform} ` +
        '(darwin: hdiutil disk image). Provide a tmpfs mount or run this gate on macOS — a skip is a failure (E-15).',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'skw-dmg-'));
  const image = join(dir, 'volume.dmg');
  execFileSync('hdiutil', ['create', '-size', `${sizeMb}m`, '-fs', 'HFS+', '-volname', 'skwfull', image, '-quiet']);
  const attach = execFileSync('hdiutil', ['attach', image, '-nobrowse'], { encoding: 'utf8' });
  const mount = /(\/Volumes\/[^\s]+)/.exec(attach)?.[1];
  if (mount === undefined) throw new Error(`hdiutil attach named no mount point:\n${attach}`);
  if (!existsSync(mount)) throw new Error(`hdiutil mounted nothing at ${mount}`);

  return {
    root: mount,
    freeBytes(): number {
      // `statfs(2)` in-process, not `df(1)`: `fillUntil` probes after every 4 KiB write, and a
      // `df` fork per probe cost this file 24 s of its 34 s runtime (measured 2026-10-21, load
      // 8.94). The number is the same `bavail × bsize` df prints.
      const stats = statfsSync(mount);
      return Number(stats.bavail) * Number(stats.bsize);
    },
    detach(): void {
      try {
        execFileSync('hdiutil', ['detach', mount, '-quiet']);
      } catch {
        /* already gone */
      }
      rmSync(image, { force: true });
      // The mount is gone; its scratch directory is not. 288 of these had accumulated on the
      // dev box from earlier runs — a leak the detach path itself created.
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Fill a volume until `df` reports at most `leaveBytes` free. Returns the bytes written. */
export function fillUntil(volume: SmallVolume, leaveBytes: number): number {
  const chunk = Buffer.alloc(4096, 0x61);
  let written = 0;
  const fd = openSync(join(volume.root, 'filler.bin'), 'w');
  try {
    while (volume.freeBytes() > leaveBytes) {
      writeSync(fd, chunk);
      written += chunk.byteLength;
      if (written > 8 * 1024 * 1024) break;
    }
  } finally {
    closeSync(fd);
  }
  return written;
}
