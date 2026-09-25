// Calibration-only, Preview-only, or the existing ordered pair (+ optional source).
export function validateTargetNames(names) {
  const supported = [[], ["preview"], ["preview", "final"], ["preview", "final", "source"]];
  if (
    !Array.isArray(names) ||
    !supported.some(
      (allowed) => allowed.length === names.length && allowed.every((name, i) => names[i] === name),
    )
  )
    throw Error(
      "Unsupported capture targets: expected calibration-only, Preview-only, or Preview/Final with optional source",
    );
  return names;
}
