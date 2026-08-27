import { describe, expect, it, vi } from "vitest";
import { saveMacClipboardImage } from "./clipboard.js";

const ok = (text = "ok") => ({ code: 0, stdout: Buffer.from(text) });

describe("saveMacClipboardImage", () => {
  it("writes a native public.png pasteboard representation directly", async () => {
    const run = vi.fn(async (_bin: string, _args: string[]) => ok());
    const dest = `/private/tmp/nova-clipboard-unit-${process.pid}-png.png`;

    await expect(saveMacClipboardImage(dest, run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);

    const [bin, args] = run.mock.calls[0] ?? [];
    expect(bin).toBe("osascript");
    expect(args?.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(args?.slice(-2)).toEqual(["public.png", dest]);
    expect(args?.[3]).toContain("dataForType(argv[0])");
    expect(args?.[3]).toContain("writeToFileAtomically(argv[1], true)");
  });

  it("reads public.tiff and converts it to PNG when an IM publishes no PNG", async () => {
    const responses = [ok("none"), ok(), ok("")];
    let index = 0;
    const run = vi.fn(async (_bin: string, _args: string[]) => {
      return responses[index++] ?? { code: -1, stdout: Buffer.alloc(0) };
    });
    const dest = `/private/tmp/nova-clipboard-unit-${process.pid}-tiff.png`;

    await expect(saveMacClipboardImage(dest, run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(3);

    const [, pngArgs] = run.mock.calls[0] ?? [];
    const [, tiffArgs] = run.mock.calls[1] ?? [];
    expect(pngArgs?.slice(-2)).toEqual(["public.png", dest]);
    expect(tiffArgs?.slice(-2)).toEqual(["public.tiff", `${dest}.tiff`]);
    expect(run.mock.calls[2]).toEqual([
      "sips",
      ["-s", "format", "png", `${dest}.tiff`, "--out", dest],
    ]);
  });

  it("keeps the legacy AppleScript class path as a compatibility fallback", async () => {
    const responses = [ok("none"), ok("none"), ok()];
    let index = 0;
    const run = vi.fn(async (_bin: string, _args: string[]) => {
      return responses[index++] ?? { code: -1, stdout: Buffer.alloc(0) };
    });
    const dest = `/private/tmp/nova-clipboard-unit-${process.pid}-legacy.png`;

    await expect(saveMacClipboardImage(dest, run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(3);

    const [, legacyArgs] = run.mock.calls[2] ?? [];
    expect(legacyArgs).toContain("set imgData to (the clipboard as «class PNGf»)");
    expect(legacyArgs?.at(-1)).toBe(dest);
  });
});
