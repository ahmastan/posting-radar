import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseReadme, canonicalUrl, matchPosting, parsePostedAt } from "../server/parser.js";
import { defaults, preferenceSchema } from "../server/config.js";
import type { Posting, Preferences } from "../src/lib/api.js";
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
  // An active row without an application URL is an ambiguous observation, not a table failure.
  const noLink = parseReadme(table("| Acme | Eng | NYC | |"));
  assert.equal(noLink.length, 1);
  assert.equal(noLink[0].ambiguous, true);
  for (const raw of ["not a table", table(row()).replace("Location", "Office"), "<table><tr><th>Company</th>"]) {
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
  assert(!matchPosting(p, { ...defaults, workModel: "onsite" }).matches);
  assert(matchPosting(p, { ...defaults, workModel: "remote" }).matches);
  assert(!matchPosting(p, { ...defaults, workModel: "hybrid" }).matches);
  assert(!matchPosting(p, { ...defaults, excludedCompanies: ["acme"] }).matches);
  assert(!matchPosting(p, { ...defaults, includeUnknown: false }).matches);
  assert(matchPosting(p, { ...defaults, sponsorship: "required", includeUnknown: true }).matches);
  assert(!matchPosting({ ...p, sponsorship: "unavailable" }, { ...defaults, sponsorship: "required" }).matches);
  assert(!matchPosting(p, { ...defaults, locations: ["Tokyo"], roles: [p.category] }).matches);
});

// Exercise the private pay/work-model heuristics through the parser's public entry point.
const metadataTable = (role: string, location = "Boston, MA", workModel = "", salary = "") =>
  `| Company | Role | Location | Application | Work Model/Type | Salary |
| --- | --- | --- | --- | --- | --- |
| Acme | ${role} | ${location} | [Apply](https://example.org/job) | ${workModel} | ${salary} |`;

const payCases: { text: string; expected: Posting["pay"] }[] = [
  { text: "Software Engineer (unpaid)", expected: "unpaid" },
  { text: "UNPAID internship", expected: "unpaid" },
  { text: "Unpaid internship with paid training", expected: "unpaid" },
  { text: "Unpaid internship, $500 travel allowance", expected: "unpaid" },
  { text: "Software Engineer ($25/hour)", expected: "paid" },
  { text: "Software Engineer ($ 120,000/year)", expected: "paid" },
  { text: "Paid software internship", expected: "paid" },
  { text: "PAID internship", expected: "paid" },
  { text: "Software Engineer", expected: "unknown" },
  { text: "Software Engineer — compensation TBD", expected: "unknown" },
];
for (const { text, expected } of payCases) {
  test(`pay parsing: ${JSON.stringify(text)} is ${expected}`, () => {
    assert.equal(parseReadme(metadataTable(text))[0].pay, expected);
  });
}
test("pay is detected in a separate compensation cell, not only the role", () => {
  for (const [salary, expected] of [["$35/hr", "paid"], ["Paid", "paid"], ["Unpaid", "unpaid"], ["", "unknown"]] as const) {
    assert.equal(parseReadme(metadataTable("Engineer", "Boston", "", salary))[0].pay, expected, salary);
  }
});

const workModelCases: { wording: string; expected: Posting["workModel"] }[] = [
  { wording: "Remote", expected: "remote" },
  { wording: "REMOTE in USA", expected: "remote" },
  { wording: "Hybrid", expected: "hybrid" },
  { wording: "HYBRID (3 days in office)", expected: "hybrid" },
  { wording: "On Site", expected: "onsite" },
  { wording: "On-site", expected: "onsite" },
  { wording: "Onsite", expected: "onsite" },
  { wording: "In Person", expected: "onsite" },
  { wording: "In-person", expected: "onsite" },
  { wording: "Inperson", expected: "onsite" },
  { wording: "Boston, MA", expected: "unknown" },
  { wording: "Remotely", expected: "unknown" },
];
for (const { wording, expected } of workModelCases) {
  test(`work-model parsing: ${JSON.stringify(wording)} is ${expected} in either column`, () => {
    assert.equal(parseReadme(metadataTable("Engineer", wording))[0].workModel, expected);
    assert.equal(parseReadme(metadataTable("Engineer", "Boston", wording))[0].workModel, expected);
  });
}
test("hybrid takes precedence over remote, and all locations are inspected", () => {
  const hybrid = parseReadme(metadataTable("Engineer", "Remote in USA", "Hybrid"))[0];
  assert.equal(hybrid.workModel, "hybrid");
  assert.equal(parseReadme(metadataTable("Engineer", "Boston<br>Remote in USA"))[0].workModel, "remote");
  assert.equal(parseReadme(metadataTable("Engineer"))[0].workModel, "unknown");
});

