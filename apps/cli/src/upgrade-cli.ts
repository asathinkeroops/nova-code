import { Command } from "commander";
import { loadSettings } from "@nova/runtime";
import { fetchLatestVersion, isNewerVersion, runUpgrade } from "./update.js";
import { readCliPackage } from "./version.js";

/**
 * `nova upgrade` — manually update the CLI by running the configured installer
 * (`settings.update.command`, npm by default). Runs standalone like `nova
 * doctor`: no Screen/REPL, prints to stdout, and exits with the installer's
 * code.
 */
export function buildUpgradeCommand(): Command {
  return new Command("upgrade")
    .description("update the nova CLI to the latest published version")
    .option("--check", "only check for a newer version; don't install")
    .action(async (opts: { check?: boolean }) => {
      const [{ name, version }, settings] = await Promise.all([readCliPackage(), loadSettings()]);
      process.stdout.write(`nova ${version} — checking ${name} for updates…\n`);

      const latest = await fetchLatestVersion(name);
      if (!latest) {
        process.stdout.write("could not reach the npm registry; try again later.\n");
        process.exit(1);
      }
      if (!isNewerVersion(latest, version)) {
        process.stdout.write(`already on the latest version (${version}).\n`);
        process.exit(0);
      }

      process.stdout.write(`a newer version is available: ${latest}\n`);
      if (opts.check) {
        process.stdout.write(`run \`nova upgrade\` to install it.\n`);
        process.exit(0);
      }

      process.stdout.write(`installing via: ${settings.update.command}\n\n`);
      const code = await runUpgrade(settings.update.command);
      if (code === 0) {
        // Exit 0 from the install command is not proof the *published* version
        // landed: a user-level npmrc pointing at a lagging mirror can make
        // `npm install -g …@latest` succeed while installing an older version.
        // Re-read the on-disk package.json (the install just overwrote it) and
        // verify before claiming victory.
        const installed = await readCliPackage();
        if (installed.version !== "0.0.0" && installed.version !== latest) {
          process.stdout.write(
            `\n⚠ installed ${installed.version}, but the latest published version is ${latest}.\n` +
              `The upgrade command ran but did not update nova. Check settings.update.command\n` +
              `and your npm registry (\`npm config get registry\`) — a mirror that hasn't synced\n` +
              `${latest} yet can silently install an older version. Force the official registry:\n` +
              `\n  npm install -g @asathinkeroops/nova-code@latest --registry https://registry.npmjs.org\n`,
          );
          process.exit(1);
        }
        process.stdout.write(`\n✓ updated to ${latest}. restart nova to use it.\n`);
      } else {
        process.stdout.write(`\n✗ upgrade command exited with code ${code}.\n`);
      }
      process.exit(code);
    });
}
