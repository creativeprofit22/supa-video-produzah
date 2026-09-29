import { describe, expect, it } from "vitest";

import { createFillerWordsRule, findFillerWords, normalizeToken } from "./filler-words-rule.js";
import { produceProposal } from "./produce-proposal.js";
import { fixtureArtifact, fixtureProjection, fixtureScope } from "./proposal-test-fixtures.js";
import { projectTranscriptToTimeline } from "./transcript-edit.js";

function scopeFor(
  texts: readonly string[],
  language: string | null = "en",
): ReturnType<typeof fixtureScope> {
  return fixtureScope(
    fixtureArtifact(
      texts.map((text, index) => ({
        startUs: index * 1_000_000,
        endUs: index * 1_000_000 + 500_000,
        text,
      })),
      language,
    ),
    fixtureProjection(),
  );
}

function fillersIn(texts: readonly string[], language = "en", skipRepeated = true): unknown {
  const scope = scopeFor(texts, language);
  const occurrences = projectTranscriptToTimeline(scope).occurrences;
  const result = findFillerWords(
    occurrences,
    language,
    { skipRepeated },
    new AbortController().signal,
  );
  if (!result.ok) return result.error;
  return result.value.map((edit) => {
    if (edit.kind !== "delete-words") return edit.kind;
    const occurrence = occurrences.find(
      ({ occurrenceId }) => occurrenceId === edit.occurrenceIds[0],
    );
    return occurrence?.text;
  });
}

describe("filler-words rule", () => {
  it.each([
    ["plain fillers", ["So", "um", "we", "uh", "start"], "en", ["um", "uh"]],
    ["punctuation and case", ["Um,", "hello", "UH..."], "en", ["Um,", "UH..."]],
    ["meaningful words are kept", ["I", "like", "it", "so", "much"], "en", []],
    ["exact token only", ["umbrella", "human", "hum"], "en", []],
    ["repeated agreement is kept", ["mm", "mm", "yes", "um"], "en", ["um"]],
    ["language subtag", ["äh", "ja"], "de-AT", ["äh"]],
    ["french", ["euh", "bonjour"], "fr", ["euh"]],
  ] as const)("%s", (_label, texts, language, expected) => {
    expect(fillersIn(texts, language)).toEqual(expected);
  });

  it("can remove repeated fillers when the guard is off", () => {
    expect(fillersIn(["mm", "mm"], "en", false)).toEqual(["mm", "mm"]);
  });

  it("rejects languages without a list", () => {
    expect(fillersIn(["um"], "ja")).toMatchObject({ code: "invalid_input" });
  });

  it.each([
    ["auto-detected transcript language", undefined, null],
    ["blank explicit language", "  ", "en"],
  ] as const)(
    "refuses to guess when the language is unknown: %s",
    async (_label, option, transcript) => {
      const result = await produceProposal(
        createFillerWordsRule({
          ...(option === undefined ? {} : { language: option }),
          skipRepeated: true,
        }),
        scopeFor(["hello", "um"], transcript),
        new AbortController().signal,
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Transcript language is unknown; choose a language for filler words",
        },
      });
    },
  );

  it("uses an explicit language on an auto-detected transcript and records it", async () => {
    const result = await produceProposal(
      createFillerWordsRule({ language: "de-AT", skipRepeated: true }),
      scopeFor(["hallo", "äh"], null),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposal.producer.parameters).toMatchObject({ language: "de-AT" });
    expect(result.value.proposal.selectedWords.map(({ text }) => text)).toEqual(["äh"]);
  });

  it("normalizes tokens", () => {
    expect(normalizeToken("  «Euh»!  ")).toBe("euh");
    expect(normalizeToken("Ähm")).toBe("ähm");
  });

  it("honours cancellation", () => {
    const scope = scopeFor(["um"]);
    const controller = new AbortController();
    controller.abort();
    expect(
      findFillerWords(
        projectTranscriptToTimeline(scope).occurrences,
        "en",
        { skipRepeated: true },
        controller.signal,
      ),
    ).toEqual({ ok: false, error: { code: "cancelled" } });
  });

  it("uses the transcript language and yields a validated proposal", async () => {
    const result = await produceProposal(
      createFillerWordsRule(),
      scopeFor(["hello", "um", "world"]),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposal.producer).toMatchObject({
      id: "filler-words",
      kind: "rule",
      parameters: { language: "auto", skipRepeated: true },
    });
    expect(result.value.proposal.selectedWords.map(({ text }) => text)).toEqual(["um"]);
  });
});
