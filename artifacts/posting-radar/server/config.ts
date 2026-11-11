import { z } from "zod";
import { normalizeLegacyPreferences } from "../src/lib/preference-compat.js";
import type { Source, Preferences } from "../src/lib/api.js";
export const sources: Source[] = [
  { id: "new-grad", name: "New Grad Positions", repo: "SimplifyJobs/New-Grad-Positions", branch: "dev", path: "README.md", season: "2025–2026 graduates", url: "https://github.com/SimplifyJobs/New-Grad-Positions/blob/dev/README.md", stars: 18351, available: true },
  { id: "internships", name: "Summer Internships", repo: "SimplifyJobs/Summer2027-Internships", branch: "dev", path: "README.md", season: "Summer 2027", url: "https://github.com/SimplifyJobs/Summer2027-Internships/blob/dev/README.md", stars: 48372, available: true },
  { id: "pittcsc", name: "Pitt CSC Tech Internships", repo: "pittcsc/Summer2026-Internships", branch: "dev", path: "README.md", season: "Summer 2027", url: "https://github.com/pittcsc/Summer2026-Internships/blob/dev/README.md", stars: 26200, available: true },
  { id: "vanshb03", name: "Vansh & Ouckah Internships", repo: "vanshb03/Summer2027-Internships", branch: "main", path: "README.md", season: "Summer 2027", url: "https://github.com/vanshb03/Summer2027-Internships/blob/main/README.md", stars: 2100, available: true },
  { id: "jobright-eng", name: "Jobright Engineering Jobs", repo: "jobright-ai/2026-Engineer-Internship", branch: "master", path: "README.md", season: "2026 · all engineering fields", url: "https://github.com/jobright-ai/2026-Engineer-Internship/blob/master/README.md", stars: 900, available: true }
];
export const roleNames = ["Software Engineering", "Product Management", "Data Science, AI & Machine Learning", "Quantitative Finance", "Hardware Engineering", "Mechanical Engineering", "Electrical Engineering", "Civil & Other Engineering", "Other"] as const;
const list = z.array(z.string().trim().min(1).max(100)).max(50);
export const preferenceSchema = z.preprocess(normalizeLegacyPreferences, z.object({
  revision: z.number().int().positive(), locations: list,
  workModel: z.enum(["any", "remote", "hybrid", "onsite", "nonremote", "remote-listed"]), pay: z.enum(["any", "paid", "unpaid"]),
  roles: z.array(z.enum(roleNames)).max(9),
  sponsorship: z.enum(["any", "required"]), includeUnknown: z.boolean(), excludedCompanies: list
}).strict());
export const defaults: Preferences = {
  revision: 1, locations: [], workModel: "any", pay: "any", roles: [...roleNames],
  sponsorship: "any", includeUnknown: true, excludedCompanies: []
};
