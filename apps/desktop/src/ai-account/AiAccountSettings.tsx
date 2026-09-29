import { ExternalLink, LogOut } from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";

import { tauriAiAccountClient, type AiAccountClient, type AiAccountStatus } from "./aiAccountIpc";

interface AiAccountSettingsProps {
  /** Status is loaded only while the surrounding settings dialog is open. */
  readonly active: boolean;
  readonly client?: AiAccountClient;
}

type Busy = "idle" | "loading" | "starting" | "submitting" | "signingOut";

/**
 * Settings section for AI account sign-in (a Claude plan account). Native code
 * enforces the terms acknowledgement and keeps tokens out of the renderer.
 */
export function AiAccountSettings({
  active,
  client = tauriAiAccountClient,
}: AiAccountSettingsProps) {
  const headingId = useId();
  const ackId = useId();
  const codeId = useId();
  const linkId = useId();
  const [status, setStatus] = useState<AiAccountStatus | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  // Only a display aid: whether the paste form shows comes from the backend's
  // `signInPending`, because the pending sign-in can expire or be consumed by a
  // failed exchange while this panel is closed or mounted.
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const applyStatus = useCallback((next: AiAccountStatus): void => {
    setStatus(next);
    if (!next.signInPending) {
      setAuthUrl(null);
      setCode("");
    }
  }, []);

  /** Reloads status from native code; returns the error message, if any. */
  const reloadStatus = useCallback(async (): Promise<string | null> => {
    const result = await client.status();
    if (!result.ok) return result.message;
    applyStatus(result.value);
    return null;
  }, [client, applyStatus]);

  const refresh = useCallback(async (): Promise<void> => {
    setBusy("loading");
    const failure = await reloadStatus();
    setBusy("idle");
    setError(failure);
  }, [reloadStatus]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const startSignIn = async (): Promise<void> => {
    setBusy("starting");
    setError(null);
    const result = await client.startSignIn(acknowledged);
    if (!result.ok) {
      setBusy("idle");
      setError(result.message);
      return;
    }
    setAuthUrl(result.value.authUrl);
    setCode("");
    const failure = await reloadStatus();
    setBusy("idle");
    setError(failure);
    setAnnouncement(
      result.value.browserOpened
        ? "Sign-in page opened in your browser. Paste the code it shows below."
        : "Copy the sign-in address below into your browser, then paste the code it shows.",
    );
  };

  const submitCode = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (code.trim().length === 0) {
      setError("Paste the sign-in code first");
      return;
    }
    setBusy("submitting");
    setError(null);
    const result = await client.submitCode(code.trim());
    if (!result.ok) {
      // A failed exchange may have consumed the pending sign-in (a wrong
      // state does not); let the backend decide whether the form stays.
      await reloadStatus();
      setBusy("idle");
      setError(result.message);
      return;
    }
    setBusy("idle");
    applyStatus(result.value);
    setAnnouncement("Claude account connected.");
  };

  const cancelSignIn = async (): Promise<void> => {
    const result = await client.cancelSignIn();
    const failure = await reloadStatus();
    setError(result.ok ? failure : result.message);
    setAnnouncement("Sign-in cancelled.");
  };

  const signOut = async (): Promise<void> => {
    setBusy("signingOut");
    setError(null);
    const result = await client.signOut();
    setBusy("idle");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    applyStatus({ connected: false, email: null, needsReauth: false, signInPending: false });
    setAnnouncement("Claude account signed out.");
  };

  const connected = status?.connected === true;
  const hasStoredAccount = connected || status?.needsReauth === true;
  const signInPending = status?.signInPending === true && !connected;
  const disabled = busy !== "idle";

  return (
    <section className="ai-account-settings" aria-labelledby={headingId}>
      <h3 id={headingId}>Claude account</h3>
      <p className="ai-account-status" role="status">
        {status === null
          ? busy === "loading"
            ? "Checking sign-in…"
            : "Sign-in status unavailable"
          : connected
            ? `Signed in${status.email === null ? "" : ` as ${status.email}`}`
            : status.needsReauth
              ? "Sign-in expired. Sign in again to keep using your Claude account."
              : "Not signed in"}
      </p>

      {connected ? null : (
        <>
          <div className="ai-account-terms">
            <input
              id={ackId}
              type="checkbox"
              checked={acknowledged}
              disabled={disabled}
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            />
            <label htmlFor={ackId}>
              I understand this signs in with Claude Code&apos;s app identity. Anthropic&apos;s
              terms do not allow third-party apps to do this, and my account could be limited or
              suspended. I accept that risk.
            </label>
          </div>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={!acknowledged || disabled}
            onClick={() => void startSignIn()}
          >
            <ExternalLink size={14} aria-hidden="true" />
            Open sign-in page
          </button>
        </>
      )}

      {signInPending ? (
        <form className="ai-account-code" onSubmit={(event) => void submitCode(event)}>
          {authUrl === null ? (
            <p className="ai-account-hint">
              A sign-in is waiting for its code. Paste the code shown in your browser, or cancel and
              open the sign-in page again.
            </p>
          ) : (
            <>
              <p className="ai-account-hint">
                If the browser did not open, copy this address into your browser. After approving,
                copy the code shown and paste it below.
              </p>
              <label htmlFor={linkId}>Sign-in address</label>
              <input
                id={linkId}
                type="text"
                readOnly
                value={authUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
            </>
          )}
          <label htmlFor={codeId}>Sign-in code</label>
          <input
            id={codeId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={code}
            disabled={disabled}
            onChange={(event) => setCode(event.currentTarget.value)}
          />
          <div className="ai-account-actions">
            <button className="primary-button compact-button" type="submit" disabled={disabled}>
              {busy === "submitting" ? "Connecting…" : "Connect"}
            </button>
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={disabled}
              onClick={() => void cancelSignIn()}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {hasStoredAccount ? (
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={disabled}
          onClick={() => void signOut()}
        >
          <LogOut size={14} aria-hidden="true" />
          Sign out
        </button>
      ) : null}

      {error === null ? null : (
        <p className="shortcut-error" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
