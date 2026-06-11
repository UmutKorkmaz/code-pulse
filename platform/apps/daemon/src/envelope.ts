import { createHash, randomUUID } from 'crypto';
import {
    ENVELOPE_VERSION,
    type AnyEnvelope,
    type DaemonEvent
} from '@codepulse/protocol';

export function createDaemonEnvelope(
    payload: DaemonEvent,
    corr?: string,
    id?: string
): AnyEnvelope {
    return {
        v: ENVELOPE_VERSION,
        id: id ?? randomUUID(),
        ts: Date.now(),
        src: 'daemon',
        corr,
        type: payload.type,
        payload
    };
}

/**
 * Derives a stable, uuid-shaped envelope id from the given parts (e.g.
 * scannerId, filePath, line byte offset, lineHash, envelope type) so the
 * same physical log line always produces the same id — log replays then
 * dedup on the indexed envelope_id column instead of minting fresh random
 * ids. The byte offset part keeps byte-identical lines at different file
 * positions distinct (content alone would collide and undercount).
 */
export function deriveEnvelopeId(...parts: string[]): string {
    const digest = createHash('sha256').update(parts.join('\u001f')).digest('hex');
    return [
        digest.slice(0, 8),
        digest.slice(8, 12),
        digest.slice(12, 16),
        digest.slice(16, 20),
        digest.slice(20, 32)
    ].join('-');
}
