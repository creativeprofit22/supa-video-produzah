# 0001 — Audio fades use exact output sequence frames

Canonical clip gain already uses integer milli-decibels; speed changes the duration of the output timeline without changing the source range. Fades need persistent, reversible semantics that agree across inspector, preview and export.

Audio fades are optional clip state with nonnegative integer fade-in/out durations in output sequence frames. The amplitude ramps are linear. Their sum must not exceed the exact retimed clip duration. Setting both to zero removes the optional field; private history restoration preserves its prior representation. Speed, trim or other edits that would invalidate the envelope reject atomically rather than silently changing fades.

Source-frame fades were rejected because their audible duration would change with speed even when the user left the displayed envelope unchanged. Floating-point seconds were rejected because canonical frame boundaries must remain exact. This choice does not introduce automatic gain normalization, transitions between clips or nonlinear fade curves.
