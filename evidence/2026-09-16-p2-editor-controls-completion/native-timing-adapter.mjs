// Pure, non-recording adapter for the existing bounded capture components.
// Not an orchestration platform: caller must implement/verify the readiness protocol.
import path from "node:path";
import { classify } from "./step8-analysis.mjs";
import { title } from "./native-playback-check.mjs";

export function nativeCaptureArguments({ identity, executable, window, roi, directory, reader }) {
  if (
    !Number.isSafeInteger(identity?.pid) ||
    identity.pid <= 0 ||
    !/^\d+$/.test(identity.creation) ||
    !path.isAbsolute(executable) ||
    !path.isAbsolute(directory)
  )
    throw Error(
      "Retained root PID/creation/executable and absolute fresh output directory required",
    );
  if (
    window?.pid !== identity.pid ||
    !/^[1-9]\d*$/.test(window.handle) ||
    window.title !== title ||
    window.visible !== true ||
    window.iconic !== false
  )
    throw Error("Exact owned, tagged, visible, non-iconic HWND required");
  // These must come from an HWND/DPI geometry observation, NOT screenX/outerHeight guesses.
  if (
    !roi ||
    roi.coordinateSpace !== "WGC-window-physical-pixels" ||
    ![roi.x, roi.y, roi.side, window.width, window.height].every(Number.isSafeInteger) ||
    roi.x < 0 ||
    roi.y < 0 ||
    roi.side < 1 ||
    roi.side > 16 ||
    roi.x + roi.side > window.width ||
    roi.y + roi.side > window.height
  )
    throw Error("Verified window-relative ROI required");
  if (
    !Number.isSafeInteger(reader?.pid) ||
    reader.pid <= 0 ||
    !/^\d+$/.test(reader.creation) ||
    !path.isAbsolute(reader.executable)
  )
    throw Error("READER_WAITING retained identity required");
  return {
    guard: [
      String(identity.pid),
      identity.creation,
      executable,
      String(reader.pid),
      reader.creation,
      reader.executable,
    ],
    audio: [path.join(directory, "audio"), "3"],
    visual: [
      window.handle,
      String(identity.pid),
      path.join(directory, "visual"),
      String(roi.x),
      String(roi.y),
      String(roi.side),
      path.join(directory, "stop.marker"),
    ],
    protocol: [
      "READER_WAITING",
      "ISOLATION_READY",
      "WGC_READY",
      "fresh ROI black",
      "BEGIN_AUTHORIZED_CAPTURE",
      "LOOPBACK_READY",
      "AUDIO_PACKETS_READY",
      "QPC before / real UI Play / QPC after",
      "READER_CAPTURE_STOPPED + AUDIO_STOP_ACK",
      "write owned stop.marker / WGC exit 0",
      "guard stop / ISOLATION_STOPPED / exit 0",
      "EXIT_OWNED_READER / exit 0",
    ],
    scope: "three-second endpoint audio; exact-owned-window ROI; no microphone or foreign mutation",
  };
}

export function classifyNativeTiming(observation, hz, proof) {
  const qualified =
    proof?.freshControlsParentReviewed === true &&
    proof?.nativeIpc === true &&
    proof?.exactOwnedRoiVerified === true &&
    proof?.guardReadyAndStopped === true &&
    proof?.foreignUnmutedSessions === 0 &&
    proof?.mutationCalls === 0 &&
    proof?.ownedCleanupEmpty === true;
  return {
    ...classify(observation, { rn: 30, rd: 1 }, hz, qualified),
    scope: "Native WebView digital output only; not physical speaker/display timing",
    step9Done: false,
  };
}
