import type { LicenseCode, LicenseId, ProviderId } from "@supa-video/contracts";

/*
 * UI mirror of `src-tauri/src/rights/license.rs`. Rust is the authority; both
 * implementations are pinned to `fixtures/license-matrix-v1.json`.
 */

export interface LicenseInput {
  readonly providerId: ProviderId;
  readonly url: string | null;
  readonly name: string | null;
  readonly version: string | null;
}

const CC_VERSIONS: ReadonlySet<string> = new Set(["1.0", "2.0", "2.1", "2.5", "3.0", "4.0"]);
const CC_CODES: ReadonlyMap<string, LicenseCode> = new Map<string, LicenseCode>([
  ["by", "by"],
  ["by-sa", "by-sa"],
  ["by-nc", "by-nc"],
  ["by-nc-sa", "by-nc-sa"],
  ["by-nd", "by-nd"],
  ["by-nc-nd", "by-nc-nd"],
  ["by-nd-nc", "by-nc-nd"],
]);
const CC0_NAMES: ReadonlySet<string> = new Set(["cc0", "zero"]);
const PDM_NAMES: ReadonlySet<string> = new Set([
  "pdm",
  "pd",
  "public-domain",
  "publicdomain",
  "public-domain-mark",
]);

const CUSTOM_TERMS: Readonly<Partial<Record<ProviderId, { url: string; name: string }>>> = {
  pexels: { url: "https://www.pexels.com/license/", name: "Pexels License" },
  pixabay: { url: "https://pixabay.com/service/license-summary/", name: "Pixabay Content License" },
};

export const UNKNOWN_LICENSE: LicenseId = { code: "unknown", version: null, url: null };

const RESTRICTIVENESS: Readonly<Record<LicenseCode, number>> = {
  cc0: 0,
  pdm: 1,
  by: 2,
  "by-sa": 3,
  custom: 4,
  "by-nc": 5,
  "by-nd": 6,
  "by-nc-sa": 7,
  "by-nc-nd": 8,
  unknown: 9,
};

function normalizeVersion(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  const expanded = /^[0-9]$/.test(trimmed) ? `${trimmed}.0` : trimmed;
  return CC_VERSIONS.has(expanded) ? expanded : null;
}

export function canonicalLicense(code: LicenseCode, version: string | null): LicenseId {
  switch (code) {
    case "cc0":
      return { code, version: "1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" };
    case "pdm":
      return { code, version: "1.0", url: "https://creativecommons.org/publicdomain/mark/1.0/" };
    case "custom":
    case "unknown":
      return { code, version: null, url: null };
    default:
      return {
        code,
        version,
        url: version === null ? null : `https://creativecommons.org/licenses/${code}/${version}/`,
      };
  }
}

export function licenseFromUrl(raw: string): LicenseId | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== "creativecommons.org" && host !== "www.creativecommons.org") return null;
  const segments = parsed.pathname
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0);
  const [family, code, version] = segments;
  if (family === "publicdomain") {
    if (version !== "1.0") return null;
    if (code === "zero") return canonicalLicense("cc0", "1.0");
    if (code === "mark") return canonicalLicense("pdm", "1.0");
    return null;
  }
  if (family !== "licenses" || code === undefined) return null;
  const mapped = CC_CODES.get(code);
  if (mapped === undefined) return null;
  const normalizedVersion = normalizeVersion(version);
  if (normalizedVersion === null) return null;
  return canonicalLicense(mapped, normalizedVersion);
}

export function licenseFromName(name: string, versionField: string | null): LicenseId | null {
  const tokens = name
    .toLowerCase()
    .trim()
    .split(/[\s_-]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  let version: string | null = null;
  const last = tokens[tokens.length - 1];
  if (last !== undefined && /^[0-9]+(\.[0-9]+)?$/.test(last)) {
    tokens.pop();
    version = last;
  }
  if (tokens[0] === "cc" && tokens.length > 1) tokens.shift();
  const joined = tokens.join("-");
  if (CC0_NAMES.has(joined)) return canonicalLicense("cc0", "1.0");
  if (PDM_NAMES.has(joined)) return canonicalLicense("pdm", "1.0");
  const mapped = CC_CODES.get(joined);
  if (mapped === undefined) return null;
  return canonicalLicense(mapped, normalizeVersion(version ?? versionField));
}

export function normalizeLicense(input: LicenseInput): LicenseId {
  const custom = CUSTOM_TERMS[input.providerId];
  if (custom !== undefined) return { code: "custom", version: null, url: custom.url };
  const fromUrl = input.url === null ? null : licenseFromUrl(input.url);
  const fromName = input.name === null ? null : licenseFromName(input.name, input.version);
  if (fromUrl !== null && fromName !== null && fromUrl.code !== fromName.code) {
    return UNKNOWN_LICENSE;
  }
  return fromUrl ?? fromName ?? UNKNOWN_LICENSE;
}

export function licenseDisplayName(license: LicenseId, providerId: ProviderId): string {
  switch (license.code) {
    case "cc0":
      return "CC0 1.0";
    case "pdm":
      return "Public Domain Mark 1.0";
    case "unknown":
      return "Unknown license";
    case "custom":
      return CUSTOM_TERMS[providerId]?.name ?? "Custom terms";
    default: {
      const base = `CC ${license.code.toUpperCase()}`;
      return license.version === null ? base : `${base} ${license.version}`;
    }
  }
}

export interface ResolvedLicense {
  readonly license: LicenseId;
  readonly conflict: boolean;
}

export function resolveLicenseConflict(
  item: LicenseId,
  collection: LicenseId | null,
): ResolvedLicense {
  if (collection === null || collection.code === "unknown") {
    return { license: item, conflict: false };
  }
  if (item.code === "unknown") return { license: collection, conflict: false };
  if (item.code === collection.code) return { license: item, conflict: false };
  const stricter =
    RESTRICTIVENESS[collection.code] > RESTRICTIVENESS[item.code] ? collection : item;
  return { license: stricter, conflict: true };
}
