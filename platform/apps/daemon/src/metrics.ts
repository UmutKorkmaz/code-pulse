export class MetricsRegistry {
    private readonly counters = new Map<string, number>();
    private readonly gauges = new Map<string, number>();

    increment(name: string, value = 1): void {
        this.counters.set(name, (this.counters.get(name) ?? 0) + value);
    }

    setGauge(name: string, value: number): void {
        this.gauges.set(name, value);
    }

    renderPrometheus(): string {
        const lines: string[] = [];

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