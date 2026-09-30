import process from "node:process";

// Committed evidence is refreshed only on request; normal runs keep screenshots in test-results.
export const writeEvidence = process.env.SUPA_VIDEO_WRITE_EVIDENCE === "1";
