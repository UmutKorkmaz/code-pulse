"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDaemonEnvelope = createDaemonEnvelope;
exports.deriveEnvelopeId = deriveEnvelopeId;
const crypto_1 = require("crypto");
const protocol_1 = require("@codepulse/protocol");
function createDaemonEnvelope(payload, corr, id) {
    return {
        v: protocol_1.ENVELOPE_VERSION,
        id: id ?? (0, crypto_1.randomUUID)(),
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
function deriveEnvelopeId(...parts) {
    const digest = (0, crypto_1.createHash)('sha256').update(parts.join('\u001f')).digest('hex');
    return [
        digest.slice(0, 8),
        digest.slice(8, 12),
        digest.slice(12, 16),
        digest.slice(16, 20),
        digest.slice(20, 32)
    ].join('-');
}
//# sourceMappingURL=envelope.js.map