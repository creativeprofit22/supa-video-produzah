// Preserve incomplete evidence from a worker killed while writing its trace.
export function summarizeTrace(text) {
  const events = [],
    parseErrors = [],
    pending = [];
  for (const [index, line] of (text ?? "").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        !event ||
        !["before", "after", "error"].includes(event.event) ||
        typeof event.operation !== "string"
      )
        throw new Error("Invalid marker");
      events.push(event);
      if (event.event === "before") pending.push(event);
      else {
        const at = pending.findLastIndex((e) => e.operation === event.operation);
        if (at >= 0) pending.splice(at, 1);
      }
    } catch (error) {
      parseErrors.push({ line: index + 1, error: String(error) });
    }
  }
  if (!events.length)
    pending.push({ operation: "worker.startup.before-first-marker", observed: false });
  return {
    traceStatus:
      text === null
        ? "missing"
        : parseErrors.length
          ? "incomplete"
          : !events.length
            ? "empty"
            : "present",
    lastCompleted: events.findLast((e) => e.event === "after") ?? null,
    pending,
    errors: events.filter((e) => e.event === "error"),
    parseErrors,
    workerFinished: events.some((e) => e.event === "after" && e.operation === "worker.finished"),
    measurementCompleted: events.some((e) => e.event === "after" && e.operation === "measurement"),
  };
}
