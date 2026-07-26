import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type DraftDiscardAction = "new" | "open" | "close";

interface DraftDiscardGuardOptions {
  readonly trimChanged: boolean;
  readonly onNewProject: () => Promise<void>;
  readonly onOpenProject: () => Promise<void>;
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

export function useDraftDiscardGuard({
  trimChanged,
  onNewProject,
  onOpenProject,
}: DraftDiscardGuardOptions) {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [pendingAction, setPendingAction] = useState<DraftDiscardAction | null>(null);
  const pendingActionRef = useRef<DraftDiscardAction | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepEditingButtonRef = useRef<HTMLButtonElement>(null);
  const trimChangedRef = useRef(trimChanged);
  const newProjectRef = useRef(onNewProject);
  const openProjectRef = useRef(onOpenProject);

  trimChangedRef.current = trimChanged;
  newProjectRef.current = onNewProject;
  openProjectRef.current = onOpenProject;

  const performAction = useCallback(
    async (action: DraftDiscardAction): Promise<void> => {
      if (action === "new") {
        await newProjectRef.current();
      } else if (action === "open") {
        await openProjectRef.current();
      } else {
        await appWindow.destroy();
      }
    },
    [appWindow],
  );

  const requestAction = useCallback(
    (action: DraftDiscardAction) => {
      if (!trimChangedRef.current) {
        void performAction(action);
        return;
      }
      if (pendingActionRef.current !== null) return;

      pendingActionRef.current = action;
      returnFocusRef.current = focusedElement();
      setPendingAction(action);
    },
    [performAction],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void appWindow
      .onCloseRequested((event) => {
        if (!trimChangedRef.current) return;
        event.preventDefault();
        requestAction("close");
      })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow, requestAction]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (pendingAction === null || dialog === null) return;

    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    keepEditingButtonRef.current?.focus();
  }, [pendingAction]);

  const closeDialog = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, []);

  const keepEditing = useCallback(() => {
    const returnFocus = returnFocusRef.current;
    pendingActionRef.current = null;
    returnFocusRef.current = null;
    setPendingAction(null);
    closeDialog();
    returnFocus?.focus();
  }, [closeDialog]);

  const discardDraft = useCallback(() => {
    const action = pendingActionRef.current;
    const returnFocus = returnFocusRef.current;
    if (action === null) return;

    pendingActionRef.current = null;
    returnFocusRef.current = null;
    setPendingAction(null);
    closeDialog();
    if (action !== "close" && returnFocus?.isConnected) returnFocus.focus();
    void performAction(action).finally(() => {
      if (action !== "close" && returnFocus?.isConnected) returnFocus.focus();
    });
  }, [closeDialog, performAction]);

  return {
    requestNewProject: () => requestAction("new"),
    requestOpenProject: () => requestAction("open"),
    discardDialog: (
      <dialog
        ref={dialogRef}
        className="overwrite-dialog discard-dialog"
        aria-labelledby="discard-trim-title"
        onCancel={(event) => {
          event.preventDefault();
          keepEditing();
        }}
      >
        <AlertCircle size={22} aria-hidden />
        <h2 id="discard-trim-title">Discard unsaved trim?</h2>
        <p>Your trim changes have not been applied. Discarding them will lose those values.</p>
        <div className="dialog-actions">
          <button
            ref={keepEditingButtonRef}
            className="secondary-button"
            type="button"
            onClick={keepEditing}
          >
            Keep editing
          </button>
          <button className="danger-button" type="button" onClick={discardDraft}>
            Discard draft
          </button>
        </div>
      </dialog>
    ),
  } as const;
}
