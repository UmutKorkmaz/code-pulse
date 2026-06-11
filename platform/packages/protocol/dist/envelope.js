"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROTOCOL_VERSION = exports.MAX_FRAME_BYTES = exports.ENVELOPE_VERSION = void 0;
/** Current envelope wire format version. Bump on breaking envelope changes. */
exports.ENVELOPE_VERSION = 1;
/** Maximum accepted frame size at the daemon ingest boundary (256 KiB). */
exports.MAX_FRAME_BYTES = 256 * 1024;
/** Protocol version string referenced by scanner manifests (`minProtocol`). */
exports.PROTOCOL_VERSION = '5.1';
//# sourceMappingURL=envelope.js.map