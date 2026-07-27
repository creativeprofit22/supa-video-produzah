import { describe, expect, it } from "vitest";

import * as publicContracts from "./index.js";

describe("derived-media ownership", () => {
  it("keeps preparation schemas out of video-contracts", () => {
    expect(publicContracts).not.toHaveProperty("prepareVideoAssetRequestSchema");
    expect(publicContracts).not.toHaveProperty("preparedVideoAssetSchema");
  });
});
