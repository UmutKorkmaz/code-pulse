export function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function parseLocalDate(dateString: string): Date {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1, 0, 0, 0, 0);
}

export function startOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function endOfLocalDay(date: Date): Date {
    const start = startOfLocalDay(date);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return end;
}

export function getLocalDateBounds(dateString: string): { start: Date; end: Date } {
    const start = parseLocalDate(dateString);
    return {
        start,
        end: endOfLocalDay(start)
    };
}

export function eachLocalDate(startDate: Date, endDate: Date): string[] {
    const dates: string[] = [];
    const current = startOfLocalDay(startDate);
    const end = startOfLocalDay(endDate);

    while (current <= end) {
        dates.push(formatLocalDate(current));
        current.setDate(current.getDate() + 1);
    }

    return dates;
}
