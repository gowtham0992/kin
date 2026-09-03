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

export function calendarDayBounds(date: string, timeZone: string): {
  startsAt: string;
  endsAt: string;
} {
  validateTimeZone(timeZone);
  const startsAt = localMidnight(date, timeZone);
  const endsAt = localMidnight(shiftCalendarDate(date, 1), timeZone);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

function localMidnight(date: string, timeZone: string): Date {
  shiftCalendarDate(date, 0);
  let candidate = Date.parse(`${date}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const desired = Date.parse(`${date}T00:00:00.000Z`);
    const adjustment = desired - represented;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const result = new Date(candidate);
  const local = Object.fromEntries(
    formatter.formatToParts(result).map((part) => [part.type, part.value]),
  );
  if (
    `${local.year}-${local.month}-${local.day}` !== date ||
    local.hour !== "00" ||
    local.minute !== "00"
  ) {
    throw new Error("Could not resolve local calendar-day boundary");
  }
  return result;
}
