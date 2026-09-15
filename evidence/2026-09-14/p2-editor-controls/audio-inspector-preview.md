# Audio inspector / preview handoff

Implemented selected media audio inspector, bulk canonical controller audio edits, mock gain/fades application with public Restore rejection, and ProgramMonitor Web Audio graph. No native build or dependency changes.

Verification:
- `pnpm --filter @supa-video/desktop check` passed: execution 12140021-b49b-4d62-85bb-9c3ccf9c2e08 (before new test file and final empty-group guard).
- `pnpm --filter @supa-video/desktop test src/video/preview-audio.test.ts --maxWorkers=1` passed 3/3: execution 8dcf032b-b732-4ec7-b526-fe2e9bcb7038. Covers exact output duration/envelope, amplification above unity, nodes/listeners/context cleanup and explicit missing-Web-Audio failure. Uses EventTarget/media and AudioContext test doubles, not production source bypass.
- Combined ProgramMonitor/VideoWorkspace/controller regression attempt failed to start three forks workers (worker response timeout): execution 0b1381bb-d503-4ca3-bdf0-cadf9a519651. Initial new-test document dependency fixed with EventTarget doubles; narrow rerun passed.

Unfinished / requires parent verification:
- Dedicated inspector/controller/mock history tests, React StrictMode lifetime integration tests and actual browser audio proof.
- Mock uses existing snapshot history; explicit RestoreClipFades replay path not added. Public private-inverse rejection preserved. General final-state fade validation after trim/speed/split must be audited.
- Audio-track-only ProgramMonitor layers remain unsupported by existing video-only layer construction; metadata-based inspector supports audio and video media selections.
- Graph gesture activation currently wired through playback command callback; verify command dispatch is exclusively gesture-originated. Resume rejection is visible.
- Inspect source/final mode swaps, hidden layers, primary clock changes, paused seeks and CORS in real WebView. No claims of browser/native/export proof.
- Inspector draft changes remain local (not previewed until Apply). Focus repair implemented but not interaction-tested. Styling uses existing classes; no layout redesign.
