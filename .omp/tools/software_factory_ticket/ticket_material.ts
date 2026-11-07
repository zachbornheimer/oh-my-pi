import type { Comment, Issue } from "./schemas.js";

/** The ticket as the data a model is shown: title, status, description and every comment, oldest first. */
export function ticketMaterial(issue: Issue, comments: readonly Comment[]): string {
  const thread = [...comments]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((comment) => `--- comment ${comment.createdAt}\n${comment.body}`)
    .join("\n\n");
  return [
    `Ticket ${issue.identifier} (${issue.url})`,
    `Title: ${issue.title}`,
    `Status: ${issue.status}`,
    "",
    "Description:",
    issue.description === "" ? "(empty)" : issue.description,
    ...(thread === "" ? [] : ["", "Comments:", thread]),
  ].join("\n");
}
