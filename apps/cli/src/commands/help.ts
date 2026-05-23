import { HELP_TEXT } from "../constants.js";

export function handleHelp(): void {
  process.stdout.write(`\n${HELP_TEXT}\n`);
}
