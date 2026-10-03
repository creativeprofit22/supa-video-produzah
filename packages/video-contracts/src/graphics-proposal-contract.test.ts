import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  graphicsProposalV1WireSchema,
  isGraphicsProposalWire,
  proposalListingSchema,
  storedProposalSchema,
} from "./agent-proposal.js";

const fixturesUrl = new URL("../fixtures/", import.meta.url);
const readFixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, fixturesUrl), "utf8"));

const uuid = (n: number): string => `9d000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const time = (value: number) => ({ value, rateNumerator: 30, rateDenominator: 1 });
const keyframe = (value: number) => [{ timeMicroseconds: 0, value }];
const clip = {
  graphicsVersion: 1,
  id: uuid(20),
  timelineStart: time(0),
  duration: time(60),
  fontKey: "arial-bold",
  layers: [
    {
      kind: "text",
      text: "Hello",
      fontSize: 48,
      fill: "#FFFFFF",
      x: keyframe(0),
      y: keyframe(0),
      scale: keyframe(1),
      rotation: keyframe(0),
      opacity: keyframe(1),
    },
  ],
};
const revision = {
  number: 3,
  id: uuid(30),
  parentId: null,
  committedAt: "2026-10-03T12:00:00.000Z",
  operationId: uuid(31),
  stateHash: "ab".repeat(32),
};
const graphicsProposal = {
  schemaVersion: 1,
  proposalKind: "graphics",
  proposalId: uuid(1),
  projectId: uuid(2),
  projectRevision: revision,
  sequenceId: uuid(3),
  trackId: uuid(4),
  producer: {
    id: "recipe-graphics",
    version: "1",
    kind: "rule",
    parameters: { recipeId: "retro" },
  },
  description: {
    schemaVersion: 1,
    recipeId: "retro",
    items: [{ kind: "card", id: "title", role: "title", text: "Hello", atUs: 0 }],
  },
  items: [{ itemId: "title", label: "Title · Hello", graphicsClipId: uuid(20) }],
  commandGroup: {
    groupId: uuid(5),
    projectId: uuid(2),
    baseRevision: 3,
    commands: [
      {
        type: "AddGraphicsClip",
        commandId: uuid(6),
        sequenceId: uuid(3),
        trackId: uuid(4),
        graphicsClip: clip,
      },
    ],
  },
};

describe("graphics proposal wire schema", () => {
  it("accepts a graphics proposal and narrows it", () => {
    const parsed = graphicsProposalV1WireSchema.parse(graphicsProposal);
    expect(isGraphicsProposalWire(parsed)).toBe(true);
  });

  it.each([
    ["no items", { ...graphicsProposal, items: [] }],
    ["unknown field", { ...graphicsProposal, extra: true }],
    ["wrong kind", { ...graphicsProposal, proposalKind: "transcript" }],
    [
      "bad item id",
      { ...graphicsProposal, items: [{ ...graphicsProposal.items[0], itemId: "A" }] },
    ],
  ])("rejects %s", (_name, input) => {
    expect(graphicsProposalV1WireSchema.safeParse(input).success).toBe(false);
  });

  it("stores graphics proposals alongside transcript ones", () => {
    const listing = proposalListingSchema.parse(readFixture("proposal-listing-transcript-v2.json"));
    const transcript = listing.proposals[0];
    expect(transcript).toBeDefined();
    if (transcript === undefined) return;
    const stored = storedProposalSchema.parse({ ...transcript, proposal: graphicsProposal });
    expect(isGraphicsProposalWire(stored.proposal)).toBe(true);
    expect(isGraphicsProposalWire(transcript.proposal)).toBe(false);
  });

  it("loads an existing transcript-only store unchanged", () => {
    const raw = readFixture("proposal-listing-transcript-v2.json");
    expect(proposalListingSchema.parse(raw)).toEqual(raw);
  });
});
