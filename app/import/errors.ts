/**
 * The refusals an import can raise.
 *
 * Named, like every other refusal in this codebase, and separate from the export's set: the exit
 * code an operator sees must say *which* half of the round trip refused. `exit: 2` is a usage
 * error (a flag that cannot mean anything); everything else is 1, because an import either
 * happened or it did not.
 */
export type ImportCode =
  | 'SKW_E_IMP_SOURCE_MISSING'
  | 'SKW_E_IMP_ARCHIVE_FORMAT'
  | 'SKW_E_IMP_ARCHIVE_FAILED'
  | 'SKW_E_IMP_ENTRY_UNSAFE'
  | 'SKW_E_IMP_MANIFEST_MISSING'
  | 'SKW_E_IMP_MANIFEST_INVALID'
  | 'SKW_E_IMP_FILE_MISSING'
  | 'SKW_E_IMP_HASH_MISMATCH'
  | 'SKW_E_IMP_SYMLINK_ESCAPE'
  | 'SKW_E_IMP_FORBIDDEN_PATH'
  | 'SKW_E_IMP_COUNT_MISMATCH'
  | 'SKW_E_IMP_TENANT_KEY_INVALID'
  | 'SKW_E_IMP_PLUGIN_PACKAGE'
  | 'SKW_E_IMP_TENANT_EXISTS'
  | 'SKW_E_IMP_HOST_TAKEN'
  | 'SKW_E_IMP_HOST_INVALID'
  | 'SKW_E_IMP_HOST_RESERVED'
  | 'SKW_E_IMP_PRIMARY_UNKNOWN'
  | 'SKW_E_IMP_WILDCARD_INVALID'
  | 'SKW_E_IMP_DB_MISSING'
  | 'SKW_E_IMP_SCHEMA_NEWER'
  | 'SKW_E_IMP_MIGRATION_FAILED'
  | 'SKW_E_IMP_CONTROL_FAILED'
  | 'SKW_E_IMP_INSUFFICIENT_DISK'
  | 'SKW_E_IMP_WRITE_FAILED'
  | 'SKW_E_IMP_USAGE';

export class ImportRefusal extends Error {
  readonly code: ImportCode;
  readonly detail: Record<string, unknown>;
  readonly exit: number;

  constructor(code: ImportCode, message: string, detail: Record<string, unknown> = {}, exit = 1) {
    super(message);
    this.name = 'ImportRefusal';
    this.code = code;
    this.detail = detail;
    this.exit = exit;
  }
}

/** Usage refusals are exit 2 so a shell can tell a bad flag from a bad bundle. */
export function usage(message: string): ImportRefusal {
  return new ImportRefusal('SKW_E_IMP_USAGE', message, {}, 2);
}

/**
 * The excluded tree, stated once (the same rule `tools/bundle_verify.mjs` enforces on the
 * receiving side): a render is never part of a bundle, and an importer that accepted one would
 * be the second door into a promise that has one.
 */
export const PROTECTED_PREFIX = 'content/protected';

export function isProtectedPath(path: string): boolean {
  return path === PROTECTED_PREFIX || path.startsWith(`${PROTECTED_PREFIX}/`);
}
