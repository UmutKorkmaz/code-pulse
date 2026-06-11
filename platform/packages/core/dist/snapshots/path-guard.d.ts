/**
 * Validates that a project root is safe to read from / write into.
 *
 * Fails closed (throws) unless the root is an absolute, existing directory that
 * is NOT the user home dir, the filesystem root, or a parent of home, and that
 * either contains a `.git` directory or is explicitly listed in the
 * colon-separated `CODEPULSE_ALLOWED_ROOTS` env var.
 *
 * Returns the canonical (realpath-resolved) absolute root.
 */
export declare function assertTrustedProjectRoot(projectRoot: string): string;
export declare function resolvePathWithinProject(projectRoot: string, filePath: string): string;
//# sourceMappingURL=path-guard.d.ts.map