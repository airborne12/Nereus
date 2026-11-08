/** Reject dates and local times that Date would normalize to a different value. */
export function localTime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number | null {
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  d.setHours(hour, minute, second, 0);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day &&
    d.getHours() === hour && d.getMinutes() === minute && d.getSeconds() === second ? d.getTime() : null;
}

export function parseLocalTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim());
  return m ? localTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) : null;
}
