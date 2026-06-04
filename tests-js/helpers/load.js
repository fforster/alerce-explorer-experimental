/* Shared loader for the vanilla IIFE scripts under src/static/js/.
 *
 * Those scripts are not ES/CJS modules — each is an IIFE that attaches its
 * public surface to `window` (e.g. window.cosmology, window.parseCoordinates).
 * Under Vitest's jsdom environment `window`/`document` are globals, so we
 * just eval the file in global scope and the IIFE wires itself onto window
 * exactly as it does in the browser. No production-code changes required.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadScript(relPath) {
  const code = readFileSync(resolve(process.cwd(), relPath), "utf8");
  // Indirect eval → runs in global scope, so the IIFE's `window` references
  // resolve to jsdom's global window.
  (0, eval)(code);
}
