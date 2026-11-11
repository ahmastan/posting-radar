import { test } from "node:test";
import assert from "node:assert/strict";
import { readDraft, writeDraft, clearDraft, draftFromPrefs, prefsFromDraft, pendingKey, acceptKey, samePrefs } from "../src/lib/local.js";
import { defaults, preferenceSchema } from "../server/config.js";
test("location strings preserve commas and drafts are account-scoped even without browser storage", () => {
  const draft = { ...draftFromPrefs(defaults), locations: "New York, NY\nToronto, ON, Canada" };
  writeDraft("user-a", draft);
  assert.deepEqual(prefsFromDraft(readDraft("user-a")!, 1).locations, ["New York, NY", "Toronto, ON, Canada"]);
  assert.equal(readDraft("user-b"), null);
  clearDraft("user-a"); assert.equal(readDraft("user-a"), null);
});
test("ambiguous run submissions reuse key even when sessionStorage is unavailable", () => {
  const first = pendingKey("draft-test-user:run");
  assert.equal(first, pendingKey("draft-test-user:run"));
  assert.notEqual(first, pendingKey("other-test-user:run"));
  acceptKey("draft-test-user:run");
  assert.notEqual(first, pendingKey("draft-test-user:run"));
});
test("preference comparison ignores revision while retaining actual matching choices", () => {
  assert(samePrefs(defaults, { ...defaults, revision: 50, roles: [...defaults.roles].reverse() }));
  assert(!samePrefs(defaults, { ...defaults, includeUnknown: false }));
});
test("legacy browser drafts retain edits and can be saved using the current preference schema", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  for (const [remotePolicy, expectedModel] of [["only", "remote-listed"], ["exclude", "nonremote"], ["any", "any"]] as const) {
    const { workModel: _workModel, pay: _pay, ...draft } = draftFromPrefs(defaults);
    values.set("posting-radar:draft:legacy-user", JSON.stringify({
      ...draft, baseRevision: 7, remotePolicy, roles: ["Other"], locations: "New York, NY\nToronto",
      excludedCompanies: "Acme\nExample",
    }));
    const restored = readDraft("legacy-user")!;
    assert.equal(restored.baseRevision, 7);
    assert.equal(restored.workModel, expectedModel);
    const saved = preferenceSchema.parse(prefsFromDraft(restored, 8));
    assert.equal(saved.pay, "any");
    assert.deepEqual(saved.locations, ["New York, NY", "Toronto"]);
    assert.deepEqual(saved.excludedCompanies, ["Acme", "Example"]);
    assert(saved.roles.includes("Mechanical Engineering"));
  }
  assert.equal(readDraft("different-legacy-user"), null);
});
