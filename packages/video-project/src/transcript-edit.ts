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
} from "./transcript-edit-proposal.js";
export type {
  AssertTranscriptEditProposalCurrentInput,
  CreateTranscriptEditProposalInput,
  TranscriptEditAssetIdentity,
  TranscriptEditDeletedRange,
  TranscriptEditKeptRange,
  TranscriptEditProposal,
  TranscriptEditWordSnapshot,
} from "./transcript-edit-proposal.js";
