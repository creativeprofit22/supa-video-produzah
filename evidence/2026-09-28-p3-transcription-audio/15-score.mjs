// Scores NeMo transcription JSON against NASA's speaker-attributed reference (step 15).
// One scorer for every run, so modes compare on equal terms.
// Usage: node 15-score.mjs <reference-turns.json> <run.json> [<run.json> ...]
import fs from "node:fs";
import process from "node:process";
import console from "node:console";

const normalize = (text) =>
  text
    .toLowerCase()
    .replaceAll("\u2019", "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && word !== "'");

const [referencePath, ...runPaths] = process.argv.slice(2);
if (referencePath === undefined || runPaths.length === 0) {
  console.error("usage: node 15-score.mjs <reference-turns.json> <run.json> [...]");
  process.exit(2);
}
const turns = JSON.parse(fs.readFileSync(referencePath, "utf8"));
const reference = turns.flatMap(([speaker, text]) =>
  normalize(text).map((word) => ({ word, speaker })),
);

// Levenshtein alignment with backtrace; returns edit count and matched index pairs.
// The reference is the whole episode and the clip starts at its start, so the
// reference end is free: the clip span is the reference prefix that aligns best.
const align = (ref, hyp) => {
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const cost = new Uint32Array(rows * cols);
  for (let i = 0; i < rows; i++) cost[i * cols] = i;
  for (let j = 0; j < cols; j++) cost[j] = j;
  for (let i = 1; i < rows; i++)
    for (let j = 1; j < cols; j++) {
      const same = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      cost[i * cols + j] = Math.min(
        cost[(i - 1) * cols + j - 1] + same,
        cost[(i - 1) * cols + j] + 1,
        cost[i * cols + j - 1] + 1,
      );
    }
  let spanEnd = 0;
  for (let r = 1; r < rows; r++)
    if (cost[r * cols + hyp.length] < cost[spanEnd * cols + hyp.length]) spanEnd = r;
  const matches = [];
  let i = spanEnd;
  let j = hyp.length;
  while (i > 0 && j > 0) {
    const here = cost[i * cols + j];
    if (ref[i - 1] === hyp[j - 1] && here === cost[(i - 1) * cols + j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (here === cost[(i - 1) * cols + j - 1] + 1) {
      i--;
      j--;
    } else if (here === cost[(i - 1) * cols + j] + 1) i--;
    else j--;
  }
  return { edits: cost[spanEnd * cols + hyp.length], spanEnd, matches: matches.reverse() };
};

for (const runPath of runPaths) {
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  // One normalized token per output word may expand (e.g. "Moon-base"); keep its speaker.
  const hypothesis = run.words.flatMap(({ word, speaker }) =>
    normalize(word).map((token) => ({ word: token, speaker: speaker ?? null })),
  );
  const { edits, spanEnd, matches } = align(
    reference.map(({ word }) => word),
    hypothesis.map(({ word }) => word),
  );
  const confusion = {};
  for (const [r, h] of matches) {
    const key = `${reference[r].speaker}|speaker_${hypothesis[h].speaker}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  // Best many-to-one mapping: each predicted label maps to its majority reference speaker.
  const byLabel = {};
  for (const [key, count] of Object.entries(confusion)) {
    const [speaker, label] = key.split("|");
    byLabel[label] ??= {};
    byLabel[label][speaker] = count;
  }
  let correct = 0;
  const mapping = {};
  for (const label of Object.keys(byLabel).sort()) {
    const [speaker, count] = Object.entries(byLabel[label]).sort((a, b) => b[1] - a[1])[0];
    mapping[label] = speaker;
    correct += count;
  }
  console.log(
    JSON.stringify({
      run: runPath,
      referenceWordsInSpan: spanEnd,
      hypothesisWords: hypothesis.length,
      wer: Number((edits / spanEnd).toFixed(4)),
      edits,
      matchedWords: matches.length,
      speakerAttribution: Number((correct / matches.length).toFixed(4)),
      mapping,
      confusion: Object.fromEntries(Object.entries(confusion).sort()),
    }),
  );
}
