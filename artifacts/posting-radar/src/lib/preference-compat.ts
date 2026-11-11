/** Convert old saved preferences and drafts without changing their filter meaning. */
export function normalizeLegacyPreferences(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (!["any", "only", "exclude"].includes(String(value.remotePolicy))) return input;
  const { remotePolicy, ...rest } = value;
  const addedCategories = ["Mechanical Engineering", "Electrical Engineering", "Civil & Other Engineering"];
  return {
    ...rest,
    workModel: rest.workModel ?? (remotePolicy === "only" ? "remote-listed" : remotePolicy === "exclude" ? "nonremote" : "any"),
    pay: rest.pay ?? "any",
    // These fields previously fell into Other; retain that selection's meaning.
    roles: Array.isArray(rest.roles) && rest.roles.includes("Other")
      ? [...new Set([...rest.roles, ...addedCategories])] : rest.roles,
  };
}
