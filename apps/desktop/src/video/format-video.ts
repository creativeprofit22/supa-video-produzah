import type { MediaProbe, RationalRate } from "@supa-video/contracts";

export function formatDuration(microseconds: number): string {
  const totalSeconds = Math.round(microseconds / 1_000_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatFileSize(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: megabytes < 10 ? 1 : 0 }).format(megabytes)} MB`;
}

export function formatFrameRate(rate: RationalRate): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(
    rate.numerator / rate.denominator,
  );
}

export function formatProjectName(path: string | null, fallback: string): string {
  if (path === null) {
    return fallback;
  }
  const name = path
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.svpvideo$/i, "")
    .trim();
  return name === undefined || name.length === 0 ? fallback : name;
}

export function mediaSummary(probe: MediaProbe): string {
  return `${probe.width} × ${probe.height}, ${formatFrameRate(probe.averageFrameRate)} fps, ${formatDuration(probe.durationMicroseconds)}`;
}
