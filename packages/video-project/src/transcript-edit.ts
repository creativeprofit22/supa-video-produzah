export { mapTranscriptToSource, projectTranscriptToTimeline } from "./transcript-edit-mapping.js";
export type {
  ProjectTranscriptScopeInput,
  TranscriptFrameRange,
  TranscriptSourceWordMapping,
  TranscriptTimelineOccurrence,
  TranscriptTimelineProjection,
} from "./transcript-edit-mapping.js";
export {
  assertTranscriptEditProposalCurrent,
  createTranscriptEditProposal,
  parseTranscriptEditProposal,
  upgradeTranscriptEditProposal,
} from "./transcript-edit-proposal.js";
export type {
  AssertTranscriptEditProposalCurrentInput,
  CreateTranscriptEditProposalInput,
  TranscriptEditAssetIdentity,
  TranscriptEditDeletedRange,
  TranscriptEditGapSelection,
  TranscriptEditKeptRange,
  TranscriptEditProposal,
  TranscriptEditProposalV1,
  TranscriptEditWordSnapshot,
} from "./transcript-edit-proposal.js";
