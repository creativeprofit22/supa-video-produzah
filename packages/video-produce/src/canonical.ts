/*
 * Canonical serialization and hashing for first-cut artifacts. Object keys are
 * sorted recursively so equal values always produce identical bytes.
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function canonicalValue(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => canonicalValue(item));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const result: Record<string, Json> = {};
    for (const [key, item] of entries) result[key] = canonicalValue(item);
    return result;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Synchronous, non-cryptographic 64-bit FNV-1a used only for readable stable ids. */
export function stableShortHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