test("posted dates normalize supported numeric and month-name formats with a fixed UTC year", t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-10T12:00:00Z") });
  const cases = [
    ["2026-11-10", "2026-11-10"],
    ["2026/1/9", "2026-01-09"],
    ["2026-1-9", "2026-01-09"],
    ["Nov 10", "2026-11-10"],
    ["Jan 9", "2026-01-09"],
    ["November 10, 2025", "2025-11-10"],
    ["Nov 10 2025", "2025-11-10"],
    ["  Nov 10  ", "2026-11-10"],
    ["NOV 10", "2026-11-10"],
  ];
  for (const [input, expected] of cases) assert.equal(parsePostedAt(input), expected, input);
  for (const input of ["", "   ", "not a date", "TBD", "Foo 10", "0d", "1d", "10 days ago"]) {
    assert.equal(parsePostedAt(input), undefined, input);
  }
  // Cover every month mapping, not just the current source excerpts' month.
  for (const [i, month] of ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].entries()) {
    assert.equal(parsePostedAt(`${month} 1`), `2026-${String(i + 1).padStart(2, "0")}-01`);
  }
});
test("repository excerpts wire posted dates and work-model columns into postings", t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-10T12:00:00Z") });
  const jobright = parseReadme(fixture("jobright"));
  assert.equal(jobright.length, 2);
  assert.deepEqual(jobright.map(p => p.postedAt), ["2026-11-10", "2026-11-10"]);
  assert.deepEqual(jobright.map(p => p.workModel), ["hybrid", "onsite"]);
  assert(jobright.every(p => !p.ambiguous));
  assert.deepEqual(jobright.map(p => p.url), [
    "https://jobright.ai/jobs/info/6af339e67c81de7a524bd4c4",
    "https://jobright.ai/jobs/info/6af339de10c7aed778618337",
  ]);
  assert(jobright.every(p => p.identity === `url:${p.url}`));
  const vansh = parseReadme(fixture("vanshb03"));
  assert.equal(vansh.length, 2);
  assert.deepEqual(vansh.map(p => p.postedAt), ["2026-11-10", "2026-11-10"]);
  assert(vansh.every(p => !p.ambiguous));
  // Pitt CSC's Simplify format has Age, not a calendar date. Do not invent postedAt.
  const pittcsc = parseReadme(fixture("internships"));
  assert(pittcsc.every(p => p.postedAt === undefined));
});
test("posted header aliases normalize dates that sort chronologically", () => {
  for (const header of ["Date Posted", "Posted", "Posted Date"]) {
    const parsed = parseReadme(`| Company | Role | Location | ${header} |
| --- | --- | --- | --- |
| Acme | Engineer | Boston | Dec 31, 2025 |
| Acme | Engineer | Boston | 2026/2/1 |
| Acme | Engineer | Boston | Jan 9, 2026 |`);
    assert.deepEqual(parsed.map(p => p.postedAt).sort(), ["2025-12-31", "2026-01-09", "2026-02-01"]);
  }
});

