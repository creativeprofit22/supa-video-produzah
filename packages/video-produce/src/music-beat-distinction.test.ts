import type { MusicBeatSourceTimes } from "@supa-video/contracts";
import { describe, expectTypeOf, it } from "vitest";

import type { NarrativeBeat } from "./narrative-beat.js";

// CONTEXT.md: music beats (detected pulses in a music asset) are never
// narrative beats (story units of the first-cut plan). Their types must not
// be interchangeable in either direction.
describe("music beats and narrative beats", () => {
  it("are not assignable to each other", () => {
    expectTypeOf<MusicBeatSourceTimes>().not.toExtend<NarrativeBeat>();
    expectTypeOf<NarrativeBeat>().not.toExtend<MusicBeatSourceTimes>();
    expectTypeOf<readonly NarrativeBeat[]>().not.toExtend<MusicBeatSourceTimes["beatsUs"]>();
  });
});
