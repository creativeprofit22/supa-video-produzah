// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiAccountSettings } from "./AiAccountSettings";
import type { AiAccountClient, AiAccountResult, AiAccountStatus } from "./aiAccountIpc";

afterEach(cleanup);

const AUTH_URL = "https://claude.ai/oauth/authorize?code=true&state=abc";
const CONNECTED: AiAccountStatus = {
  connected: true,
  email: "me@example.com",
  needsReauth: false,
  signInPending: false,
};

type SubmitOutcome = "connect" | "wrongState" | "exchangeFailed";

/**
 * In-memory stand-in for the native commands. It keeps the pending sign-in
 * the way the real backend does: start sets it, success and cancel clear it,
 * a wrong state keeps it, and any other failed exchange consumes it.
 */
function fakeBackend(
  options: { readonly account?: AiAccountStatus; readonly submit?: SubmitOutcome } = {},
): { client: AiAccountClient; expirePendingSignIn: () => void } {
  let account: AiAccountStatus = options.account ?? {
    connected: false,
    email: null,
    needsReauth: false,
    signInPending: false,
  };
  let pending = false;
  const current = (): AiAccountStatus => ({ ...account, signInPending: pending });
  const client: AiAccountClient = {
    status: vi.fn(async (): Promise<AiAccountResult<AiAccountStatus>> => ({
      ok: true,
      value: current(),
    })),
    startSignIn: vi.fn(async () => {
      pending = true;
      return { ok: true as const, value: { authUrl: AUTH_URL, browserOpened: true } };
    }),
    submitCode: vi.fn(async (): Promise<AiAccountResult<AiAccountStatus>> => {
      switch (options.submit ?? "connect") {
        case "wrongState":
          return {
            ok: false,
            code: "invalidSignIn",
            message: "Sign-in state did not match; start sign-in again",
          };
        case "exchangeFailed":
          pending = false;
          return {
            ok: false,
            code: "unavailable",
            message: "Anthropic sign-in could not reach the provider",
          };
        case "connect":
          pending = false;
          account = CONNECTED;
          return { ok: true, value: current() };
      }
    }),
    cancelSignIn: vi.fn(async () => {
      pending = false;
      return { ok: true as const, value: null };
    }),
    signOut: vi.fn(async () => {
      pending = false;
      account = { connected: false, email: null, needsReauth: false, signInPending: false };
      return { ok: true as const, value: null };
    }),
  };
  return {
    client,
    expirePendingSignIn: () => {
      pending = false;
    },
  };
}

async function startSignIn(): Promise<void> {
  await screen.findByText("Not signed in");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Open sign-in page" }));
  await screen.findByLabelText("Sign-in code");
}

describe("AiAccountSettings", () => {
  it("keeps sign-in disabled until the terms risk is acknowledged", async () => {
    const { client } = fakeBackend();
    render(<AiAccountSettings active client={client} />);

    expect(await screen.findByText("Not signed in")).toBeTruthy();
    const open = screen.getByRole("button", { name: "Open sign-in page" });
    expect(open).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(open).toHaveProperty("disabled", false);
    fireEvent.click(open);

    await waitFor(() => expect(client.startSignIn).toHaveBeenCalledWith(true));
  });

  it("connects with a pasted code and shows the account", async () => {
    const { client } = fakeBackend();
    render(<AiAccountSettings active client={client} />);
    await startSignIn();

    const address = screen.getByLabelText("Sign-in address");
    expect((address as HTMLInputElement).value).toBe(AUTH_URL);
    fireEvent.change(screen.getByLabelText("Sign-in code"), {
      target: { value: "  code123#state456 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Signed in as me@example.com")).toBeTruthy();
    expect(client.submitCode).toHaveBeenCalledWith("code123#state456");
    expect(screen.queryByLabelText("Sign-in code")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("keeps the code field after a wrong state, because the backend still waits", async () => {
    const { client } = fakeBackend({ submit: "wrongState" });
    render(<AiAccountSettings active client={client} />);
    await startSignIn();
    fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "code#wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-in state did not match; start sign-in again",
    );
    expect(screen.getByLabelText("Sign-in code")).toBeTruthy();
  });

  it("hides the code field but keeps the error when a failed exchange used up the sign-in", async () => {
    const { client } = fakeBackend({ submit: "exchangeFailed" });
    render(<AiAccountSettings active client={client} />);
    await startSignIn();
    fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "code#abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Anthropic sign-in could not reach the provider",
    );
    expect(screen.queryByLabelText("Sign-in code")).toBeNull();
    expect(screen.getByRole("button", { name: "Open sign-in page" })).toBeTruthy();
  });

  it("reopening settings mid-sign-in keeps the code field while the backend still waits", async () => {
    const { client } = fakeBackend();
    const { rerender } = render(<AiAccountSettings active client={client} />);
    await startSignIn();

    rerender(<AiAccountSettings active={false} client={client} />);
    rerender(<AiAccountSettings active client={client} />);

    await waitFor(() => expect(client.status).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Sign-in code")).toBeTruthy();
    expect((screen.getByLabelText("Sign-in address") as HTMLInputElement).value).toBe(AUTH_URL);
  });

  it("reopening settings after the sign-in expired hides the stale code field", async () => {
    const { client, expirePendingSignIn } = fakeBackend();
    const { rerender } = render(<AiAccountSettings active client={client} />);
    await startSignIn();

    rerender(<AiAccountSettings active={false} client={client} />);
    expirePendingSignIn();
    rerender(<AiAccountSettings active client={client} />);

    await waitFor(() => expect(screen.queryByLabelText("Sign-in code")).toBeNull());
    expect(screen.queryByLabelText("Sign-in address")).toBeNull();
    expect(screen.getByText("Not signed in")).toBeTruthy();
  });

  it("a freshly mounted panel picks up a sign-in the backend is still waiting on", async () => {
    const { client } = fakeBackend();
    const first = render(<AiAccountSettings active client={client} />);
    await startSignIn();
    first.unmount();

    render(<AiAccountSettings active client={client} />);

    expect(await screen.findByLabelText("Sign-in code")).toBeTruthy();
    expect(screen.getByText(/A sign-in is waiting for its code/)).toBeTruthy();
    expect(screen.queryByLabelText("Sign-in address")).toBeNull();
  });

  it("cancel clears the pending sign-in on both sides", async () => {
    const { client } = fakeBackend();
    render(<AiAccountSettings active client={client} />);
    await startSignIn();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByLabelText("Sign-in code")).toBeNull());
    expect(client.cancelSignIn).toHaveBeenCalledTimes(1);
  });

  it("asks to sign in again when the stored account needs reconnecting, and signs out", async () => {
    const { client } = fakeBackend({
      account: {
        connected: false,
        email: "me@example.com",
        needsReauth: true,
        signInPending: false,
      },
    });
    render(<AiAccountSettings active client={client} />);

    expect(await screen.findByText(/Sign-in expired/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Not signed in")).toBeTruthy();
    expect(client.signOut).toHaveBeenCalledTimes(1);
  });

  it("does not load status while inactive", () => {
    const { client } = fakeBackend();
    render(<AiAccountSettings active={false} client={client} />);
    expect(client.status).not.toHaveBeenCalled();
  });
});
