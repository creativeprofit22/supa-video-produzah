import { test } from "@playwright/test";
import { writeEvidence } from "../evidence-output.mjs";

// Writes to the committed evidence path only when SUPA_VIDEO_WRITE_EVIDENCE=1; otherwise into this test's output dir.
export function evidencePath(committedPath: string): string {
  if (writeEvidence) return committedPath;
  return test.info().outputPath(committedPath.slice(committedPath.lastIndexOf("/") + 1));
}
