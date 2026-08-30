import { defineConfig } from "tsup";

// The CLI is published as a single self-contained package: all `@nova/*`
// workspace packages are bundled in from source (they live in devDependencies,
// which tsup bundles by default and `noExternal` makes explicit), while every
// real npm dependency stays external and is installed from the published
// `dependencies` (notably `@vscode/ripgrep` and `sharp`, which ship platform
// binaries). Keep sharp explicit so its JS loader is never bundled separately
// from the native @img/sharp-* packages npm selects for the target machine.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  noExternal: [/^@nova\//],
  external: ["sharp"],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: false,
  shims: false,
  // Make the bundled entry directly executable as the `nova` bin.
  banner: { js: "#!/usr/bin/env node" },
});
