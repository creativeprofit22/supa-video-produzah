# 0005 — Agent graphics arrive as add-only graphics proposals

Phase 19 lets an agent (a model or a rule) put titles, lower thirds, end cards and short captions on the timeline. It reuses the proposal flow that transcript cuts already use, so nothing changes until the user approves.

**Compact input.** Agents never write graphics clips directly. They write an agent graphics description (`agentGraphicsDescriptionSchema`, `packages/video-contracts`): `schemaVersion: 1`, an optional `recipeId`, and up to 64 items. Each item is a `card` (role `title` / `lowerThird` / `endCard`) or a `caption`, with an id, text, an integer-microsecond start, an optional duration, and optional `preset` / `reveal` / `fontKey` / `colour` overrides. The schema is strict, so unknown fields are rejected. Layout, layers, keyframes and ids are not agent-writable.

**Compiler and recipes, split by package.** `compileAgentGraphics` (`@supa-video/project`) takes the description plus already-resolved `GraphicsStyleDefaults` (font, palette, preset per card role, caption reveal, default duration, overlap limit). It returns either a graphics proposal or a typed error: `invalid_description` (with Zod issue paths), `out_of_sequence`, `overlap_limit`, `text_too_long` or `too_large` (the command group or whole proposal would exceed the native submit byte limits, mirrored in `@supa-video/contracts`; measured approximately with `JSON.stringify` and some headroom). It builds layers through the existing motion presets and text reveal, and takes ids from an injected source, so output is deterministic. Style recipes (`punchy-short-form`, `calm-explainer`, `retro`) live in `@supa-video/produce`. There, `proposeRecipeGraphics` resolves `recipeId` (default `calm-explainer`; unknown ids give `unknown_recipe`) to defaults and calls the compiler. Dependencies stay one-way (contracts ← project ← produce ← desktop): project never sees a recipe id.

**Proposal kind.** `graphicsProposalV1WireSchema` (`proposalKind: "graphics"`) has the same envelope as transcript proposals (ids, project, base revision, producer). It adds the description for display, `items: [{ itemId, label, graphicsClipId }]`, and a command group. The stored proposal union is transcript v2 | graphics v1, and old stores parse unchanged.

**Add-only command policy (Rust `validate_graphics_proposal`).** The group may hold at most one leading `InsertTrack`, which must create the proposal's target track as an empty, unlocked, visible graphics track. After that come only `AddGraphicsClip` commands on that track, one per item, in item order, with matching clip ids. If the target track already exists, it must be an unlocked graphics track, and an `InsertTrack` is refused. `RemoveGraphicsClip`, `SetGraphicsClipLayers` and every non-graphics command are refused. Transcript proposals still refuse every graphics command.

**Byte-equal subset apply.** Partial approval re-derives the proposal from the accepted items (`deriveApprovedGraphicsProposal`). The accepted commands are kept byte-for-byte, and the proposal and group ids are fresh. At apply, native code checks three things:

- every approved item is one the stored proposal offered;
- every approved command is canonically byte-equal to one it offered;
- the producer, sequence and track match.

So an agent cannot slip a changed clip in between review and apply. The checkpoint, journaled audit, restore and stale/expiry logic are shared with transcript proposals. The audit's `approvedRangeIds` holds the item ids, and `affectedRanges` holds the clip spans.

**Review.** The proposals panel lists one row per graphic (label and time span, ticked by default) with "Apply N of M", "Reject all" and "Restore to before". Once a first cut has been applied, "Suggest graphics" runs the recipe rule producer (`proposeFirstCutGraphics`) with the selected recipe and submits the result as a pending proposal.

Rejected: letting agents send `AddGraphicsClip` inside transcript proposals, because one review unit would mix cuts and graphics and widen the transcript allow-list. Also rejected: recipe lookup inside `@supa-video/project`, because it would create a project → produce dependency cycle. Also rejected: agent-writable layers or keyframes, because they are too large to review and too easy to get unreadable; recipes and presets keep the look consistent and the description small.
