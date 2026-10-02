/*
 * Movement smoothness from a speed profile. Ported from diffusion-studio-2
 * `checker/smoothness-metrics.ts` (commit eb91afe), itself a port of siva82kb/SPARC
 * `scripts/smoothness.py` (commit 3650934): `sparc()` (spectral arc length,
 * Balasubramanian et al. 2015) and `log_dimensionless_jerk()`. Both are ≤ 0; closer to
 * 0 = smoother. Inputs are speeds sampled at `fs` Hz.
 *
 * Changes from the source, none of which alter results: maxima are taken with a loop instead
 * of `Math.max(...xs)`, which throws a RangeError on the 2^20-bin spectra a 36 000-frame move
 * can produce; and the FFT computes each stage's twiddle factors once (same `cos(ang * k)`
 * values) instead of once per butterfly, which dominated the cost of long moves.
 */

function maxOf(values: ArrayLike<number>, map: (value: number) => number = (v) => v): number {
  let peak = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = map(values[i] ?? 0);
    if (value > peak || Number.isNaN(value)) peak = value;
  }
  return peak;
}

/** Magnitude spectrum via an iterative radix-2 FFT, zero-padded/truncated to `n` (a power of two). */
export function fftMagnitude(signal: readonly number[], n: number): number[] {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < Math.min(n, signal.length); i++) re[i] = signal[i] ?? 0;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = r;
      const m = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = m;
    }
  }
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const half = len / 2;
    for (let k = 0; k < half; k++) {
      cos[k] = Math.cos(ang * k);
      sin[k] = Math.sin(ang * k);
    }
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k] ?? 0;
        const wi = sin[k] ?? 0;
        const a = i + k;
        const b = a + half;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const ar = re[a] ?? 0;
        const ai = im[a] ?? 0;
        const xr = br * wr - bi * wi;
        const xi = br * wi + bi * wr;
        re[b] = ar - xr;
        im[b] = ai - xi;
        re[a] = ar + xr;
        im[a] = ai + xi;
      }
    }
  }
  const magnitude = new Array<number>(n);
  for (let i = 0; i < n; i++) magnitude[i] = Math.hypot(re[i] ?? 0, im[i] ?? 0);
  return magnitude;
}

/**
 * Spectral arc length (SPARC) of a speed profile. Defaults as in the reference: zero-padding level 4,
 * cut-off 10 Hz, amplitude threshold 0.05. A single-sample or all-zero profile returns 0.
 */
export function sparc(
  speed: readonly number[],
  fs: number,
  padlevel = 4,
  fc = 10,
  ampTh = 0.05,
): number {
  if (speed.length < 2) return 0;
  const nfft = 2 ** (Math.ceil(Math.log2(speed.length)) + padlevel);
  const mag = fftMagnitude(speed, nfft);
  const peak = maxOf(mag);
  if (!(peak > 0)) return 0;
  const f: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < nfft; i++) {
    const fi = (i * fs) / nfft;
    if (fi > fc) break;
    f.push(fi);
    m.push((mag[i] ?? 0) / peak);
  }
  const above = m.flatMap((v, i) => (v >= ampTh ? [i] : []));
  const lo = above[0] ?? 0;
  const hi = above[above.length - 1] ?? 0;
  const span = (f[hi] ?? 0) - (f[lo] ?? 0);
  if (!(span > 0)) return 0;
  let arc = 0;
  for (let i = lo + 1; i <= hi; i++) {
    arc += Math.hypot(((f[i] ?? 0) - (f[i - 1] ?? 0)) / span, (m[i] ?? 0) - (m[i - 1] ?? 0));
  }
  return -arc;
}

/** Dimensionless jerk of a speed profile (reference `dimensionless_jerk`). */
export function dimensionlessJerk(speed: readonly number[], fs: number): number {
  const peak = maxOf(speed, Math.abs);
  if (speed.length < 3 || !(peak > 0)) return 0;
  const dt = 1 / fs;
  const dur = speed.length * dt;
  let sum = 0;
  for (let i = 2; i < speed.length; i++) {
    const jerk = ((speed[i] ?? 0) - 2 * (speed[i - 1] ?? 0) + (speed[i - 2] ?? 0)) / dt ** 2;
    sum += jerk ** 2;
  }
  return -((dur ** 3 / peak ** 2) * sum * dt);
}

/** Log dimensionless jerk (reference `log_dimensionless_jerk`): −ln|DJ|. */
export function logDimensionlessJerk(speed: readonly number[], fs: number): number {
  const dj = Math.abs(dimensionlessJerk(speed, fs));
  return dj > 0 ? -Math.log(dj) : 0;
}

/**
 * Pass thresholds, calibrated at 25 fps on 8–100 frame moves in diffusion-studio-2 and re-checked
 * at 24/30/60 fps in smoothness-metrics.test.ts: minimum-jerk, easeInOut, inOutCubic and the
 * `gentle` spring score SPARC −1.1…−1.51 and LDLJ −5…−10.5; linear start/stop scores SPARC
 * −2.2…−2.5, a two-step stutter −2.2; frame-rate jitter (above SPARC's 10 Hz cut-off) scores
 * LDLJ ≤ −12 once the move lasts 1 s or more. Kept as-is across rates: the tightest margin is
 * smooth-ease LDLJ at 60 fps (worst −11.29), whose rest-frame step grows with the rate.
 */
export const SPARC_MIN = -1.8;
export const LDLJ_MIN = -11.5;

/** A move's speed profile with the resting frame before and after it (speed 0), as measured. */
export const withRest = (speed: readonly number[]): number[] => [0, ...speed, 0];
