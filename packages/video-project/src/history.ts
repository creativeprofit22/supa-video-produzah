import { type VideoProjectFileV1, videoProjectFileV1Schema } from "@supa-video/contracts";

import { executeCommand } from "./execute-command.js";
import { deepFreeze } from "./freeze.js";

export interface ProjectHistory {
  readonly document: Readonly<VideoProjectFileV1>;
  readonly cursor: number;
}

function withCursor(history: ProjectHistory, cursor: number): Readonly<ProjectHistory> {
  const revision = history.document.revisions[cursor];
  if (revision === undefined) {
    return history;
  }
  const document = videoProjectFileV1Schema.parse({
    ...history.document,
    currentRevisionId: revision.id,
  });
  return deepFreeze({ document, cursor });
}

export function createHistory(document: Readonly<VideoProjectFileV1>): Readonly<ProjectHistory> {
  const validDocument = videoProjectFileV1Schema.parse(document);
  const cursor = validDocument.revisions.findIndex(
    (revision) => revision.id === validDocument.currentRevisionId,
  );
  return deepFreeze({ document: validDocument, cursor });
}

export function canUndo(history: ProjectHistory): boolean {
  return history.cursor > 0;
}

export function canRedo(history: ProjectHistory): boolean {
  return history.cursor < history.document.revisions.length - 1;
}

export function undo(history: ProjectHistory): Readonly<ProjectHistory> {
  return canUndo(history) ? withCursor(history, history.cursor - 1) : history;
}

export function redo(history: ProjectHistory): Readonly<ProjectHistory> {
  return canRedo(history) ? withCursor(history, history.cursor + 1) : history;
}

export function commit(history: ProjectHistory, command: unknown): Readonly<ProjectHistory> {
  const document = executeCommand(history.document, command);
  return deepFreeze({ document, cursor: document.revisions.length - 1 });
}
