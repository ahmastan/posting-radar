import * as cheerio from "cheerio";
import { marked } from "marked";
import { createHash } from "node:crypto";
import type { Posting, Preferences } from "../src/lib/api.js";
export const PARSER_VERSION = 1;
export class ParseError extends Error { code = "PARSE_FAILED"; }
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function canonicalUrl(input: string): string | null {
  try {
    const u = new URL(input);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) return null;
    // Keep meaningful query parameters and fragments; strip only known marketing parameters.
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ["ref", "gh_src", "source", "src"].includes(key) && /^(simplify|ghlist)$/i.test(u.searchParams.get(key) || "")) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return u.href;
  } catch { return null; }
}
function category(text: string): string {
  if (/software|swe|developer|devops|cyber\s?security/i.test(text)) return "Software Engineering";
  if (/product/i.test(text)) return "Product Management";
  if (/data|machine|artificial|AI\b|ml\b/i.test(text)) return "Data Science, AI & Machine Learning";
  if (/quant/i.test(text)) return "Quantitative Finance";
  if (/hardware|embedded|fpga|vlsi/i.test(text)) return "Hardware Engineering";
  if (/mechanical|mechatronic|aero(space)?|automotive|manufacturing|robotic/i.test(text)) return "Mechanical Engineering";
  if (/electrical|electronics|power\s|controls?\b|rf\b/i.test(text)) return "Electrical Engineering";
  if (/civil|chemical|environmental|biomedical|bio-?med|industrial|materials|structural/i.test(text)) return "Civil & Other Engineering";
  return "Other";
}
/** A row's own title refines the table's section category when it names a known field. */
function refineCategory(section: string, role: string): string {
  const byRole = category(role);
  if (byRole !== "Other") return byRole;
  return section;
}
const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
export function parsePostedAt(text: string): string | undefined {
  const t = text.trim();
  let m = t.match(/^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,?\s+(20\d{2}))?$/);
  if (m && MONTHS[m[1].toLowerCase().slice(0, 3)]) {
    const year = m[3] ?? String(new Date().getUTCFullYear());
    return `${year}-${MONTHS[m[1].toLowerCase().slice(0, 3)]}-${m[2].padStart(2, "0")}`;
  }
  return undefined;
}
function workModelOf(locations: string[], workModelCell: string): Posting["workModel"] {
  const hay = `${workModelCell} ${locations.join(" ")}`.toLowerCase();
  if (/\bhybrid\b/.test(hay)) return "hybrid";
  if (/\bremote\b/.test(hay)) return "remote";
  if (/on[- ]?site|in[- ]?person/.test(hay)) return "onsite";
  return "unknown";
}
function payOf(roleText: string): Posting["pay"] {
  if (/\bunpaid\b/i.test(roleText)) return "unpaid";
  if (/\$\s?\d|paid\b/i.test(roleText)) return "paid";
  return "unknown";
}
export function parseReadme(raw: string): Posting[] {
  if (raw.length > 12_000_000) throw new ParseError("README exceeds 12 MB safety limit.");
  if ((raw.match(/<table\b/gi) || []).length !== (raw.match(/<\/table>/gi) || []).length ||
      (raw.match(/<tr\b/gi) || []).length !== (raw.match(/<\/tr>/gi) || []).length) {
    throw new ParseError("Malformed HTML table: unbalanced table or row tags.");
  }
  // marked supports GFM escaped pipes and embedded HTML; nothing is executed or rendered.
  const $ = cheerio.load(marked.parse(raw, { async: false, gfm: true }));
  let tables = 0;
  const rows: Posting[] = [];
  // Sponsorship interpretation is accepted only when documented by this README's legend.
  const legend = raw.match(/##\s*Legend([\s\S]*?)(?:\n\s*(?:---|##|>))/i)?.[1] || "";
  const noSponsor = /🛂[^\n]*does\s+not\s+offer\s+sponsorship/i.test(legend);
  const citizen = /🇺🇸[^\n]*requires\s+U\.?S\.?\s+citizenship/i.test(legend);
  const closedLegend = /🔒[^\n]*(?:closed|inactive)/i.test(legend);
  $("table").each((tableIndex, table) => {
    const headerRow = $(table).find("tr").first();
    const headers = headerRow.find("th,td").map((_, el) => $(el).text().trim().toLowerCase()).get();
    if (!headers.some(h => /company|role|application|position/.test(h))) return;
    tables++;
    const idx = {
      company: headers.findIndex(h => h === "company"),
      role: headers.findIndex(h => /^(role|position|title|job title)$/.test(h)),
      location: headers.findIndex(h => /^locations?$/.test(h)),
      application: headers.findIndex(h => /^(application|apply|link|application\/link)$/.test(h)),
      workModel: headers.findIndex(h => /^(work model|work model\/type)$/.test(h)),
      posted: headers.findIndex(h => /^(date posted|posted|posted date)$/.test(h))
    };
    // Application column is optional: repos without links yield ambiguous rows instead of failing.
    const required: [string, number][] = [["company", idx.company], ["role", idx.role], ["location", idx.location]];
    const missing = required.filter(([, i]) => i < 0).map(([k]) => k);
    if (missing.length) throw new ParseError(`Table ${tableIndex + 1}: missing required columns: ${missing.join(", ")}. Headers: ${headers.join(", ")}`);
    let company = "";
    let heading = $(table).prevAll("h1,h2,h3").first().text();
    if (!heading) heading = $(table).parent().prevAll("h1,h2,h3").first().text();
    const cat = category(heading);
    $(table).find("tr").slice(1).each((rowIndex, row) => {
      const cells = $(row).find("td");
      if (!cells.length) return;
      if (cells.length !== headers.length) throw new ParseError(`Table ${tableIndex + 1}, row ${rowIndex + 1}: expected ${headers.length} cells, got ${cells.length}.`);
      const companyText = cells.eq(idx.company).text().replace(/[🔥🎓]/gu, "").trim();
      if (!companyText || /^[↳↪→]+$/.test(companyText)) {
        if (!company) throw new ParseError(`Table ${tableIndex + 1}, row ${rowIndex + 1}: continuation without company.`);
      } else company = companyText;
      const role = cells.eq(idx.role).text().trim();
      const loc = cells.eq(idx.location).clone();
      loc.find("summary").remove();
      loc.find("br").replaceWith("\n");
      const locations = loc.text().split(/\n|;/).map(s => s.trim()).filter(Boolean);
      if (!role || !locations.length) throw new ParseError(`Table ${tableIndex + 1}, row ${rowIndex + 1}: empty role or location.`);
      const text = $(row).text();
      if (/[🛂]/u.test(text) && !noSponsor || text.includes("🇺🇸") && !citizen || text.includes("🔒") && !closedLegend) {
        throw new ParseError(`Table ${tableIndex + 1}: unrecognized legend for eligibility/closed symbols.`);
      }
      const links = idx.application >= 0 ? cells.eq(idx.application).find("a").map((_, a) => $(a).attr("href") || "").get() : [];
      const url = links.map(canonicalUrl).find(Boolean) || "";
      const closed = closedLegend && text.includes("🔒");
      const postedAt = idx.posted >= 0 ? parsePostedAt(cells.eq(idx.posted).text()) : undefined;
      const workModel = workModelOf(locations, idx.workModel >= 0 ? cells.eq(idx.workModel).text() : "");
      const pay = payOf(`${role} ${text}`);
      const fallback = hash(JSON.stringify([company.toLowerCase(), role.toLowerCase(), [...locations].sort(), cat]));
      rows.push({
        identity: url ? `url:${url}` : `ambiguous:${fallback}`,
        company, role, locations, category: refineCategory(cat, role), url, remote: workModel === "remote" || locations.some(l => /\bremote\b/i.test(l)),
        workModel, pay, postedAt,
        sponsorship: citizen && text.includes("🇺🇸") ? "citizenship" : noSponsor && text.includes("🛂") ? "unavailable" : "unknown",
        closed, ambiguous: !url
      });
    });
  });
  if (!tables) throw new ParseError("No recognized posting table. Expected Company, Role, Location, Application headers.");
  return rows;
}
const normalize = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, " ").trim();
export function matchPosting(p: Posting, pref: Preferences): { matches: boolean; reasons: string[] } {
  const excluded: string[] = [];
  if (p.closed) excluded.push("Application closed");
  if (pref.excludedCompanies.some(c => normalize(c) === normalize(p.company))) excluded.push("Company excluded");
  if (pref.roles.length && !pref.roles.includes(p.category)) excluded.push("Role category not selected");
  if (pref.locations.length && !p.locations.some(l => pref.locations.some(w => normalize(l).includes(normalize(w))))) excluded.push("No selected location");
  if (pref.workModel === "remote" && p.workModel !== "remote") excluded.push("Not listed as remote");
  if (pref.workModel === "hybrid" && p.workModel !== "hybrid") excluded.push("Not listed as hybrid");
  if (pref.workModel === "onsite" && ["remote", "hybrid"].includes(p.workModel)) excluded.push("Not in person");
  if (pref.pay === "paid" && p.pay !== "paid") excluded.push("Not listed as paid");
  if (pref.pay === "unpaid" && p.pay !== "unpaid") excluded.push("Not listed as unpaid");
  if (!pref.includeUnknown && p.sponsorship === "unknown") excluded.push("Sponsorship unknown excluded");
  if (pref.sponsorship === "required" && ["unavailable", "citizenship"].includes(p.sponsorship)) excluded.push("Sponsorship requirement not met");
  return excluded.length ? { matches: false, reasons: excluded } : { matches: true, reasons: [
    pref.locations.length ? "A selected location matches" : "All locations",
    pref.roles.length ? `${p.category} selected` : "All role categories",
    pref.workModel !== "any" ? `Work model: ${p.workModel}` : "Any work model",
    pref.pay !== "any" ? `Pay: ${p.pay}` : "Any pay",
    p.sponsorship === "unknown" ? "Sponsorship unknown — included by preference" : `Sponsorship: ${p.sponsorship}`
  ] };
}
