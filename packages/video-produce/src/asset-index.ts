import type { AcquisitionReceipt, VideoAsset } from "@supa-video/contracts";

import type { TranscriptWordInput } from "./plan-beats.js";
import { TEXT_NORMALIZER_VERSION, normalizeTokens } from "./text-normalize.js";

/*
 * Local asset index for first-cut retrieval. Entries are keyed by content
 * identity (sha256 digest of the media bytes) when known, else by project asset
 * id. Embeddings are optional, come from an injected source keyed by model id,
 * model version and content identity, and are never rights or quality proof.
 */

export const ASSET_INDEX_VERSION = "asset-index/1";

export type AssetOrientation = "landscape" | "portrait" | "square";
export type AssetProvenance = "owned" | "acquired";

export interface EmbeddingSource {
  readonly modelId: string;
  readonly modelVersion: string;
  /** Vector for media with this content identity key, or null when not embedded. */
  vectorForContent(identityKey: string): readonly number[] | null;
  /** Vector for beat text in the same space, or null. */
  vectorForText(text: string): readonly number[] | null;
  /** Visual cluster used for diversity, or null. */
  clusterForContent(identityKey: string): string | null;
}

export interface IndexedTranscriptWord {
  readonly token: string;
  readonly startUs: number;
}

export interface LocalAssetIndexEntry {
  readonly assetId: string;
  readonly displayName: string;
  readonly identityKey: string;
  readonly contentDigest: string | null;
  readonly provenance: AssetProvenance;
  readonly acquisitionReceiptId: string | null;
  readonly providerId: string;
  readonly durationUs: number;
  readonly width: number;
  readonly height: number;
  readonly orientation: AssetOrientation;
  readonly variableFrameRate: boolean;
  readonly descriptorTokens: readonly string[];
  readonly transcriptTokens: readonly string[];
  readonly transcriptWords: readonly IndexedTranscriptWord[];
  readonly embedding: readonly number[] | null;
  readonly visualClusterId: string | null;
}

export interface LocalAssetIndex {
  readonly indexVersion: typeof ASSET_INDEX_VERSION;
  readonly normalizerVersion: typeof TEXT_NORMALIZER_VERSION;
  readonly embeddingModel: { readonly modelId: string; readonly modelVersion: string } | null;
  readonly entries: readonly LocalAssetIndexEntry[];
}

export interface AssetTranscriptInput {
  readonly assetId: string;
  readonly language: string;
  readonly words: readonly TranscriptWordInput[];
}

export interface BuildAssetIndexInput {
  readonly assets: readonly VideoAsset[];
  readonly receipts: readonly AcquisitionReceipt[];
  /** User tags per asset id. */
  readonly tags?: Readonly<Record<string, readonly string[]>>;
  readonly transcripts?: readonly AssetTranscriptInput[];
  readonly embeddings?: EmbeddingSource | null;
}

export function orientationOf(width: number, height: number): AssetOrientation {
  if (width > height * 1.05) return "landscape";
  if (height > width * 1.05) return "portrait";
  return "square";
}

export function identityKeyOf(asset: Pick<VideoAsset, "id" | "contentIdentity">): string {
  return asset.contentIdentity === undefined
    ? `asset:${asset.id}`
    : `sha256:${asset.contentIdentity.digest}`;
}

function receiptFor(
  asset: VideoAsset,
  receipts: readonly AcquisitionReceipt[],
): AcquisitionReceipt | null {
  const claimed = asset.origin?.acquisitionReceiptId;
  if (claimed !== undefined) return receipts.find((r) => r.receiptId === claimed) ?? null;
  const digest = asset.contentIdentity?.digest;
  if (digest === undefined) return null;
  return (
    [...receipts]
      .filter((r) => r.content.digest === digest)
      .sort((a, b) => (a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0))[0] ??
    null
  );
}

export function buildAssetIndex(input: BuildAssetIndexInput): LocalAssetIndex {
  const embeddings = input.embeddings ?? null;
  const entries = input.assets.map((asset): LocalAssetIndexEntry => {
    const receipt = receiptFor(asset, input.receipts);
    const acquired = asset.origin !== undefined || receipt !== null;
    const identityKey = identityKeyOf(asset);
    const descriptorText = [
      asset.displayName,
      ...(input.tags?.[asset.id] ?? []),
      receipt?.attribution.title ?? "",
    ].join(" ");
    const transcriptWords = (input.transcripts ?? [])
      .filter((transcript) => transcript.assetId === asset.id)
      .flatMap((transcript) =>
        transcript.words.flatMap((word) =>
          normalizeTokens(word.text, transcript.language).map((token) => ({
            token,
            startUs: word.sourceStartUs,
          })),
        ),
      )
      .sort(
        (a, b) => a.startUs - b.startUs || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0),
      );
    return {
      assetId: asset.id,
      displayName: asset.displayName,
      identityKey,
      contentDigest: asset.contentIdentity?.digest ?? null,
      provenance: acquired ? "acquired" : "owned",
      acquisitionReceiptId: asset.origin?.acquisitionReceiptId ?? receipt?.receiptId ?? null,
      providerId: receipt?.providerId ?? (acquired ? "unknown-provider" : "local"),
      durationUs: asset.probe.durationMicroseconds,
      width: asset.probe.width,
      height: asset.probe.height,
      orientation: orientationOf(asset.probe.width, asset.probe.height),
      variableFrameRate: asset.probe.variableFrameRate,
      descriptorTokens: normalizeTokens(descriptorText),
      transcriptTokens: [...new Set(transcriptWords.map((word) => word.token))].sort(),
      transcriptWords,
      embedding: embeddings?.vectorForContent(identityKey) ?? null,
      visualClusterId: embeddings?.clusterForContent(identityKey) ?? null,
    };
  });
  return {
    indexVersion: ASSET_INDEX_VERSION,
    normalizerVersion: TEXT_NORMALIZER_VERSION,
    embeddingModel:
      embeddings === null
        ? null
        : { modelId: embeddings.modelId, modelVersion: embeddings.modelVersion },
    entries: entries.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0)),
  };
}

export interface FixtureEmbeddingData {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly content: Readonly<Record<string, readonly number[]>>;
  readonly text: Readonly<Record<string, readonly number[]>>;
  readonly clusters: Readonly<Record<string, string>>;
}

/** Deterministic in-memory source for fixtures and tests; ships no model. */
export function fixtureEmbeddingSource(data: FixtureEmbeddingData): EmbeddingSource {
  return {
    modelId: data.modelId,
    modelVersion: data.modelVersion,
    vectorForContent: (key) => data.content[key] ?? null,
    vectorForText: (text) => data.text[text] ?? null,
    clusterForContent: (key) => data.clusters[key] ?? null,
  };
}
