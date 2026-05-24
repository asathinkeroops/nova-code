export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

export function charDisplayWidth(s: string, i: number): number {
  const code = s.charCodeAt(i);
  if (code < 0x20 || code === 0x7f) return 0;
  return isWide(code) ? 2 : 1;
}

export function visibleWidth(s: string): number {
  const t = stripAnsi(s);
  let w = 0;
  for (let i = 0; i < t.length; i++) w += charDisplayWidth(t, i);
  return w;
}

export function truncateToWidth(s: string, w: number): string {
  if (visibleWidth(s) <= w) return s;
  let acc = 0;
  let cut = 0;
  for (let j = 0; j < s.length; j++) {
    const ww = charDisplayWidth(s, j);
    if (acc + ww > w - 1) break;
    acc += ww;
    cut = j + 1;
  }
  return s.slice(0, cut) + "…";
}
