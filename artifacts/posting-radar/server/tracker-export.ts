import { z } from "zod";
import type { TrackerEntry } from "../src/lib/api.js";

// Shared by the paginated tracker and its complete export.
export const trackerQuery = z.object({
  status: z.enum(["", "saved", "applied", "skipped"]).default(""),
  source: z.string().max(40).default(""),
  search: z.string().max(120).default(""),
  sort: z.enum(["added", "posted", "posted-asc"]).default("added")
});

export function trackerSelection(userId: string, query: z.infer<typeof trackerQuery>) {
  return {
    params: [userId, query.status, query.source, query.search],
    where: `WHERE t.user_id=$1 AND ($2='' OR t.status=$2) AND ($3='' OR t.source_id=$3)
      AND ($4='' OR p.payload->>'company' ILIKE '%'||$4||'%' OR p.payload->>'role' ILIKE '%'||$4||'%')`,
    orderBy: query.sort === "posted" ? `ORDER BY (p.payload->>'postedAt') DESC NULLS LAST,t.created_at DESC,t.id`
      : query.sort === "posted-asc" ? `ORDER BY (p.payload->>'postedAt') ASC NULLS LAST,t.created_at DESC,t.id`
      : `ORDER BY t.created_at DESC,t.id`
  };
}

export type ExportEntry = TrackerEntry & { updatedAt: string | Date };

function csvCell(value: string) {
  // CSV quoting alone does not prevent spreadsheet formula execution.
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function trackerCsv(entries: ExportEntry[], sourceNames: Map<string, string>) {
  const rows = [["Company", "Role", "Locations", "Source", "Source ID", "Status", "Posted date", "Created at", "Updated at", "URL", "Season"]];
  for (const entry of entries) {
    rows.push([
      entry.posting.company, entry.posting.role, entry.posting.locations.join("; "),
      sourceNames.get(entry.sourceId) ?? entry.sourceId, entry.sourceId, entry.status,
      entry.posting.postedAt ?? "", new Date(entry.createdAt).toISOString(),
      new Date(entry.updatedAt).toISOString(), entry.posting.url, entry.season
    ]);
  }
  // BOM helps spreadsheet applications detect UTF-8; CRLF is standard CSV.
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
