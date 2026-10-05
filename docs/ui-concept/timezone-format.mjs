const timestampPrefix = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\](.*)$/;
const formatterCache = new Map();

/** Convert an ISO timestamp at the beginning of a log line to a user's chosen zone. */
export function formatTimestampedLogLine(line, timeZone, locale) {
  const match = String(line).match(timestampPrefix);
  if (!match) {
    return String(line);
  }

  const date = new Date(match[1]);
  if (Number.isNaN(date.getTime())) {
    return String(line);
  }

  const key = `${locale || ""}|${timeZone || ""}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hourCycle: "h23",
        timeZoneName: "short",
        ...(timeZone ? { timeZone } : {}),
      });
    } catch {
      return String(line);
    }
    formatterCache.set(key, formatter);
  }

  return `[${formatter.format(date)}]${match[2]}`;
}
