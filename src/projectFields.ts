import type { GitHubProjectField, GitHubProjectItem } from "./github";

/** Shared Project-field lookup rules used by the panel and command handlers. */
export function findProjectField(projects: GitHubProjectItem[], names: string[]): GitHubProjectField | undefined {
  const wanted = names.map(normalizeProjectFieldName);
  for (const project of projects) {
    const field = project.fields.find((candidate) => wanted.includes(normalizeProjectFieldName(candidate.name)));
    if (field) return field;
  }
  return undefined;
}

export function normalizeProjectFieldName(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").trim();
}

export function formatProjectDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
