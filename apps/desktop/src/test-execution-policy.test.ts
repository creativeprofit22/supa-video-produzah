import { describe, expect, it } from "vitest";

import config from "../vite.config";

describe("desktop test execution policy", () => {
  it("schedules full-app axe scans separately without serializing other tests or extending budgets", () => {
    expect(config).toMatchObject({
      test: {
        projects: [
          {
            extends: true,
            test: {
              name: "unit",
              exclude: expect.arrayContaining([
                "browser-tests/**",
                "src/video/accessibility.test.tsx",
              ]),
              fileParallelism: true,
              testTimeout: 5_000,
              sequence: { groupOrder: 0 },
            },
          },
          {
            extends: true,
            test: {
              name: "accessibility",
              include: ["src/video/accessibility.test.tsx"],
              testTimeout: 5_000,
              sequence: { groupOrder: 1 },
            },
          },
        ],
      },
    });
  });
});
