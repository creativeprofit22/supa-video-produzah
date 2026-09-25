import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  commandGroupRequestSchema,
  commandResultSchema,
  projectProjectionSchema,
  mediaProbeSchema,
} from "../../packages/video-contracts/dist/index.js";
import { preparedVideoAssetSchema } from "../../packages/video-media/dist/index.js";
import { invokeNative, pickNative, submitOwnedPicker } from "./native-picker.mjs";
export async function createNativeFixture(session, fixture) {
  const directory = path.join(session.run, `${fixture.kind}-${fixture.sequence.rate.numerator}`);
  mkdirSync(directory);
  const file = path.join(directory, "project.svpvideo");
  await pickNative(
    session,
    "video_pick_new_project_path",
    { defaultName: "P2 evidence.svpvideo" },
    file,
  );
  const created = projectProjectionSchema.parse(
    await invokeNative(session.page, "video_create_project", {
      path: file,
      name: `P2 ${fixture.kind}`,
    }),
  );
  const assets = [];
  for (const asset of fixture.projection.state.assets) {
    await pickNative(session, "video_pick_source", {}, asset.locator.absolutePath);
    const probe = mediaProbeSchema.parse(
      await invokeNative(session.page, "video_probe_media", { path: asset.locator.absolutePath }),
    );
    assets.push({ ...asset, probe });
  }
  const request = commandGroupRequestSchema.parse({
    projectId: created.projectId,
    baseRevision: created.revision.number,
    groupId: randomUUID(),
    commands: [
      ...assets.map((asset) => ({ type: "ImportAsset", commandId: randomUUID(), asset })),
      {
        type: "CreateSequence",
        commandId: randomUUID(),
        sequence: fixture.sequence,
        activeSequenceId: fixture.sequence.id,
      },
    ],
  });
  const result = commandResultSchema.parse(
    await invokeNative(session.page, "video_execute_project_group", { request }),
  );
  const prepared = {},
    preparation = [];
  for (const asset of assets) {
    const start = Date.now();
    prepared[asset.id] = preparedVideoAssetSchema.parse(
      await invokeNative(session.page, "video_prepare_asset", {
        projectId: created.projectId,
        assetId: asset.id,
        path: asset.locator.absolutePath,
        sequenceRate: fixture.sequence.rate,
      }),
    );
    preparation.push({ assetId: asset.id, elapsedMs: Date.now() - start });
  }
  await invokeNative(session.page, "video_close_project", { projectId: created.projectId });
  await session.page.getByRole("button", { name: "Open project", exact: true }).click();
  submitOwnedPicker(session, file);
  await session.page.locator(".transport-play").waitFor({ state: "visible", timeout: 30000 });
  await session.page.waitForFunction(
    () => globalThis.__p2SeekTo && !globalThis.document.querySelector(".transport-play")?.disabled,
    undefined,
    { timeout: 30000 },
  );
  return {
    file,
    projection: result.projection,
    prepared,
    preparation,
    fixtureSha256: fixture.fixtureSha256,
  };
}
