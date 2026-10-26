import { describe, expect, test } from "vitest";
import { keepSecrets, redactSettings, resolveSettings, SECRET_MASK, type WappyAppDefinition } from "./app-settings.js";

const def: Pick<WappyAppDefinition, "settings"> = {
  settings: [
    { key: "url", label: "Server address", type: "text" },
    { key: "key", label: "Server key", type: "secret", maxLength: 64 },
    { key: "spare", label: "Spare key", type: "secret" },
  ],
};

describe("M18: secret settings — usable by the app, never shown back or logged by the host", () => {
  test("a secret resolves like text: empty by default, must be text, length-checked", () => {
    expect(resolveSettings(def)).toEqual({ ok: true, settings: { url: "", key: "", spare: "" } });
    expect(resolveSettings(def, { key: "s3cret" })).toEqual({ ok: true, settings: { url: "", key: "s3cret", spare: "" } });
    const bad = resolveSettings(def, { key: "x".repeat(65), spare: 7 });
    expect(!bad.ok && bad.errors.sort()).toEqual(['"key" is longer than 64 characters', '"spare" must be text']);
  });

  test("errors about a secret never contain its value", () => {
    const r = resolveSettings(def, { key: "TOP-SECRET-VALUE".repeat(5) });
    expect(!r.ok && r.errors.join(" ")).not.toContain("TOP-SECRET");
  });

  test("redactSettings: a set secret becomes the mask, an empty one stays empty, everything else as is", () => {
    expect(redactSettings(def, { url: "http://localhost:8790", key: "s3cret", spare: "" })).toEqual({ url: "http://localhost:8790", key: SECRET_MASK, spare: "" });
  });

  test("keepSecrets: the mask (or a missing secret) keeps what's stored; a new value replaces it; other fields untouched", () => {
    const stored = { url: "http://a", key: "old-key", spare: "old-spare" };
    expect(keepSecrets(def, stored, { url: "http://b", key: SECRET_MASK })).toEqual({ url: "http://b", key: "old-key", spare: "old-spare" });
    expect(keepSecrets(def, stored, { key: "new-key", spare: "" })).toEqual({ key: "new-key", spare: "" });
  });
});
