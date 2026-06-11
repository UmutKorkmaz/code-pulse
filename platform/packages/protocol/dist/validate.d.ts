import { type AnyEnvelope, type DaemonEvent, type Evidence, type FileChangeMeta, type TokenUsage } from './envelope';
import { type ScannerManifest } from './scanner-manifest';
export interface ValidationSuccess<T> {
    ok: true;
    value: T;
}
export interface ValidationFailure {
    ok: false;
    errors: string[];
}
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;
export declare function validateEvidence(input: unknown, path?: string): ValidationResult<Evidence>;
export declare function validateTokenUsage(input: unknown, path?: string): ValidationResult<TokenUsage>;
export declare function validateFileChangeMeta(input: unknown, path?: string): ValidationResult<FileChangeMeta>;
export declare function validateDaemonEvent(input: unknown, path?: string): ValidationResult<DaemonEvent>;
export declare function validateEnvelope(input: unknown): ValidationResult<AnyEnvelope>;
/** Reject frames larger than the daemon ingest limit. */
export declare function validateFrameSize(byteLength: number): ValidationResult<number>;
export declare function validateScannerManifest(input: unknown): ValidationResult<ScannerManifest>;
//# sourceMappingURL=validate.d.ts.map