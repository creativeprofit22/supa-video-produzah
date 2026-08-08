import { unicodeScalarLength, type CaptionValidationProfileV1 } from "@supa-video/media";

import {
  captionError,
  spansOverlap,
  type LogicalOccurrence,
} from "./transcript-caption-internal.js";

const OPENING_PUNCTUATION = new Set(["(", "[", "{", "“", "‘"]);
const CLOSING_PUNCTUATION = new Set([
  ",",
  ".",
  ";",
  ":",
  "!",
  "?",
  "%",
  "…",
  ")",
  "]",
  "}",
  "”",
  "’",
]);
const SENTENCE_PUNCTUATION = new Set([".", "!", "?", "…"]);

type DisplayCharacterRole = "text" | "opening" | "closing" | "ascii-opening" | "ascii-closing";

interface DisplayCharacter {
  readonly value: string;
  readonly role: DisplayCharacterRole;
}

export interface DisplayUnit {
  readonly characters: readonly DisplayCharacter[];
  readonly occurrences: readonly LogicalOccurrence[];
}

function normalizedToken(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function appendOccurrence(
  occurrences: readonly LogicalOccurrence[],
  occurrence: LogicalOccurrence,
): readonly LogicalOccurrence[] {
  return occurrences.includes(occurrence) ? occurrences : [...occurrences, occurrence];
}

function sourceOrderIsRepresentable(occurrences: readonly LogicalOccurrence[]): boolean {
  const spans: { sourceStartUs: number; sourceEndUs: number }[] = [];
  for (const occurrence of occurrences) {
    let merged = {
      sourceStartUs: occurrence.sourceStartUs,
      sourceEndUs: occurrence.sourceEndUs,
    };
    while (spans.length > 0 && spansOverlap(spans.at(-1)!, merged)) {
      const previous = spans.pop()!;
      merged = {
        sourceStartUs: Math.min(previous.sourceStartUs, merged.sourceStartUs),
        sourceEndUs: Math.max(previous.sourceEndUs, merged.sourceEndUs),
      };
    }
    const previous = spans.at(-1);
    if (previous !== undefined && merged.sourceStartUs < previous.sourceEndUs) return false;
    spans.push(merged);
  }
  return true;
}

export function sourceBoundaryRequiredBetween(
  existingOccurrences: readonly LogicalOccurrence[],
  nextOccurrences: readonly LogicalOccurrence[],
): boolean {
  const existingWordIds = new Set(existingOccurrences.map(({ wordId }) => wordId));
  if (nextOccurrences.some(({ wordId }) => existingWordIds.has(wordId))) return true;
  return !sourceOrderIsRepresentable([...existingOccurrences, ...nextOccurrences]);
}

export function displayUnits(occurrences: readonly LogicalOccurrence[]): readonly DisplayUnit[] {
  const units: { characters: DisplayCharacter[]; occurrences: LogicalOccurrence[] }[] = [];
  const asciiQuoteOpen = new Map<string, boolean>([
    ['"', false],
    ["'", false],
  ]);
  let attachesToNext = false;

  for (const occurrence of occurrences) {
    const token = normalizedToken(occurrence.text);
    if (token.length === 0) {
      throw captionError(
        "invalid_range",
        "Caption display unit cannot be rendered",
        "caption_unit_unrenderable",
        { wordId: occurrence.wordId },
      );
    }
    const scalars = Array.from(token);
    const punctuationOnly = scalars.every(
      (scalar) =>
        OPENING_PUNCTUATION.has(scalar) ||
        CLOSING_PUNCTUATION.has(scalar) ||
        scalar === '"' ||
        scalar === "'",
    );

    if (!punctuationOnly) {
      const characters = scalars.map((value): DisplayCharacter => ({ value, role: "text" }));
      const previous = units.at(-1);
      if (
        attachesToNext &&
        previous !== undefined &&
        !sourceBoundaryRequiredBetween(previous.occurrences, [occurrence])
      ) {
        previous.characters.push(...characters);
        previous.occurrences = [...appendOccurrence(previous.occurrences, occurrence)];
      } else {
        units.push({ characters, occurrences: [occurrence] });
      }
      attachesToNext = false;
      continue;
    }

    const characters: DisplayCharacter[] = [];
    let attachesToPrevious = attachesToNext;
    let tokenAttachesToNext: boolean = attachesToNext;
    for (const scalar of scalars) {
      if (OPENING_PUNCTUATION.has(scalar)) {
        characters.push({ value: scalar, role: "opening" });
        tokenAttachesToNext = true;
      } else if (CLOSING_PUNCTUATION.has(scalar)) {
        characters.push({ value: scalar, role: "closing" });
        attachesToPrevious = true;
        tokenAttachesToNext = false;
      } else {
        const isOpening = !(asciiQuoteOpen.get(scalar) ?? false);
        asciiQuoteOpen.set(scalar, isOpening);
        characters.push({
          value: scalar,
          role: isOpening ? "ascii-opening" : "ascii-closing",
        });
        if (isOpening) {
          tokenAttachesToNext = true;
        } else {
          attachesToPrevious = true;
          tokenAttachesToNext = false;
        }
      }
    }

    const previous = units.at(-1);
    if (
      attachesToPrevious &&
      previous !== undefined &&
      !sourceBoundaryRequiredBetween(previous.occurrences, [occurrence])
    ) {
      previous.characters.push(...characters);
      previous.occurrences = [...appendOccurrence(previous.occurrences, occurrence)];
    } else {
      units.push({ characters, occurrences: [occurrence] });
    }
    attachesToNext = tokenAttachesToNext;
  }

  return units;
}

export function unitText(unit: DisplayUnit): string {
  return unit.characters.map(({ value }) => value).join("");
}

export function isSentenceFinal(unit: DisplayUnit): boolean {
  for (let index = unit.characters.length - 1; index >= 0; index -= 1) {
    const character = unit.characters[index]!;
    if (SENTENCE_PUNCTUATION.has(character.value)) return true;
    if (character.role === "closing" || character.role === "ascii-closing") continue;
    return false;
  }
  return false;
}

export function wrapUnits(
  units: readonly DisplayUnit[],
  profile: CaptionValidationProfileV1,
): readonly string[] | null {
  const lines: string[] = [];
  for (const unit of units) {
    const text = unitText(unit);
    if (unicodeScalarLength(text) > profile.maxCharactersPerLine) {
      throw captionError(
        "invalid_range",
        "Caption display unit exceeds the line limit",
        "caption_unit_unrenderable",
        {
          wordId: unit.occurrences[0]?.wordId ?? null,
          scalarCount: unicodeScalarLength(text),
          maximumScalarCount: profile.maxCharactersPerLine,
        },
      );
    }
    const current = lines.at(-1);
    if (current === undefined) {
      lines.push(text);
    } else {
      const joined = `${current} ${text}`;
      if (unicodeScalarLength(joined) <= profile.maxCharactersPerLine) {
        lines[lines.length - 1] = joined;
      } else {
        lines.push(text);
      }
    }
    if (lines.length > profile.maxLinesPerCue) return null;
  }
  return lines;
}
