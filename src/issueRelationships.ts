import type { GitHubIssue } from "./github";

export interface IssueRelationships {
  parentNumber?: number;
  parentIssue?: GitHubIssue;
  parentSubIssueTotal?: number;
  parentSubIssueClosed?: number;
}
