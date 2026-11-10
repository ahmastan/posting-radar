import { test } from "node:test";
import assert from "node:assert/strict";
import { readDraft, writeDraft, clearDraft, draftFromPrefs, prefsFromDraft, pendingKey, acceptKey, samePrefs } from "../src/lib/local.js";
import { defaults } from "../server/config.js";
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
