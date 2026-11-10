import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseReadme, canonicalUrl, matchPosting } from "../server/parser.js";
import { defaults } from "../server/config.js";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), "utf8");
export const table = (rows: string) => `## Legend\n🛂 Does NOT offer sponsorship\n🇺🇸 Requires U.S. Citizenship\n🔒 Job application is closed\n---\n## Software Engineering\n\n| Company | Role | Location | Application |\n| --- | --- | --- | --- |\n${rows}`;
const row = (role = "Engineer", url = "https://example.org/jobs/1") => `| Acme | ${role} | NYC<br>Remote in USA | [Apply](${url}) |`;
test("confirmed real HTML source excerpts, company continuation, invalid </br>, details locations", () => {
  const ng = parseReadme(fixture("new-grad"));
  assert.equal(ng.length, 4);
  assert.deepEqual(ng[1].locations, ["Palo Alto, CA", "SF", "NYC"]);
  assert.equal(ng[3].company, "RTX");
  assert.equal(ng[0].remote, true);
  const summer = parseReadme(fixture("internships"));
  assert.equal(summer[1].company, "T-Mobile");
  assert.equal(summer[2].locations.length, 5);
  assert(!summer[2].locations.some(l => l.includes("locations")));
  assert.equal(summer[2].category, "Software Engineering");
});
test("GFM escaped pipes, HTML and markdown application links, sponsorship is explicit", () => {
  const parsed = parseReadme(table(`${row("Engineer \\| Backend 🛂")}\n| ↳ | Intern 🇺🇸 | Boston | <a href="https://example.org/2">Apply</a> |\n| Acme | Closed | NYC | 🔒 |`));
  assert.equal(parsed[0].role, "Engineer | Backend 🛂");
  assert.equal(parsed[0].sponsorship, "unavailable");
  assert.equal(parsed[1].sponsorship, "citizenship");
  assert.equal(parsed[2].closed, true);
  assert.equal(parsed[2].ambiguous, true);
  assert.equal(parseReadme(table(row()))[0].sponsorship, "unknown");
});
test("malformed/missing columns/empty active cells are errors, legitimate empty table is not", () => {
  assert.equal(parseReadme(table("")).length, 0);
  for (const raw of ["not a table", table(row()).replace("Location", "Office"), table("| Acme | Eng | NYC | |"), "<table><tr><th>Company</th>"]) {
    assert.throws(() => parseReadme(raw));
  }
  assert.throws(() => parseReadme(table(row("Engineer 🛂")).replace("Does NOT offer sponsorship", "Unknown policy")));
});
test("identity strips known tracking only, preserves distinct job parameters", () => {
  assert.equal(canonicalUrl("https://example.org/jobs?id=1&utm_source=x&ref=Simplify"), "https://example.org/jobs?id=1");
  assert.notEqual(canonicalUrl("https://example.org/?id=1"), canonicalUrl("https://example.org/?id=2"));
  assert.equal(canonicalUrl("javascript:alert(1)"), null);
  assert.equal(canonicalUrl("https://example.org/?ref=employee"), "https://example.org/?ref=employee");
});
test("location OR/category OR/group AND/exclusion override and unknown policy", () => {
  const p = parseReadme(table(row()))[0];
  assert(matchPosting(p, defaults).matches);
  assert(matchPosting(p, { ...defaults, locations: ["Boston", "NYC"] }).matches);
  assert(!matchPosting(p, { ...defaults, remotePolicy: "exclude" }).matches);
  assert(!matchPosting(p, { ...defaults, excludedCompanies: ["acme"] }).matches);
  assert(!matchPosting(p, { ...defaults, includeUnknown: false }).matches);
  assert(matchPosting(p, { ...defaults, sponsorship: "required", includeUnknown: true }).matches);
  assert(!matchPosting({ ...p, sponsorship: "unavailable" }, { ...defaults, sponsorship: "required" }).matches);
  assert(!matchPosting(p, { ...defaults, locations: ["Tokyo"], roles: [p.category] }).matches);
});
