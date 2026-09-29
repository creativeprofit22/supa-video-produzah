import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/** Connection status of the signed-in Claude account. Tokens never reach the renderer. */
const aiAccountStatusSchema = z
  .object({
    connected: z.boolean(),
    email: z.string().max(320).nullable(),
    needsReauth: z.boolean(),
    signInPending: z.boolean(),
  })
  .strict();

const startSignInResultSchema = z
  .object({
    authUrl: z
      .string()
      .max(4096)
      .refine((value) => value.startsWith("https://claude.ai/oauth/authorize?"), {
        message: "Unexpected sign-in address",
      }),
    browserOpened: z.boolean(),
  })
  .strict();

const aiAccountErrorSchema = z.object({
  code: z.enum([
    "notSignedIn",
    "needsReauth",
    "termsNotAcknowledged",
    "invalidSignIn",
    "unavailable",
    "request",
  ]),
  message: z.string().max(1000),
});

export type AiAccountStatus = Readonly<z.infer<typeof aiAccountStatusSchema>>;
export type StartSignInResult = Readonly<z.infer<typeof startSignInResultSchema>>;
export type AiAccountErrorCode = z.infer<typeof aiAccountErrorSchema>["code"];

export type AiAccountResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: AiAccountErrorCode | "invalidResponse";
      readonly message: string;
    };

/** The native commands the settings panel uses; injectable for tests. */
export interface AiAccountClient {
  status(): Promise<AiAccountResult<AiAccountStatus>>;
  startSignIn(acknowledged: boolean): Promise<AiAccountResult<StartSignInResult>>;
  submitCode(code: string): Promise<AiAccountResult<AiAccountStatus>>;
  cancelSignIn(): Promise<AiAccountResult<null>>;
  signOut(): Promise<AiAccountResult<null>>;
}

const INVALID_RESPONSE = "The desktop service returned an invalid response";

function failure(error: unknown): AiAccountResult<never> {
  const parsed = aiAccountErrorSchema.safeParse(error);
  if (parsed.success) {
    return { ok: false, code: parsed.data.code, message: parsed.data.message };
  }
  return { ok: false, code: "unavailable", message: "The desktop command failed unexpectedly" };
}

async function call<T>(
  command: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>,
): Promise<AiAccountResult<T>> {
  let response: unknown;
  try {
    response = await invoke<unknown>(command, args);
  } catch (error) {
    return failure(error);
  }
  const parsed = schema.safeParse(response);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, code: "invalidResponse", message: INVALID_RESPONSE };
}

export const tauriAiAccountClient: AiAccountClient = {
  status: async () => await call("ai_account_status", aiAccountStatusSchema),
  startSignIn: async (acknowledged) =>
    await call("ai_account_start_sign_in", startSignInResultSchema, {
      request: { acknowledged },
    }),
  submitCode: async (code) =>
    await call("ai_account_submit_code", aiAccountStatusSchema, { request: { code } }),
  cancelSignIn: async () => await call("ai_account_cancel_sign_in", z.null()),
  signOut: async () => await call("ai_account_sign_out", z.null()),
};
