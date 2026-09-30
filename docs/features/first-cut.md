# First cut (Produce panel)

The Produce panel turns a script (explainer) or the transcribed A-roll
(podcast) into a reviewable **first cut**. It assigns a ranked shot or an
explicit unresolved fallback to every **narrative beat**. Nothing reaches the
timeline until you press **Apply first cut**. That commits one command group,
and one Undo removes it. Code: `packages/video-produce`, `apps/desktop/src/video/ProducePanel.tsx`.

## Pipeline

1. **Beats.** `planBeatsFromScript` splits the script into sentences and times
   them at a fixed words-per-minute rate (default 150, minimum 1.5 s per beat).
   Directive lines set a typed **shot intent**: `# Title`, `Lower third: …`,
   `Map: …`, `Chart: …`, `Screenshot: …`, `Still: …`. Inline tags add
   constraints: `[show: a, b]`, `[avoid: c]`, `[portrait|landscape|square]`.
   `planBeatsFromTranscript` groups the A-roll clip's words into sentences
   (punctuation or a 0.7 s pause) using real word times. Beats are contiguous
   and cover the clip exactly. Model-proposed plans go through
   `acceptModelBeatPlan`, which checks shape strictly, clamps timestamps to the
   plan, trims overlaps, drops empty beats, fills gaps into the previous beat
   (a leading gap into the first beat, trailing time into the last) so the
   beats are contiguous and cover the plan exactly, and reports every repair.
   No live model producer is wired yet.
2. **Index.** `buildAssetIndex` covers project assets only. It indexes the
   normalized name, user tags, receipt title and transcript words. It is keyed
   by content identity (`sha256:<digest>`), so duplicate imports of the same
   bytes count as one medium. Embeddings are optional and come from an
   `EmbeddingSource` keyed by model id, version and content identity.
3. **Rights hard filter.** `filterByRights` runs before any scoring. Local
   imports pass as owned. Acquired media needs a receipt that matches its
   digest and passes the export release gate. That gate checks freshness,
   upstream changes and withdrawals, snapshots, attribution and intended-use
   policy. **Unknown licenses are always excluded**, even for private previews.
   Rejected media appears only in each beat's "Skipped media" audit, never as a
   choice.
4. **Ranking.** `rankCandidatesForBeat` is pure. It first applies hard
   constraints: must-not-show, must-show, the media being shorter than the
   beat, the reuse limit, near-duplicate source ranges and minimum relevance.
   It then scores semantic match, transcript match, embedding similarity,
   rights confidence, quality, orientation, duration fit and diversity. Owned
   media scores 1.0 for rights confidence, allowed stock 0.8 and warned stock
   0.5. Recent same-provider or same-visual-cluster shots lower the diversity
   score, and reuse adds a repetition penalty. Every offered shot carries
   human-readable explanation lines. Ties break by asset id, then source in.
5. **Proposal.** `planFirstCut` works greedily in beat order. Title and
   lower-third beats become caption cards. Map, chart, screenshot and
   still-motion beats become explicit unresolved notes. A must-show beat
   without matching media stays **unresolved**; it is never filled with a shot
   that lacks the term. Podcast beats keep the A-roll unless a cutaway clears a
   higher relevance bar (`cutawayMinRelevance`). Unresolved footage beats get a
   search suggestion for the Media search panel. Nothing is acquired
   automatically.
6. **Compile and apply.** `compileFirstCut` applies reviewer overrides (pick an
   alternative, or leave a beat unresolved). It emits one group containing a
   pre-populated `InsertTrack` "First cut" video track, an `InsertTrack` "First
   cut titles" caption track, and an orange `AddMarker` for each unresolved
   beat. It only appends, so existing clips, tracks and markers are never
   touched. `applyFirstCut` refuses to run if the project revision moved since
   planning, and Rust re-checks the base revision.

## Determinism

`proposalId` is the SHA-256 of canonical JSON covering: the schema, planner,
index and normalizer versions; the full ranking config; the embedding model;
project id and revision; workflow; intended use; beats (sorted by order); index
entries (sorted by asset id); and the per-asset rights decisions. The planning
clock and the receipts are not hashed directly; they affect the id only through
the rights decisions. The same inputs give byte-identical output regardless of
asset or receipt order. Changing any version string changes the id. Command and
entity ids come from `derivedUuid`, seeded with the proposal id, the overrides
and the sequence id.

## Rules

- Embedding similarity only adds to the relevance score. It never clears
  rights, never satisfies a must-show term and is not proof of quality.
- Only media already in the project is placed. Remote media must first go
  through the user-approved acquisition flow (Media search panel).
- There is no generated video and no autonomous publishing.

## Known gaps

- No visual or audio embedding model is bundled. Only the interface and
  fixture vectors exist.
- Maps, charts, screenshots and still-image motion are unresolved markers, not
  rendered graphics.
- Only the explainer and podcast workflows exist. There are no product-release
  or archive-documentary templates.
- Unapplied proposals are not persisted across restart. Applied cuts persist as
  normal project history.
- The panel does not yet read user tags or other assets' transcripts. The
  fixtures and the package API accept both.
- Podcast planning refuses A-roll clips whose speed has been changed.
- An applied first cut cannot be exported yet. Export only supports one
  direct-asset clip per video track, starting at timeline zero, with every
  track the same length; the first-cut track holds many clips at later start
  times. The Produce panel warns before applying, and undo removes the cut in
  one step.
