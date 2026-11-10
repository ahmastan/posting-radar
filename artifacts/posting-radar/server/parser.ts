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
  if (/software|swe/i.test(text)) return "Software Engineering";
  if (/product/i.test(text)) return "Product Management";
  if (/data|machine|artificial|AI\b/i.test(text)) return "Data Science, AI & Machine Learning";
  if (/quant/i.test(text)) return "Quantitative Finance";
  if (/hardware/i.test(text)) return "Hardware Engineering";
  return "Other";
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
      role: headers.findIndex(h => /^(role|position|title)$/.test(h)),
      location: headers.findIndex(h => /^locations?$/.test(h)),
      application: headers.findIndex(h => /^(application|apply|link|application\/link)$/.test(h))
    };
    const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => k);
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
      const links = cells.eq(idx.application).find("a").map((_, a) => $(a).attr("href") || "").get();
      const url = links.map(canonicalUrl).find(Boolean) || "";
      const closed = closedLegend && text.includes("🔒");
      if (!url && !closed) throw new ParseError(`Table ${tableIndex + 1}, row ${rowIndex + 1}: active job has no valid application URL.`);
      const fallback = hash(JSON.stringify([company.toLowerCase(), role.toLowerCase(), [...locations].sort(), cat]));
      rows.push({
        identity: url ? `url:${url}` : `ambiguous:${fallback}`,
        company, role, locations, category: cat, url, remote: locations.some(l => /\bremote\b/i.test(l)),
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
  if (pref.remotePolicy === "only" && !p.remote) excluded.push("Not listed as remote");
  if (pref.remotePolicy === "exclude" && p.remote) excluded.push("Remote excluded");
  if (!pref.includeUnknown && p.sponsorship === "unknown") excluded.push("Sponsorship unknown excluded");
  if (pref.sponsorship === "required" && ["unavailable", "citizenship"].includes(p.sponsorship)) excluded.push("Sponsorship requirement not met");
  return excluded.length ? { matches: false, reasons: excluded } : { matches: true, reasons: [
    pref.locations.length ? "A selected location matches" : "All locations",
    pref.roles.length ? `${p.category} selected` : "All role categories",
    p.sponsorship === "unknown" ? "Sponsorship unknown — included by preference" : `Sponsorship: ${p.sponsorship}`
  ] };
}
