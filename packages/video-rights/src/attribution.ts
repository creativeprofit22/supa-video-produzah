import type { LicenseCode, StructuredAttribution } from "@supa-video/contracts";

/* UI mirror of `src-tauri/src/rights/attribution.rs`; pinned by the shared matrix. */

export type AttributionField = "title" | "creator" | "sourceUrl" | "licenseUrl";

function isBlank(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

export function missingAttributionFields(
  code: LicenseCode,
  attribution: StructuredAttribution,
): AttributionField[] {
  const missing: AttributionField[] = [];
  const requiresCredit = code.startsWith("by");
  if (requiresCredit && isBlank(attribution.creator)) missing.push("creator");
  if (isBlank(attribution.sourceUrl)) missing.push("sourceUrl");
  if (requiresCredit && isBlank(attribution.licenseUrl)) missing.push("licenseUrl");
  return missing;
}

export interface CreditEntry {
  readonly receiptId: string;
  readonly attribution: StructuredAttribution;
}

function flatten(value: string): string {
  // Provider text is untrusted: collapse control characters so one entry stays one block.
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character;
  })
    .join("")
    .trim();
}

export function renderCreditsText(entries: readonly CreditEntry[]): string {
  const sorted = [...entries].sort((left, right) =>
    left.receiptId < right.receiptId ? -1 : left.receiptId > right.receiptId ? 1 : 0,
  );
  const blocks = sorted.map(({ attribution }) => {
    const title =
      attribution.title === null || isBlank(attribution.title)
        ? "Untitled"
        : `"${flatten(attribution.title)}"`;
    const creator =
      attribution.creator === null || isBlank(attribution.creator)
        ? ""
        : ` by ${flatten(attribution.creator)}`;
    const licenseUrl =
      attribution.licenseUrl === null ? "" : ` <${flatten(attribution.licenseUrl)}>`;
    const source = attribution.sourceUrl === null ? "unavailable" : flatten(attribution.sourceUrl);
    return [
      `${title}${creator}`,
      `  License: ${flatten(attribution.licenseName)}${licenseUrl}`,
      `  Source: ${source} (via ${flatten(attribution.providerName)})`,
    ].join("\n");
  });
  return `Credits\n\n${blocks.join("\n\n")}\n`;
}
