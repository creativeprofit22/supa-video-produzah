# Local output-capture hygiene — final handoff

2026-09-14. **Hygiene verified; capture calibration remains blocked. Steps 10 and 11 remain unverified. This is not completion of the whole implementation.**

## Legitimate platform blocker

The machine is Windows 10 Pro build **19045**, UBR 6466 (`output-capture/process-loopback-os.json:2–4`). Microsoft's retained ApplicationLoopback sample requires **build 20348 or later** (`output-capture/official-ApplicationLoopback-README.md:41`). Thus **19045 < 20348**: process-isolated loopback is unsupported on this host. Installing a newer SDK does not change the running OS. No OS/settings changes, API bypass, production changes, or additional recording were attempted during hygiene.

## Preserved capture results — not acceptance

- Original GDI calibration recovered no black-to-white transitions: all center pixels were white. The historical fixture run is not a synchronization calibration (`output-capture/README.md:29,44–46`).
- Compositor run `compositor-2026-09-14T20-37-29-786Z` recovered three visual rises but four audio transients, including an unexplained extra transient, plus an initial DATA_DISCONTINUITY. Calibration failed; no transient was silently discarded or offset subtracted (`output-capture/README.md:5–9`).
- WGC run `wgc-2026-09-14T20-46-51-541Z` completed acquisition, not calibration acceptance. Of 480 frames, 447 acquisition-minus-SystemRelativeTime deltas were negative (range -31.235 to +7.206ms). Initial audio discontinuity, audio onset pairing/extra-onset diagnosis, absolute offset/drift calibration and fixture/native matrix remain unresolved. The two earlier WGC size-mismatch failures remain preserved (`output-capture/WGC-HANDOFF.md:25–33`).
- No new analysis outputs or capture results were generated. Historical IDs/results are unchanged. The existing analyzer remains GDI-shaped, not a WGC acceptance analyzer.

## Accepted privacy boundary

The user authorized the completed captures. Audio was default-render WASAPI system-output loopback, **not microphone input and not process-isolated**. WGC targeted the explicit private test HWND; only ROI mean colors/transitions/timestamps were persisted from that run, not window screenshots. Window-sized GPU frames were transient. The calibration server was localhost-only; no uploads or real project were loaded. Historical GDI ROI images remain local and preserved. These boundaries do not imply physical scanout accuracy (`output-capture/WGC-HANDOFF.md:15–21`; `output-capture/README.md:33–39`). No recorder, browser, decoder, native application or calibration was launched for this hygiene pass.

## Authored-script hygiene

- Four authored implementations now use `.mjs`: `analyze`, `decode-calibration`, `browser-capture`, and `browser-wgc`. Node facilities are explicitly imported; browser callbacks use `globalThis.document`, `globalThis.window` and `globalThis.performance` rather than accidentally closing over the Node-side window record.
- Playwright is dynamically imported through its resolved file URL, using the desktop package's resolution context; `createRequire` is used only for `.resolve`, not as a renamed loading call. Review caught and fixed CommonJS interop: this resolved entry exports Chromium through the dynamic import's `default`, not a named `chromium` export. An import-only Node assertion now confirms `typeof chromium.launch === 'function'`, without invoking it. Installed package entry/source was read; no external implementation comparison is claimed.
- All four original `.cjs` paths remain tiny valid CommonJS asynchronous import wrappers with explicit Node console/process imports. No old user files were deleted. Current documented commands use `.mjs`; historical commands still work through wrappers.
- No lint configuration, ignore rules, dependencies, tests/filters, production settings, roadmap, Notes or checkpoints were changed. Downloaded SDK headers, C++ sample and HTML documentation were untouched; no downloaded JavaScript required exclusion.

## Verification and owned-process cleanup

- `pnpm lint` (the unchanged whole-repository `eslint .`) **passed, exit 0**.
- `node --check` **passed for each of all eight authored `.cjs`/`.mjs` files**, without executing their bodies. This was syntax/import verification only; no additional recording was performed after module conversion.
- At 21:02 UTC, read every retained `browser-window.json` and inspected `Win32_Process` for exact recorded browser PIDs **22852, 24020, 15240, 7840, 13016**, plus previously documented owned Vite/wrapper PIDs **11204, 25700** (`output-capture/README.md:54`). Recorded browser identities are no longer running; 24020/15240/13016/11204/25700 were absent. PIDs 22852 and 7840 have been reused by unrelated `ggnode.exe` TypeScript language-server/tsserver processes, identified by executable, command line and creation time; they were left untouched.
- Also inspected the exact local `WgcRoi.exe` executable path and capture-specific browser/record.ps1 command paths: no running capture jobs matched. Existing handoff records normal recorder exit and owned browser/server closure. **All recorded owned capture processes are stopped; no kill was needed or issued**, and unrelated processes were not terminated. No broad process-name kill was used.
- This report is outside the locally ignored `output-capture/` directory. Raw captures and the local harness remain in that ignored directory.
