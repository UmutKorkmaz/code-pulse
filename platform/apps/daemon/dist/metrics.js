"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetricsRegistry = void 0;
class MetricsRegistry {
    counters = new Map();
    gauges = new Map();
    increment(name, value = 1) {
        this.counters.set(name, (this.counters.get(name) ?? 0) + value);
    }
    setGauge(name, value) {
        this.gauges.set(name, value);
    }
    renderPrometheus() {
        const lines = [];
        for (const [name, value] of [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            lines.push(`# TYPE ${name} counter`);
            lines.push(`${name} ${value}`);
        }
        for (const [name, value] of [...this.gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            lines.push(`# TYPE ${name} gauge`);
            lines.push(`${name} ${value}`);
        }
        return `${lines.join('\n')}\n`;
    }
}
exports.MetricsRegistry = MetricsRegistry;
//# sourceMappingURL=metrics.js.map