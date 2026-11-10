import { z } from "zod";
import type { Source, Preferences } from "../src/lib/api.js";
export const sources: Source[] = [
  { id: "new-grad", name: "New Grad Positions", repo: "SimplifyJobs/New-Grad-Positions", branch: "dev", path: "README.md", season: "2025–2026 graduates", url: "https://github.com/SimplifyJobs/New-Grad-Positions/blob/dev/README.md", stars: 18351, available: true },
  { id: "internships", name: "Summer Internships", repo: "SimplifyJobs/Summer2027-Internships", branch: "dev", path: "README.md", season: "Summer 2027", url: "https://github.com/SimplifyJobs/Summer2027-Internships/blob/dev/README.md", stars: 48372, available: true }
];
export const roleNames = ["Software Engineering", "Product Management", "Data Science, AI & Machine Learning", "Quantitative Finance", "Hardware Engineering", "Other"] as const;
const list = z.array(z.string().trim().min(1).max(100)).max(50);
export const preferenceSchema = z.object({
  revision: z.number().int().positive(), locations: list,
  remotePolicy: z.enum(["any", "only", "exclude"]), roles: z.array(z.enum(roleNames)).max(6),
  sponsorship: z.enum(["any", "required"]), includeUnknown: z.boolean(), excludedCompanies: list
}).strict();
export const defaults: Preferences = {
  revision: 1, locations: [], remotePolicy: "any", roles: [...roleNames],
  sponsorship: "any", includeUnknown: true, excludedCompanies: []
};
