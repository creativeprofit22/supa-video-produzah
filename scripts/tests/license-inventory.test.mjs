import test from "node:test";
import assert from "node:assert/strict";

import {
  cargoEntries,
  isSatisfiable,
  normalizeExpression,
  npmEntries,
  render,
  validate,
} from "../license-inventory.mjs";

test("normalizes legacy slash spellings", () => {
  assert.equal(normalizeExpression("MIT/Apache-2.0"), "MIT OR Apache-2.0");
  assert.equal(normalizeExpression("Apache-2.0 / MIT"), "Apache-2.0 OR MIT");
  assert.equal(normalizeExpression(""), null);
  assert.equal(normalizeExpression(undefined), null);
});

test("evaluates SPDX expressions against the allowlist", () => {
  for (const [expression, expected] of [
    ["MIT", true],
    ["MIT OR GPL-3.0-only", true],
    ["GPL-3.0-only", false],
    ["MIT AND GPL-3.0-only", false],
    ["(MIT OR Apache-2.0) AND Unicode-3.0", true],
    ["Apache-2.0 WITH LLVM-exception", true],
    ["GPL-2.0 WITH Classpath-exception-2.0", false],
    ["MIT OR Apache-2.0 OR LGPL-2.1-or-later", true],
    ["SSPL-1.0", false],
  ]) {
    assert.equal(isSatisfiable(expression), expected, expression);
  }
  assert.throws(() => isSatisfiable("(MIT"), /unbalanced|truncated/u);
  assert.throws(() => isSatisfiable("MIT OR"), /truncated/u);
});

test("fails closed on malformed pnpm output and unlicensed packages", () => {
  assert.throws(() => npmEntries([]), /expected an object/u);
  assert.throws(() => npmEntries({ MIT: {} }), /not a list/u);
  assert.throws(() => npmEntries({ MIT: [{ name: "x" }] }), /malformed entry/u);
  const entries = npmEntries({ Unknown: [{ name: "x", versions: ["1.0.0"], license: "" }] });
  assert.deepEqual(validate(entries), ["npm x@1.0.0: no license"]);
});

test("walks only normal and build cargo dependencies", () => {
  const pkg = (id, license) => ({ id, name: id, version: "1.0.0", license });
  const metadata = {
    packages: [
      pkg("app", "MIT"),
      pkg("lib", "MIT"),
      pkg("build", "Apache-2.0"),
      pkg("dev", "GPL-3.0-only"),
      pkg("bad", null),
    ],
    resolve: {
      root: "app",
      nodes: [
        {
          id: "app",
          deps: [
            { pkg: "lib", dep_kinds: [{ kind: null }] },
            { pkg: "build", dep_kinds: [{ kind: "build" }] },
            { pkg: "dev", dep_kinds: [{ kind: "dev" }] },
          ],
        },
        { id: "lib", deps: [{ pkg: "bad", dep_kinds: [{ kind: null }] }] },
        { id: "build", deps: [] },
        { id: "bad", deps: [] },
      ],
    },
  };
  const names = cargoEntries(metadata)
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(names, ["bad", "build", "lib"]);
  assert.deepEqual(validate(cargoEntries(metadata)), ["cargo bad@1.0.0: no license"]);
  assert.throws(() => cargoEntries({}), /unexpected shape/u);
});

test("renders a deterministic, deduplicated inventory", () => {
  const entries = [
    { ecosystem: "cargo", name: "b", version: "1.0.0", license: "MIT" },
    { ecosystem: "npm", name: "a", version: "2.0.0", license: "ISC" },
    { ecosystem: "cargo", name: "b", version: "1.0.0", license: "MIT" },
  ];
  const text = render(entries);
  assert.equal(text, render([...entries].reverse()));
  assert.match(text, /JavaScript \(npm\) — 1 packages/u);
  assert.match(text, /Rust \(crates.io\) — 1 packages/u);
});
