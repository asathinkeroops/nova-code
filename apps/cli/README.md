# @asathinkeroops/nova-code

A terminal coding agent, deeply tuned for DeepSeek. Ships the `nova` CLI binary.

## Install

```bash
npm i -g @asathinkeroops/nova-code
nova            # start the interactive REPL
nova -p "..."   # run a single headless turn and exit
```

Requires Node.js >= 20.

## Local development

From the repo root, run the CLI straight from TypeScript source (no build):

```bash
pnpm dev                 # = tsx apps/cli/src/index.ts
```

Or from this directory:

```bash
pnpm dev
pnpm typecheck
```

## How packaging works (read before changing the build)

This is published as **one self-contained package**, not as the ~12 `@nova/*`
workspace packages it is built from:

- `tsup` (`tsup.config.ts`) bundles every `@nova/*` workspace package **in from
  source** into a single `dist/index.js` with a `#!/usr/bin/env node` shebang.
- The `@nova/*` packages therefore live in **`devDependencies`** (tsup bundles
  devDeps by default; `noExternal: [/^@nova\//]` makes it explicit). They are
  *not* installed by consumers.
- Every real npm dependency stays **external** and is declared in
  `dependencies`, so `npm install` pulls them. This matters for packages that
  ship platform binaries — notably **`@vscode/ripgrep`** (the `grep` tool) and
  **`@anthropic-ai/sandbox-runtime`** — which must not be bundled.

Implications when you add code:

- Adding a new third-party runtime dependency anywhere under `packages/*` that
  the CLI reaches at runtime → **add it to this package's `dependencies` too**,
  or it won't be installed for end users.
- Adding a new `@nova/*` workspace package the CLI imports → add it to this
  package's `devDependencies`.
- Only `dist/` (plus `package.json`, `README.md`, `LICENSE`) is published — see
  the `files` field.

## Build

```bash
pnpm build               # tsup -> dist/index.js (single bundled binary)
```

## Publish (full checklist)

> Always publish with **`pnpm`**, never `npm`. The `@nova/*` entries in
> `devDependencies` use the `workspace:*` protocol, which only pnpm understands
> and rewrites to real versions; plain `npm publish` errors on it.

1. **Bump the version** in `package.json` (`version` field). This is also the
   version `nova` reports, since the CLI reads its own `package.json` at runtime.

2. **Log in to npm** (one-time per machine):

   ```bash
   npm login
   ```

3. **Dry run** — inspect exactly what will be published without releasing:

   ```bash
   # from apps/cli
   pnpm publish --dry-run --no-git-checks
   ```

   Expect the tarball to contain only `dist/index.js`, `package.json`,
   `README.md`, and `LICENSE`.

4. **Publish:**

   ```bash
   # from apps/cli
   pnpm publish --access public
   ```

   - Run this **from `apps/cli/`**, not the repo root.
   - `--access public` is required for a scoped package's first publish (also set
     in `publishConfig.access`).
   - `prepublishOnly` runs `pnpm build` automatically, so `dist/` is always
     freshly bundled — no need to build by hand.

5. **Verify** the published package:

   ```bash
   npm view @asathinkeroops/nova-code version
   npm i -g @asathinkeroops/nova-code && nova --help
   ```
