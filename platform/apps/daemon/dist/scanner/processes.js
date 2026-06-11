"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listProcessNames = listProcessNames;
exports.listProcessEntries = listProcessEntries;
exports.parseProcessTable = parseProcessTable;
exports.parseEtimeSeconds = parseEtimeSeconds;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
/**
 * List running process command names (comm) for scanner matching.
 */
async function listProcessNames() {
    try {
        const { stdout } = await execFileAsync('ps', ['-eo', 'comm='], {
            maxBuffer: 8 * 1024 * 1024
        });
        return stdout
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
/**
 * Lists running processes with pid + uptime via `ps -eo pid=,etime=,comm=`.
 * Returns [] on failure (mirrors listProcessNames) so a transient ps error
 * never throws into the poll loop.
 */
async function listProcessEntries() {
    try {
        const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,etime=,comm='], {
            maxBuffer: 8 * 1024 * 1024
        });
        return parseProcessTable(stdout);
    }
    catch {
        return [];
    }
}
/**
 * Parses `ps -eo pid=,etime=,comm=` output. pid and etime are single
 * whitespace-delimited columns; everything after them is the comm (which may
 * itself contain spaces). Malformed lines are skipped.
 */
function parseProcessTable(stdout) {
    const entries = [];
    for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) {
            continue;
        }
        const pid = Number.parseInt(match[1], 10);
        const comm = match[3].trim();
        if (!Number.isFinite(pid) || !comm) {
            continue;
        }
        entries.push({ pid, comm, etimeSeconds: parseEtimeSeconds(match[2]) });
    }
    return entries;
}
/**
 * Parses a ps `etime` value — `[[dd-]hh:]mm:ss` (e.g. "05:30", "1:02:03",
 * "2-11:30:00") — into seconds. Unparseable input yields 0 so a weird etime
 * degrades to "started just now" instead of poisoning the poll.
 */
function parseEtimeSeconds(etime) {
    const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.\d+)?$/);
    if (!match) {
        return 0;
    }
    const [, days, hours, minutes, seconds] = match;
    return ((days ? Number.parseInt(days, 10) * SECONDS_PER_DAY : 0) +
        (hours ? Number.parseInt(hours, 10) * SECONDS_PER_HOUR : 0) +
        Number.parseInt(minutes, 10) * SECONDS_PER_MINUTE +
        Number.parseInt(seconds, 10));
}
//# sourceMappingURL=processes.js.map