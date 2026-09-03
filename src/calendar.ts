export function calendarDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) {
    throw new Error("Could not resolve calendar date");
  }
  return `${values.year}-${values.month}-${values.day}`;
}

export function validateTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    throw new Error("KIN_TIME_ZONE must be a valid IANA time zone");
  }
}

export function shiftCalendarDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isInteger(days) ||
    !Number.isFinite(value.getTime()) ||
    value.toISOString().slice(0, 10) !== date
  ) {
    throw new Error("A valid calendar date and whole-day offset are required");
  }
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
