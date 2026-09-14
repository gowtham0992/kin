/** Speak the configured circle's clock, never the Lambda host's local zone. */
export function createEchoTimeFormatter(timeZone = "UTC") {
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
  });
  const calendar = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  const namedDate = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
  function day(value: number) {
    const parts = Object.fromEntries(calendar.formatToParts(value).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  }
  return (dueAt: string, now: number): string => {
    const due = Date.parse(dueAt);
    if (!Number.isFinite(due) || !Number.isFinite(now)) throw new Error("Invalid check-in time.");
    // Compare calendar days, not elapsed 24-hour periods across DST changes.
    const difference = (day(due) - day(now)) / 86_400_000;
    const date = difference === 0 ? "today" : difference === 1 ? "tomorrow" : namedDate.format(due);
    return `${date} at ${clock.format(due)}`.replace(/\s+/g, " ");
  };
}
