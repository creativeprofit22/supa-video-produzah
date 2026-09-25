# Steps 6–7: bounded digital capture and calibration review

## Scope and retained failures

Conditional user permission covers endpoint recording only after test-only isolation, no microphone, foreign-session mutation, desktop-wide video or uploads. The new completion path uses the exact owned-window WGC ROI, read-only session notifications/endpoint identity checks and audio-only WASAPI loopback. It does not invoke the older guardian's mutating entry point. Old evidence and original recordings/results remain unchanged.

Execution `8ff329b8-ee76-4052-9409-48c0dc8ed046` compiled the completion audio reader and recorded `capture-rsUpcY`; its command **exited 1**. The initial analyzer classified all three controls inconclusive. This failure is retained, not rewritten as a successful command. Earlier `capture-cUIXeK` remains inconclusive, including synchronized interval [-38.435, -5.921] ms outside the unchanged ±33.333 ms gate.

## Reproduced protocol defect and offline repair

The completion writer emitted `beforePlayQpcTicks`/`afterPlayQpcTicks`, but the unchanged historical analyzer reads `before`/`after`. The missing `before` became NaN, so the existing first-packet/pre-play discontinuity check could never pass. The original unit test incorrectly repeated the writer's field names rather than the consumer contract.

Corrected regression failed before repair (`d954dd6f-2ef9-420b-a7ea-59b6d94953f4`, exit 1). Writer now emits the analyzer's actual field names, without changing clock values. Both protocol tests passed in `3d624566-8b55-406c-b6f9-c85370e1b34f`; that combined command still exited 1 because its first replay driver assumed both historical recordings had the same schema. The driver was corrected to distinguish those two known schemas explicitly.

Offline replay `fec604a2-a231-41d9-9641-07691d4f6efe`, exit 0, creates fresh derived directories and records SHA-256 for every original input. No recording occurs. No original file is edited. `capture-replay-3biFGE` retains the older inconclusive classification. `capture-replay-Vh0nBF` replays the latest samples through the unchanged analyzer with only timestamp field names adapted and returns **candidate-pass-parent-review-required**.

## Parent review of actual capture

Independent review `1d38a12d-2c5e-4225-b5bc-e093b2cb523d`, exit 0:

- Each condition has `ISOLATION_READY` then `ISOLATION_STOPPED`, mutationCalls=0.
- Each reader acknowledged 2,400 pre-play frames with peak 1.4e-9, normal audio stop, then reader stop. The first packet ended 37.451 / 35.949 / 39.189 ms before the pre-click lower bound for sync / late / early. The existing discontinuity exception therefore applies; there is no later discontinuity, TimestampError or device-position gap.
- All three decoded sources have exactly 60 frames, three bright frames, one flash and one sound. Decoded audio-minus-video offsets: +0.0208 / +100.0208 / -99.9792 ms.
- All captured conditions have exactly one detected sound and one visual onset; no unmatched detected event is discarded. Raw packet/frame observations are retained.
- WGC and audio each remained under the unchanged six-second recording bound (approximately three seconds). Audio stopped before WGC close, with normal stop marker acknowledged.
- Owned browser lifecycle ends with job-active-process-zero proof, `closed` with rootExit=0/empty=true, then launcher exit 0.

| Control       | Captured audio-minus-visual interval, ms | Unchanged decision                            |
| ------------- | ---------------------------------------- | --------------------------------------------- |
| Synchronized  | [-32.668233, -6.235033]                  | Entire interval inside ±33.333333 ms          |
| Audio +100 ms | [75.853767, 110.306667]                  | Reject synchronization, correct positive sign |
| Audio -100 ms | [-119.418333, -92.153233]                | Reject synchronization, correct negative sign |

The interval retains all six previous-dark/current-bright compositor/acquisition/readback timestamps, plus the analyzer's existing ±1 ms audio-onset uncertainty. No latency or offset subtraction, event removal or tolerance change. Future-valued compositor timestamps remain in the interval, not silently interpreted as physical display time. Synchronized margin is only about 0.665 ms; this is not a robustness or universal timing claim.

**Steps 6–7 are supported for this actual bounded digital calibration**, after offline protocol correction and parent review. This establishes a usable measurement route, not production preview/final timing acceptance. Step 8 must use that route against production behavior; native changed-flow timing, remaining ordinary-browser failures and human keyboard checks remain separate open gates. No physical speaker/display timing claim, certification, or Roadmap Done authorization.

Roadmap inspection: revision 186. V2 acquire rejected plan-mismatch; V1 bind-current reported already-bound to session `5372ef14-9d57-4ff3-8920-e3c1edf2f7bd`. No takeover or direct Notes write performed. Current progress must not be reported as persisted to Roadmap until its binding is authorized.
