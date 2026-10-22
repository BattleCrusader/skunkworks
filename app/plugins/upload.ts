/**
 * Uploading a plugin package through the admin, rather than a shell.
 *
 * `skwctl plugin install <dir>` needs three things beside the package: a test report bound to
 * the package root, a runner-image digest the report must agree with, and — for a package with
 * no publisher signature — the loud `--allow-unsigned` flag. An uploaded archive carries the
 * first of those inside itself (`test-report.json` at the package root, which is what
 * `plugin pack` writes) and cannot carry the other two, because they are statements about the
 * machine doing the install rather than about the package.
 *
 * So the shape of an upload is:
 *
 *  1. **Unpack into a scratch directory**, strictly (`archive.ts`): no absolute paths, no
 *     `..`, no symlinks, size caps. Nothing is installed by unpacking.
 *  2. **Find the package root** — the directory with `plugin.json` — and refuse when there is
 *     none or more than one.
 *  3. **Read the test report the archive carries** and take *its* claim of the image it ran in.
 *     This is self-attestation and the honest word for it: the box did not run those tests.
 *     Both the screen and the audit row say so. A package with no report is refused by
 *     `installPlugin` itself, not by a cheaper rule here.
 *  4. **Signature.** A `plugin.sig.json` at the package root is verified exactly as the CLI
 *     verifies a `--signature` file. Absent, `allowUnsigned` must be set — the same loud flag the
 *     CLI takes, from the same operator, on the same screen that already has Enable and
 *     Uninstall. Without it `installPlugin` refuses `SKW_E_PL_SIGNATURE`.
 *  5. **Install**, and remove the scratch directory whether it worked or not.
 *
 * The one thing this does **not** do is enable. Enable stays a separate press, because the
 * install screen is what an operator is meant to read first (`screen` in the result), and a
 * package that starts running in the same request that accepted its bytes is a screen with no
 * reader.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { uploadScratchDir, unpackArchive, archiveSha256, removeScratchDir } from './archive.ts';
import { installPlugin, type InstallResult } from './install.ts';

export interface UploadRequest {
  /** The `.tar.gz` the operator uploaded. */
  archive: Buffer;
  /** The file name, for the audit line and for a refusal that names what was refused. */
  filename?: string;
  siteDb: string;
  pluginsRoot: string;
  trustDir?: string;
  /** The operator's acknowledgement that an unsigned package runs uncontained. */
  allowUnsigned: boolean;
  firstPartyKeys?: string[];
  now?: string;
}

export interface UploadResult extends InstallResult {
  /** sha256 of the uploaded archive itself — what an operator can compare with a publisher's note. */
  archive_sha256: string;
  /** How the report inside the archive was obtained. Always `self-attested` today. */
  test_report_source: 'self-attested';
  /** The image the report claims the tests ran in. */
  test_report_image: string;
  files: number;
  bytes: number;
}

/** `plugin.sig.json` at the package root, or `undefined` — the same file `skwctl` takes by path. */
function signatureAt(root: string): string | undefined {
  const path = join(root, 'plugin.sig.json');
  return existsSync(path) ? path : undefined;
}

export function installFromArchive(req: UploadRequest): UploadResult {
  const scratch = uploadScratchDir();
  try {
    const { root, reportPath, files, bytes } = unpackArchive(req.archive, scratch);
    let image = '';
    if (existsSync(reportPath)) {
      // The report is `installPlugin`'s business to validate — it re-reads it and refuses a
      // root hash that no longer matches. Here we only need the digest it claims, so the two
      // checks agree by construction instead of by hope.
      // A report that is not JSON is `installPlugin`'s refusal to make (SKW_E_PL_TESTS_STALE,
      // with the file's path in the detail). Here an unreadable claim is simply no claim.
      try {
        const claim = JSON.parse(readFileSync(reportPath, 'utf8')) as { runner_image_digest?: unknown };
        image = typeof claim.runner_image_digest === 'string' ? claim.runner_image_digest : '';
      } catch {
        image = '';
      }
    }
    const signaturePath = signatureAt(root);
    const result = installPlugin({
      siteDb: req.siteDb,
      pluginsRoot: req.pluginsRoot,
      sourceDir: root,
      allowUnsigned: req.allowUnsigned,
      testReportPath: reportPath,
      runnerImageDigest: image,
      ...(signaturePath === undefined ? {} : { signaturePath }),
      ...(req.trustDir === undefined ? {} : { trustDir: req.trustDir }),
      ...(req.firstPartyKeys === undefined ? {} : { firstPartyKeys: req.firstPartyKeys }),
      ...(req.now === undefined ? {} : { now: req.now }),
      enable: false,
    });
    return {
      ...result,
      archive_sha256: archiveSha256(req.archive),
      test_report_source: 'self-attested',
      test_report_image: image,
      files,
      bytes,
    };
  } finally {
    removeScratchDir(scratch);
  }
}
