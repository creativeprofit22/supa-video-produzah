// Regenerates fixtures/v1/{explainer,podcast}.json from readable source data.
// Run after `pnpm build`: node scripts/generate-fixtures.mjs
// The generated JSON is the versioned, reviewed input; tests never call this.
import { writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

import { canonicalJson } from "../dist/canonical.js";
import {
  TEST_DAY_MS,
  TEST_NOW_MS,
  testAsset,
  testReceipt,
  testUuid,
} from "../dist/test-support.js";

const root = new URL("../fixtures/v1/", import.meta.url);
const RATE = { numerator: 30, denominator: 1 };
const time = (value) => ({ value, rateNumerator: 30, rateDenominator: 1 });
const transform = {
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1000,
  scaleYPermille: 1000,
  rotationMilliDegrees: 0,
  opacityPermille: 1000,
};
const digest = (byte) => byte.repeat(32);

function sequence(id, tracks) {
  return {
    id,
    name: "Sequence 1",
    rate: RATE,
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks,
    markers: [],
  };
}

function write(name, fixture) {
  const path = fileURLToPath(new URL(`${name}.json`, root));
  writeFileSync(path, `${JSON.stringify(JSON.parse(canonicalJson(fixture)), null, 2)}\n`);
}

// ---------- Explainer (Spanish script, English/German asset names) ----------
{
  const id = (n) => testUuid(0xe1, n);
  const receipt = (n) => testUuid(0xe2, n);
  const assets = [
    testAsset({
      id: id(1),
      name: "river canyon aerial.mp4",
      durationUs: 30_000_000,
      digest: digest("01"),
    }),
    testAsset({
      id: id(2),
      name: "kayak rapids.mp4",
      durationUs: 12_000_000,
      digest: digest("02"),
    }),
    testAsset({
      id: id(3),
      name: "Brücke bei Sonnenuntergang.mov",
      durationUs: 20_000_000,
      digest: digest("03"),
    }),
    testAsset({ id: id(4), name: "Brücke copy.mov", durationUs: 20_000_000, digest: digest("03") }),
    testAsset({
      id: id(5),
      name: "snowy peaks.webm",
      durationUs: 15_000_000,
      digest: digest("05"),
      receiptId: receipt(5),
    }),
    testAsset({
      id: id(6),
      name: "snow river.webm",
      durationUs: 15_000_000,
      digest: digest("06"),
      receiptId: receipt(6),
    }),
    testAsset({
      id: id(7),
      name: "city crowd.webm",
      durationUs: 15_000_000,
      digest: digest("07"),
      receiptId: receipt(7),
    }),
    testAsset({
      id: id(8),
      name: "forest stream.webm",
      durationUs: 15_000_000,
      digest: digest("08"),
      receiptId: receipt(8),
    }),
    testAsset({
      id: id(9),
      name: "river phone vertical.mp4",
      durationUs: 30_000_000,
      width: 1080,
      height: 1920,
      digest: digest("09"),
    }),
    testAsset({
      id: id(10),
      name: "old city archive.webm",
      durationUs: 15_000_000,
      digest: digest("0a"),
      receiptId: receipt(10),
    }),
  ];
  const receipts = [
    testReceipt({
      receiptId: receipt(5),
      digest: digest("05"),
      license: "by",
      title: "Snowy peaks",
      providerId: "wikimedia-commons",
    }),
    testReceipt({
      receiptId: receipt(6),
      digest: digest("06"),
      license: "unknown",
      title: "Snow river",
      providerId: "openverse",
    }),
    testReceipt({
      receiptId: receipt(7),
      digest: digest("07"),
      license: "by-nc",
      title: "City crowd",
      providerId: "openverse",
    }),
    testReceipt({
      receiptId: receipt(8),
      digest: digest("08"),
      license: "cc0",
      title: "Forest stream",
      status: "withdrawn",
    }),
    testReceipt({
      receiptId: receipt(10),
      digest: digest("0a"),
      license: "cc0",
      title: "Old city archive",
      refreshedAgoMs: 90 * TEST_DAY_MS,
    }),
  ];
  write("explainer", {
    fixtureVersion: 1,
    name: "explainer-es-rivers",
    projectId: testUuid(0xe0, 1),
    projectRevision: 3,
    nowMs: TEST_NOW_MS,
    intendedUse: "commercial-online",
    language: "es",
    state: { assets, sequences: [sequence(id(100), [])], activeSequenceId: id(100) },
    receipts,
    tags: { [id(5)]: ["nieve", "montaña"], [id(1)]: ["cañón"] },
    transcripts: [],
    embeddings: {
      modelId: "fixture-embedding",
      modelVersion: "1",
      content: {
        [`sha256:${digest("01")}`]: [0.9, 0.1, 0],
        [`sha256:${digest("09")}`]: [0.8, 0.2, 0],
        [`sha256:${digest("03")}`]: [0.1, 0.9, 0],
      },
      text: { "El río vuelve al cañón al final del día.": [1, 0, 0] },
      clusters: {
        [`sha256:${digest("01")}`]: "cluster-river",
        [`sha256:${digest("09")}`]: "cluster-river",
        [`sha256:${digest("03")}`]: "cluster-bridge",
      },
    },
    source: {
      workflow: "explainer",
      wordsPerMinute: 150,
      script: [
        "# Los ríos del oeste",
        "El río atraviesa el cañón durante millones de años.",
        "Los kayaks bajan por los rápidos. [show: kayak]",
        "Un puente cruza el río al atardecer. [avoid: multitud]",
        "Map: cuenca del río Colorado",
        "La nieve de la montaña alimenta cada río. [show: nieve]",
        "Lower third: Dra. Ana Ruiz, hidróloga",
        "Una ciudad llena de gente depende del agua. [show: ciudad]",
        "El río vuelve al cañón al final del día. [portrait]",
      ].join("\n"),
    },
  });
}

// ---------- Podcast (German A-roll transcript, English cutaways) ----------
{
  const id = (n) => testUuid(0xd1, n);
  const receipt = (n) => testUuid(0xd2, n);
  const sentences = [
    "Willkommen zurück zu unserer Sendung.",
    "Heute reden wir über den Fluss und seine Brücke.",
    "Im Winter liegt Schnee auf den Bergen.",
    "Mein Mikrofon rauscht heute ein wenig.",
    "Danke fürs Zuhören und bis bald.",
  ];
  const words = [];
  let cursor = 500_000;
  for (const sentence of sentences) {
    for (const text of sentence.split(" ")) {
      words.push({ text, sourceStartUs: cursor, sourceEndUs: cursor + 350_000 });
      cursor += 400_000;
    }
    cursor += 900_000;
  }
  const endUs = cursor;
  const endFrames = Math.ceil((endUs * 30) / 1_000_000);
  const assets = [
    testAsset({
      id: id(1),
      name: "episode 12 host camera.mp4",
      durationUs: 60_000_000,
      digest: digest("11"),
    }),
    testAsset({ id: id(2), name: "river drone.mp4", durationUs: 20_000_000, digest: digest("12") }),
    testAsset({
      id: id(3),
      name: "bridge detail.mp4",
      durationUs: 20_000_000,
      digest: digest("13"),
    }),
    testAsset({
      id: id(4),
      name: "snow mountains.mp4",
      durationUs: 20_000_000,
      digest: digest("14"),
    }),
    testAsset({
      id: id(5),
      name: "microphone closeup.webm",
      durationUs: 20_000_000,
      digest: digest("15"),
      receiptId: receipt(5),
    }),
  ];
  const aRoll = {
    id: id(50),
    source: { kind: "asset", assetId: id(1) },
    timelineStart: time(0),
    sourceIn: time(0),
    sourceOut: time(endFrames),
    transform,
    gainMilliDecibels: 0,
  };
  write("podcast", {
    fixtureVersion: 1,
    name: "podcast-de-episode-12",
    projectId: testUuid(0xd0, 1),
    projectRevision: 9,
    nowMs: TEST_NOW_MS,
    intendedUse: "commercial-online",
    language: "de",
    state: {
      assets,
      sequences: [
        sequence(id(100), [{ id: id(101), name: "Video 1", kind: "video", clips: [aRoll] }]),
      ],
      activeSequenceId: id(100),
    },
    receipts: [
      testReceipt({
        receiptId: receipt(5),
        digest: digest("15"),
        license: "unknown",
        title: "Microphone",
      }),
    ],
    tags: {},
    transcripts: [{ assetId: id(1), language: "de", words }],
    embeddings: null,
    source: { workflow: "podcast", aRollClipId: id(50) },
  });
}
