import { test } from "@playwright/test";
import { writeEvidence } from "../evidence-output.mjs";

// Writes into committed evidence/ only when SUPA_VIDEO_WRITE_EVIDENCE=1; otherwise into this test's output dir.
export function evidencePath(evidenceDir: string, fileName: string): string {
  if (writeEvidence) return `../../evidence/${evidenceDir}/${fileName}`;
  return test.info().outputPath(fileName);
}
