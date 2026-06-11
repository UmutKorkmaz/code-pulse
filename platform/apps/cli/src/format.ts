export function printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

export function printTable(headers: string[], rows: string[][]): void {
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map(row => (row[index] ?? '').length))
    );

    const line = widths.map(width => '-'.repeat(width)).join('  ');

    console.log(widths.map((width, index) => headers[index].padEnd(width)).join('  '));
    console.log(line);

    for (const row of rows) {
        console.log(widths.map((width, index) => (row[index] ?? '').padEnd(width)).join('  '));
    }
}