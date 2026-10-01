import { describe, expect, it } from "vitest";
import { config, z } from "zod";

import "./zod-csp";

describe("zod CSP configuration", () => {
  it("disables the eval-based JIT so the production CSP sees no eval", () => {
    expect(config().jitless).toBe(true);
    expect(z.strictObject({ a: z.number() }).parse({ a: 1 })).toEqual({ a: 1 });
  });
});
