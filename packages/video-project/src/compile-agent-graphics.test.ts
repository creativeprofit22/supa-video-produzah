import {
  applyGraphicsGroup,
  graphicsProposalV1WireSchema,
  isGraphicsCommand,
  MAX_PROPOSAL_COMMAND_GROUP_BYTES,
  type ProjectProjection,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  type CompileAgentGraphicsInput,
  compileAgentGraphics,
  type GraphicsStyleDefaults,
} from "./compile-agent-graphics.js";
import { fixtureGraphicsClip, fixtureGraphicsTrack } from "./graphics-test-fixtures.js";
import { fixtureClip, fixtureProjection } from "./proposal-test-fixtures.js";

const defaults: GraphicsStyleDefaults = {
  fontKey: "segoe-ui-bold",
  palette: { fg: "#FFFFFF", bg: "#101418", accent: "#FFB300" },
  presetByCardRole: { title: "pop", lowerThird: "tiltIn", endCard: "pop" },
  captionReveal: "word",
  defaultDurationUs: 2_000_000,
  maxOverlapping: 1,
};

function counter(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `9e000000-0000-4000-8000-${next.toString().padStart(12, "0")}`;
  };
}

function sequenceOf(projection: ProjectProjection): VideoSequenceV2 {
  const [sequence] = projection.state.sequences;
  if (sequence === undefined) throw new Error("fixture has a sequence");
  return sequence;
}

function input(
  description: unknown,
  projection: ProjectProjection = fixtureProjection(),
  overrides: Partial<CompileAgentGraphicsInput> = {},
): CompileAgentGraphicsInput {
  return {
    description,
    defaults,
    projectId: projection.projectId,
    revision: projection.revision,
    sequence: sequenceOf(projection),
    producer: { id: "test-agent", version: "1", kind: "model", parameters: {} },
    newId: counter(),
    ...overrides,
  };
}

const title = { kind: "card", id: "title", role: "title", text: "Big idea", atUs: 0 } as const;
const lower = {
  kind: "card",
  id: "lower",
  role: "lowerThird",
  text: "Ada Lovelace",
  atUs: 3_000_000,
} as const;
const caption = { kind: "caption", id: "cap", text: "Three quick tips", atUs: 6_000_000 } as const;

function withExtraTrack(
  projection: ProjectProjection,
  locked: boolean,
  hidden = false,
): ProjectProjection {
  const sequence = sequenceOf(projection);
  const track = {
    ...fixtureGraphicsTrack("9a000000-0000-4000-8000-000000000001", [
      fixtureGraphicsClip("9a000000-0000-4000-8000-000000000002", sequence.rate, 0, 5),
    ]),
    locked,
    hidden,
  };
  return {
    ...projection,
    state: {
      ...projection.state,
      sequences: [{ ...sequence, tracks: [...sequence.tracks, track] }],
    },
  };
}

