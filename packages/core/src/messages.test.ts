import { describe, expect, it } from "vitest";
import { messageMetaSchema, messageParamSchema } from "./types.js";
import { migrateLegacyMeta } from "./messages.js";

/**
 * `meta.kind` is PERSISTED in messages.jsonl, so renaming one of its values is a
 * data-format change: a session written under the old name must still load, or
 * the whole transcript fails to parse — not just the one message.
 */
describe("synthetic kind renames", () => {
  it("accepts the current name", () => {
    expect(messageMetaSchema.parse({ synthetic: true, kind: "background-notification" })).toEqual({
      synthetic: true,
      kind: "background-notification",
    });
  });

  it("upgrades the pre-rename `background-notifier` kind", () => {
    expect(messageMetaSchema.parse({ synthetic: true, kind: "background-notifier" })).toEqual({
      synthetic: true,
      kind: "background-notification",
    });
  });

  it("loads a whole persisted message written under the old kind", () => {
    // Exactly what loadMessages does: schema-parse a line off disk. Before the
    // preprocess this threw, taking every later message with it.
    const line = JSON.stringify({
      role: "user",
      content: [
        {
          type: "text",
          text: '<background-notifier id="a1" status="completed"></background-notifier>',
        },
      ],
      meta: { synthetic: true, kind: "background-notifier" },
    });
    const parsed = messageParamSchema.parse(JSON.parse(line));
    expect(parsed.meta?.kind).toBe("background-notification");
  });

  it("still rejects a kind that was never valid", () => {
    expect(() => messageMetaSchema.parse({ synthetic: true, kind: "nonsense" })).toThrow();
  });
});

describe("migrateLegacyMeta", () => {
  const inject = (text: string) => migrateLegacyMeta({ role: "user", content: text });

  it.each([
    ['<background-notification id="a">x</background-notification>'],
    ['<background-notifier id="a">x</background-notifier>'],
    ['<background-command id="a">x</background-command>'],
  ])("maps the pre-meta tag %s to the current kind", (text) => {
    expect(inject(text).meta).toEqual({ synthetic: true, kind: "background-notification" });
  });

  it("leaves a message that already carries meta alone", () => {
    const msg = {
      role: "user" as const,
      content: "<background-notifier>x</background-notifier>",
      meta: { synthetic: true as const, kind: "compacted" as const },
    };
    expect(migrateLegacyMeta(msg).meta?.kind).toBe("compacted");
  });

  it("does not tag a user who typed the tag themselves in prose", () => {
    expect(inject("I saw a <background-notification> in the logs").meta).toBeUndefined();
  });
});