test("work-model preference matrix includes the existing unknown/in-person policy", () => {
  const posting = parseReadme(table(row()))[0];
  const allowed: Record<Preferences["workModel"], Posting["workModel"][]> = {
    any: ["remote", "hybrid", "onsite", "unknown"],
    remote: ["remote"],
    hybrid: ["hybrid"],
    onsite: ["onsite", "unknown"],
    nonremote: ["hybrid", "onsite", "unknown"],
    "remote-listed": ["remote"],
  };
  for (const preference of ["any", "remote", "hybrid", "onsite", "nonremote", "remote-listed"] as const) {
    for (const workModel of ["remote", "hybrid", "onsite", "unknown"] as const) {
      const result = matchPosting({ ...posting, workModel, remote: workModel === "remote" }, { ...defaults, workModel: preference });
      assert.equal(result.matches, allowed[preference].includes(workModel), `${preference} preference / ${workModel} posting`);
      const reason = preference === "remote" || preference === "remote-listed" ? "Not listed as remote" : preference === "hybrid" ? "Not listed as hybrid" : preference === "nonremote" ? "Remote excluded" : "Not in person";
      assert(result.reasons.includes(result.matches ? preference === "any" ? "Any work model" : `Work model: ${workModel}` : reason));
    }
  }
});
test("pay preference matrix requires explicit paid/unpaid evidence unless any is selected", () => {
  const posting = parseReadme(table(row()))[0];
  for (const preference of ["any", "paid", "unpaid"] as const) {
    for (const pay of ["paid", "unpaid", "unknown"] as const) {
      const result = matchPosting({ ...posting, pay }, { ...defaults, pay: preference });
      assert.equal(result.matches, preference === "any" || preference === pay, `${preference} preference / ${pay} posting`);
      assert(result.reasons.includes(result.matches ? preference === "any" ? "Any pay" : `Pay: ${pay}` : `Not listed as ${preference}`));
    }
  }
});
test("pay and work-model rules combine with AND and preserve other exclusion reasons", () => {
  const posting = parseReadme(metadataTable("Paid Software Engineer", "Boston", "Hybrid"))[0];
  const preferences: Preferences = { ...defaults, workModel: "hybrid", pay: "paid" };
  assert(matchPosting(posting, preferences).matches);
  assert.deepEqual(matchPosting({ ...posting, pay: "unknown" }, preferences).reasons, ["Not listed as paid"]);
  assert.deepEqual(matchPosting({ ...posting, workModel: "remote" }, preferences).reasons, ["Not listed as hybrid"]);
  assert.deepEqual(matchPosting({ ...posting, workModel: "remote", pay: "unpaid" }, preferences).reasons, ["Not listed as hybrid", "Not listed as paid"]);
  assert.deepEqual(matchPosting(posting, { ...preferences, excludedCompanies: ["acme"] }).reasons, ["Company excluded"]);
  assert.deepEqual(matchPosting({ ...posting, closed: true }, preferences).reasons, ["Application closed"]);
});
test("legacy remote filters preserve their meaning after preference normalization", () => {
  const { workModel: _workModel, pay: _pay, ...oldPreferences } = defaults;
  for (const [remotePolicy, expectedModel] of [["any", "any"], ["only", "remote-listed"], ["exclude", "nonremote"]] as const) {
    const preferences = preferenceSchema.parse({ ...oldPreferences, remotePolicy });
    assert.equal(preferences.workModel, expectedModel);
    assert.equal(preferences.pay, "any");
    assert(!("remotePolicy" in preferences));
    for (const [location, model] of [["Remote in USA", ""], ["Boston", "Hybrid"], ["Boston", "On-site"], ["Boston", ""], ["Remote in USA", "Hybrid"]]) {
      const posting = parseReadme(metadataTable("Engineer", location, model))[0];
      assert.equal(matchPosting(posting, preferences).matches,
        remotePolicy === "any" || (remotePolicy === "only" ? posting.remote : !posting.remote),
        `${remotePolicy}: ${location} / ${model}`);
    }
  }
});
test("legacy role selections retain newly separated Other categories without broadening focused selections", () => {
  const { workModel: _workModel, pay: _pay, ...oldPreferences } = defaults;
  const expanded = preferenceSchema.parse({ ...oldPreferences, remotePolicy: "any", roles: ["Other"] });
  assert.deepEqual(expanded.roles, ["Other", "Mechanical Engineering", "Electrical Engineering", "Civil & Other Engineering"]);
  assert.deepEqual(preferenceSchema.parse({ ...oldPreferences, remotePolicy: "only", roles: ["Software Engineering"] }).roles, ["Software Engineering"]);
  assert.deepEqual(preferenceSchema.parse({ ...oldPreferences, remotePolicy: "any", roles: [] }).roles, []);
  assert.deepEqual(preferenceSchema.parse(defaults), defaults);
  assert.throws(() => preferenceSchema.parse({ ...oldPreferences, remotePolicy: "invalid" }));
});
test("role-column application fallback rejects unsafe links and never replaces an explicit application column", () => {
  const fallbackTable = (role: string) => `| Company | Job Title | Location |
| --- | --- | --- |
| Acme | ${role} | Boston |`;
  assert.equal(parseReadme(fallbackTable("[Engineer](javascript:alert)"))[0].url, "");
  assert.equal(parseReadme(fallbackTable("Engineer"))[0].ambiguous, true);
  assert.equal(parseReadme(fallbackTable('[Engineer](https://user:pass@example.org/job)'))[0].url, "");
  const posting = parseReadme(metadataTable("[Engineer](https://example.org/description)"))[0];
  assert.equal(posting.url, "https://example.org/job");
});
