/**
 * @rig-testlab/agent-installer — governed six-harness installer.
 * Payload manifests in, receipts + byte-stable installs out. Tests use temp
 * homes only; nothing here writes to a real ~ without an explicit home option.
 */
export * from "./manifest-format.js";
export * from "./harness-profiles.js";
export * from "./receipts.js";
export * from "./installer.js";

export type { Harness } from "@rig-testlab/catalog";
