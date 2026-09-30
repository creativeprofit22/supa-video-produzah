import {
  acquireRequestSchema,
  providerStatusSchema,
  receiptIdRequestSchema,
  receiptInspectionSchema,
  receiptListSchema,
  rightsAcquireResponseSchema,
  rightsSearchRequestSchema,
  rightsSearchResponseSchema,
  acquisitionReceiptSchema,
} from "@supa-video/contracts";
import type {
  AcquireRequest,
  AcquisitionReceipt,
  ProviderStatus,
  ReceiptInspection,
  RightsAcquireResponse,
  RightsSearchRequest,
  RightsSearchResponse,
} from "@supa-video/contracts";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { normalizeVideoCommandError, VideoIpcResponseError } from "./video-ipc";

/*
 * Rights IPC. Every request is validated before it leaves the renderer and
 * every response is validated before the UI sees it. Rust remains the rights
 * authority: the acquire request carries ids and the intended use only.
 */

async function invokeRightsCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    throw normalizeVideoCommandError(error);
  }
}

function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) {
    throw new VideoIpcResponseError();
  }
  return result.data;
}

export async function searchRights(request: RightsSearchRequest): Promise<RightsSearchResponse> {
  const validated = rightsSearchRequestSchema.parse(request);
  const response = await invokeRightsCommand("rights_search", { request: validated });
  const result = parsed(rightsSearchResponseSchema.safeParse(response));
  if (result.providerId !== validated.providerId) {
    throw new VideoIpcResponseError();
  }
  return result;
}

export async function getProviderStatus(): Promise<readonly ProviderStatus[]> {
  const response = await invokeRightsCommand("rights_provider_status");
  return parsed(z.array(providerStatusSchema).readonly().safeParse(response));
}

export async function acquireRights(request: AcquireRequest): Promise<RightsAcquireResponse> {
  const validated = acquireRequestSchema.parse(request);
  const response = await invokeRightsCommand("rights_acquire", { request: validated });
  const result = parsed(rightsAcquireResponseSchema.safeParse(response));
  if (
    result.receipt.providerId !== validated.providerId ||
    result.receipt.providerItemId !== validated.providerItemId ||
    result.receipt.projectId !== validated.projectId
  ) {
    throw new VideoIpcResponseError();
  }
  return result;
}

export async function cancelRightsAcquire(): Promise<boolean> {
  const response = await invokeRightsCommand("rights_cancel_acquire");
  return parsed(z.boolean().safeParse(response));
}

export async function refreshRightsReceipt(receiptId: string): Promise<AcquisitionReceipt> {
  const request = receiptIdRequestSchema.parse({ receiptId });
  const response = await invokeRightsCommand("rights_refresh_receipt", { request });
  const receipt = parsed(acquisitionReceiptSchema.safeParse(response));
  if (receipt.receiptId !== receiptId) {
    throw new VideoIpcResponseError();
  }
  return receipt;
}

export async function inspectRightsReceipt(receiptId: string): Promise<ReceiptInspection> {
  const request = receiptIdRequestSchema.parse({ receiptId });
  const response = await invokeRightsCommand("rights_inspect_receipt", { request });
  const inspection = parsed(receiptInspectionSchema.safeParse(response));
  if (inspection.receipt.receiptId !== receiptId) {
    throw new VideoIpcResponseError();
  }
  return inspection;
}

export async function listRightsReceipts(
  projectId: string | null,
): Promise<readonly AcquisitionReceipt[]> {
  const request = z.object({ projectId: z.uuid().nullable() }).strict().parse({ projectId });
  const response = await invokeRightsCommand("rights_list_receipts", { request });
  return parsed(receiptListSchema.safeParse(response));
}

export interface RightsBackend {
  readonly searchRights: typeof searchRights;
  readonly getProviderStatus: typeof getProviderStatus;
  readonly acquireRights: typeof acquireRights;
  readonly cancelRightsAcquire: typeof cancelRightsAcquire;
  readonly refreshRightsReceipt: typeof refreshRightsReceipt;
  readonly inspectRightsReceipt: typeof inspectRightsReceipt;
  readonly listRightsReceipts: typeof listRightsReceipts;
}

export const tauriRightsBackend = {
  searchRights,
  getProviderStatus,
  acquireRights,
  cancelRightsAcquire,
  refreshRightsReceipt,
  inspectRightsReceipt,
  listRightsReceipts,
} as const satisfies RightsBackend;
