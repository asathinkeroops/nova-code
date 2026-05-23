function detectColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!process.stdout.isTTY;
}

export const useColor = detectColor();

function wrap(open: number, close: number, text: string): string {
  if (!useColor) return text;
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

export const green = (s: string): string => wrap(32, 39, s);
export const red = (s: string): string => wrap(31, 39, s);
export const dim = (s: string): string => wrap(2, 22, s);
export const cyan = (s: string): string => wrap(36, 39, s);
export const yellow = (s: string): string => wrap(33, 39, s);
export const magenta = (s: string): string => wrap(35, 39, s);
export const bold = (s: string): string => wrap(1, 22, s);
export const italic = (s: string): string => wrap(3, 23, s);
export const underline = (s: string): string => wrap(4, 24, s);
export const strike = (s: string): string => wrap(9, 29, s);