describe("compileAgentGraphics", () => {
  it("compiles cards and captions into a valid graphics proposal with a new track", () => {
    const result = compileAgentGraphics(
      input({ schemaVersion: 1, items: [caption, lower, title] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proposal = graphicsProposalV1WireSchema.parse(result.value);
    expect(proposal.items.map(({ itemId }) => itemId)).toEqual(["title", "lower", "cap"]);
    const [insert, ...adds] = proposal.commandGroup.commands;
    expect(insert?.type).toBe("InsertTrack");
    expect(adds.map(({ type }) => type)).toEqual([
      "AddGraphicsClip",
      "AddGraphicsClip",
      "AddGraphicsClip",
    ]);
    for (const [index, command] of adds.entries()) {
      if (command.type !== "AddGraphicsClip") throw new Error("expected AddGraphicsClip");
      expect(command.trackId).toBe(proposal.trackId);
      expect(command.graphicsClip.id).toBe(proposal.items[index]?.graphicsClipId);
      expect(command.graphicsClip.fontKey).toBe("segoe-ui-bold");
    }
    const lowerClip = adds[1];
    if (lowerClip?.type !== "AddGraphicsClip") throw new Error("expected AddGraphicsClip");
    expect(lowerClip.graphicsClip.timelineStart.value).toBe(30);
    expect(lowerClip.graphicsClip.duration.value).toBe(20);
    const captionClip = adds[2];
    if (captionClip?.type !== "AddGraphicsClip") throw new Error("expected AddGraphicsClip");
    const [captionLayer] = captionClip.graphicsClip.layers;
    expect(captionLayer?.kind === "text" ? captionLayer.units?.split : undefined).toBe("word");
  });

  it("applies cleanly to the project it was compiled against", () => {
    const projection = fixtureProjection();
    const result = compileAgentGraphics(
      input({ schemaVersion: 1, items: [title, lower] }, projection),
    );
    if (!result.ok) throw new Error(result.error.kind);
    const [insert, ...adds] = result.value.commandGroup.commands;
    if (insert?.type !== "InsertTrack") throw new Error("expected InsertTrack");
    const sequence = sequenceOf(projection);
    const state = {
      ...projection.state,
      sequences: [{ ...sequence, tracks: [insert.track, ...sequence.tracks] }],
    };
    const graphics = adds.filter((command) => isGraphicsCommand(command));
    expect(graphics).toHaveLength(adds.length);
    const applied = applyGraphicsGroup(
      state,
      graphics,
      (commandId, ordinal) => `${commandId.slice(0, 24)}${String(ordinal).padStart(12, "0")}`,
    );
    expect(applied.ok).toBe(true);
  });

  it("is deterministic and honours per-item overrides", () => {
    const description = {
      schemaVersion: 1,
      items: [{ ...title, preset: "slam", fontKey: "georgia-bold", colour: "#00FF00" }],
    };
    const first = compileAgentGraphics(input(description));
    const second = compileAgentGraphics(input(description));
    expect(first).toEqual(second);
    if (!first.ok) return;
    const add = first.value.commandGroup.commands[1];
    if (add?.type !== "AddGraphicsClip") throw new Error("expected AddGraphicsClip");
    expect(add.graphicsClip.fontKey).toBe("georgia-bold");
    expect(
      add.graphicsClip.layers.some((layer) => "fill" in layer && layer.fill === "#00FF00"),
    ).toBe(true);
  });

  it("reuses an unlocked graphics track instead of inserting one", () => {
    const projection = withExtraTrack(fixtureProjection(), false);
    const result = compileAgentGraphics(
      input({ schemaVersion: 1, items: [{ ...lower, atUs: 1_000_000 }] }, projection),
    );
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.trackId).toBe("9a000000-0000-4000-8000-000000000001");
    expect(result.value.commandGroup.commands.map(({ type }) => type)).toEqual(["AddGraphicsClip"]);
  });

  it("inserts a new track when the only graphics track is locked", () => {
    const projection = withExtraTrack(fixtureProjection(), true);
    const result = compileAgentGraphics(
      input({ schemaVersion: 1, items: [{ ...lower, atUs: 1_000_000 }] }, projection, {
        defaults: { ...defaults, maxOverlapping: 2 },
      }),
    );
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.commandGroup.commands[0]?.type).toBe("InsertTrack");
  });

  it("inserts a new track when the only graphics track is hidden", () => {
    const projection = withExtraTrack(fixtureProjection(), false, true);
    const result = compileAgentGraphics(
      input({ schemaVersion: 1, items: [{ ...lower, atUs: 1_000_000 }] }, projection),
    );
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.trackId).not.toBe("9a000000-0000-4000-8000-000000000001");
    expect(result.value.commandGroup.commands[0]?.type).toBe("InsertTrack");
  });

  it.each([
    ["invalid_description", { schemaVersion: 1, items: [{ ...title, extra: 1 }] }, {}],
    ["invalid_description", { schemaVersion: 1, items: [] }, {}],
    ["out_of_sequence", { schemaVersion: 1, items: [{ ...title, atUs: 10_000_000 }] }, {}],
    ["overlap_limit", { schemaVersion: 1, items: [title, { ...lower, atUs: 1_000_000 }] }, {}],
    ["text_too_long", { schemaVersion: 1, items: [{ ...title, text: "x".repeat(121) }] }, {}],
  ])("reports %s", (kind, description, overrides) => {
    const result = compileAgentGraphics(input(description, fixtureProjection(), overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
  });

  it("reports too_large when the command group would exceed the native byte limit", () => {
    // 600 s sequence; 64 letter-reveal captions at the 120-character limit, 9 s apart.
    const projection = fixtureProjection([fixtureClip(100, 0, 6_000)]);
    const items = Array.from({ length: 64 }, (_, index) => ({
      kind: "caption",
      id: `cap-${index}`,
      text: "x".repeat(120),
      atUs: index * 9_000_000,
      reveal: "letter",
    }));
    const result = compileAgentGraphics(input({ schemaVersion: 1, items }, projection));
    expect(result).toMatchObject({ ok: false, error: { kind: "too_large" } });
    if (result.ok || result.error.kind !== "too_large") return;
    expect(result.error.bytes).toBeGreaterThan(result.error.maxBytes);
    expect(result.error.maxBytes).toBeLessThanOrEqual(MAX_PROPOSAL_COMMAND_GROUP_BYTES);
  });

  it("reports invalid_description with issue paths", () => {
    const result = compileAgentGraphics(
      input({ schemaVersion: 1, items: [{ ...title, atUs: -5 }] }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "invalid_description", issues: [{ path: ["items", 0, "atUs"] }] },
    });
  });

  it("counts graphics on other tracks against the overlap limit", () => {
    const projection = withExtraTrack(fixtureProjection(), true);
    const result = compileAgentGraphics(input({ schemaVersion: 1, items: [title] }, projection));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "overlap_limit", conflictsWith: "9a000000-0000-4000-8000-000000000002" },
    });
  });

  it("ignores graphics on hidden tracks for the overlap limit", () => {
    const projection = withExtraTrack(fixtureProjection(), true, true);
    const result = compileAgentGraphics(input({ schemaVersion: 1, items: [title] }, projection));
    expect(result.ok).toBe(true);
  });

  it("clamps a card that runs past the sequence end", () => {
    const result = compileAgentGraphics(
      input({ schemaVersion: 1, items: [{ ...title, atUs: 9_500_000 }] }),
    );
    if (!result.ok) throw new Error(result.error.kind);
    const add = result.value.commandGroup.commands[1];
    if (add?.type !== "AddGraphicsClip") throw new Error("expected AddGraphicsClip");
    expect(add.graphicsClip.timelineStart.value + add.graphicsClip.duration.value).toBe(100);
  });
});
