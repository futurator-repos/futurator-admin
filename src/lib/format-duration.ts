/**
 * Duration formatting helpers for Timer Intelligence UI.
 *
 * formatDuration(ms)  → "mm:ss" for < 1h, "h:mm:ss" otherwise.
 * formatMs(ms)        → compact short form e.g. "2m 14s", "38s", "1h 4m".
 */

/**
 * Format a duration in milliseconds to mm:ss (< 1h) or h:mm:ss (≥ 1h).
 * Always returns a stable, fixed-width string.
 *
 * @param ms - Duration in milliseconds (non-negative).
 */
export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Format a duration into a short human-readable string.
 * Examples: "38s", "2m 14s", "1h 4m".
 *
 * @param ms - Duration in milliseconds (non-negative).
 */
export function formatMs(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    if (minutes > 0) return `${hours}h ${minutes}m`;
    return `${hours}h`;
  }
  if (minutes > 0) {
    if (seconds > 0) return `${minutes}m ${seconds}s`;
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
