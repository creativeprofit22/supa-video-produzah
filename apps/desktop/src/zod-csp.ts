import { config } from "zod";

// The production CSP forbids `unsafe-eval`. Zod 4 otherwise probes
// `new Function("")` on first object parse to enable its JIT, which the CSP
// blocks and reports as a violation. Jitless parsing is equivalent and needs
// no eval. Imported first by `main.tsx`, before any schema can parse.
config({ jitless: true });
