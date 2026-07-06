import { afterEach, describe, expect, it } from "vitest";
import { hitTestJumpButton, setJumpButtonBounds } from "./jump-button.js";

afterEach(() => setJumpButtonBounds(null));

describe("hitTestJumpButton", () => {
  it("is false when no bounds are registered", () => {
    expect(hitTestJumpButton(5, 10)).toBe(false);
  });

  it("matches only within the registered row and column span", () => {
    setJumpButtonBounds({ row: 20, colStart: 30, colEnd: 58 });
    expect(hitTestJumpButton(20, 30)).toBe(true); // left edge
    expect(hitTestJumpButton(20, 58)).toBe(true); // right edge
    expect(hitTestJumpButton(20, 44)).toBe(true); // middle
    expect(hitTestJumpButton(20, 29)).toBe(false); // just left
    expect(hitTestJumpButton(20, 59)).toBe(false); // just right
    expect(hitTestJumpButton(19, 44)).toBe(false); // wrong row
  });

  it("stops matching once bounds are cleared", () => {
    setJumpButtonBounds({ row: 1, colStart: 1, colEnd: 5 });
    expect(hitTestJumpButton(1, 3)).toBe(true);
    setJumpButtonBounds(null);
    expect(hitTestJumpButton(1, 3)).toBe(false);
  });
});
