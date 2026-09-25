// Field names consumed by the existing bounded common-clock analyzer.
export function playQpcBounds(before, after) {
  if (!/^\d+$/.test(before) || !/^\d+$/.test(after)) throw Error("Invalid QPC acknowledgement");
  if (BigInt(after) < BigInt(before)) throw Error("Non-monotonic play acknowledgement");
  return { before, after };
}
