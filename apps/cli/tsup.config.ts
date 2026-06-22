import { defineConfig } from "tsup";

// The CLI is published as a single self-contained package: all `@nova/*`
// workspace packages are bundled in from source (they live in devDependencies,
// which tsup bundles by default and `noExternal` makes explicit), while every
// real npm dependency stays external and is installed from the published
// `dependencies` (notably `@vscode/ripgrep`, which ships a platform binary).
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  noExternal: [/^@nova\//],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: false,
  shims: false,
  // Make the bundled entry directly executable as the `nova` bin.
  banner: { js: "#!/usr/bin/env node" },
});
