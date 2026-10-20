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
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
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
  const image = join(mkdtempSync(join(tmpdir(), 'skw-dmg-')), 'volume.dmg');
  execFileSync('hdiutil', ['create', '-size', `${sizeMb}m`, '-fs', 'HFS+', '-volname', 'skwfull', image, '-quiet']);
  const attach = execFileSync('hdiutil', ['attach', image, '-nobrowse'], { encoding: 'utf8' });
  const mount = /(\/Volumes\/[^\s]+)/.exec(attach)?.[1];
  if (mount === undefined) throw new Error(`hdiutil attach named no mount point:\n${attach}`);
  if (!existsSync(mount)) throw new Error(`hdiutil mounted nothing at ${mount}`);

  return {
    root: mount,
    freeBytes(): number {
      const stats = execFileSync('df', ['-k', mount], { encoding: 'utf8' });
      const line = stats.trim().split('\n')[1] ?? '';
      const available = Number(line.split(/\s+/)[3] ?? '0');
      return available * 1024;
    },
    detach(): void {
      try {
        execFileSync('hdiutil', ['detach', mount, '-quiet']);
      } catch {
        /* already gone */
      }
      rmSync(image, { force: true });
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
