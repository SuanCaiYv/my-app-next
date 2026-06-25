export function formatDateTimeText(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseDateTimeText(value: string) {
  const normalized = value
    .trim()
    .replace(/[年月]/g, "-")
    .replace(/日/g, " ")
    .replace(/[./]/g, "-")
    .replace(/T/g, " ")
    .replace(/\s+/g, " ");
  const parts = normalized.match(/\d+/g)?.map(Number) || [];
  if (parts.length < 1) return null;
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = parts;
  if (
    year < 1000
    || month < 1
    || month > 12
    || day < 1
    || day > 31
    || hour > 23
    || minute > 59
    || second > 59
  ) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return date;
}
