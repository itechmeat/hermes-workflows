/** Shared cell formatters for the dashboard tables. */

const DASH = "—";

/** Hermes timestamps are epoch seconds; render a readable local string or a dash. */
export function formatEpochSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return new Date(value * 1000).toLocaleString();
}

/** Render a string-or-null cell value, falling back to a dash. */
export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? DASH : value;
}

/** ISO timestamp → readable local string; a dash when unset, the raw value if
 *  it does not parse. Used for cron last/next-run columns. */
export function formatIso(value: string | null | undefined): string {
  if (!value) return DASH;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleString();
}
