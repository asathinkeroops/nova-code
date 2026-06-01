// Path canonicalization lives in @nova/runtime so both the CLI permission gate
// and the @nova/tools invariants ledger share one notion of "the real file".
// Re-exported here for the CLI's existing call sites; PATH_INPUT_TOOLS stays
// CLI-local because @nova/runtime must not know specific tool identifiers.
export { canonicalizePath, canonicalizeRoots } from "@nova/runtime";

/**
 * Tools whose `path` input is canonicalized (resolve + realpath) before a
 * permission decision, so the decision is made on the real target rather than
 * the raw string. read/write/edit touch the file; glob/grep use `path` as the
 * search root and must be fenced to the workspace the same way (otherwise the
 * model could enumerate or grep arbitrary out-of-tree files and exfiltrate the
 * results). NOTE: this is a superset of the @nova/tools invariants set
 * (read/write/edit) — glob/grep are gated here but not tracked for
 * read-before-edit.
 */
export const PATH_INPUT_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
]);
