import type { Extension } from "./types.ts";

/**
 * Extensions compiled into this build. The open-source core ships none; implement the
 * `Extension` interface (./types.ts) in `src/extensions/<name>/` and list it here.
 */
export const extensions: readonly Extension[] = [];
