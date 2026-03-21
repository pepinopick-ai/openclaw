/**
 * ESM wrapper for langfuse-trace.cjs
 * Usage: import { trace } from "./langfuse-trace.js";
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { trace } = require("./langfuse-trace.cjs");

export { trace };
