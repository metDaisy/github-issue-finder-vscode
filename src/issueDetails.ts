import { getCachedIssue, getCachedIssueComments, getCachedIssueSubIssues, getCachedParentIssueNumber, getIssue, getIssueComments, getIssueProjects, getIssueSubIssues, getParentIssueNumber, type GitHubAuth, type GitHubIssue, type GitHubProjectItem } from "./github";
import type { IssueRelationships } from "./issueRelationships";
import { parseParentNumber } from "./issueTree";
import type { Repository } from "./repository";

export interface IssueDetails {
  comments: Awaited<ReturnType<typeof getIssueComments>>;
  relationships: IssueRelationships;
  projects: GitHubProjectItem[];
}

/** Returns cached panel data immediately; callers should revalidate in the background. */
export function getCachedIssueDetails(repository: Repository, issue: GitHubIssue): IssueDetails {
  const parentNumber = getCachedParentIssueNumber(repository, issue.number) ?? parseParentNumber(issue.body);
  const subIssues = parentNumber === undefined ? undefined : getCachedIssueSubIssues(repository, parentNumber);
  return {
    comments: getCachedIssueComments(repository, issue.number) ?? [],
    relationships: parentNumber === undefined
      ? {}
      : {
          parentNumber,
          parentIssue: getCachedIssue(repository, parentNumber),
          parentSubIssueTotal: subIssues?.length,
          parentSubIssueClosed: subIssues?.filter((subIssue) => subIssue.state === "closed").length
        },
    projects: []
  };
}

/** Loads all secondary data needed to render one Issue panel. */
export async function loadIssueDetails(
  session: GitHubAuth,
  repository: Repository,
  issue: GitHubIssue
): Promise<IssueDetails> {
  const [comments, relationships, projects] = await Promise.all([
    getIssueComments(session, repository, issue.number),
    loadRelationships(session, repository, issue),
    loadProjects(session, repository, issue.number)
  ]);
  return { comments, relationships, projects };
}

async function loadRelationships(
  session: GitHubAuth,
  repository: Repository,
  issue: GitHubIssue
): Promise<IssueRelationships> {
  const parentNumber = (await getParentIssueNumber(session, repository, issue.number)) ?? parseParentNumber(issue.body);
  if (!parentNumber) return {};

  const [parentIssue, subIssues] = await Promise.all([
    getIssue(session, repository, parentNumber),
    getIssueSubIssues(session, repository, parentNumber).catch(() => [])
  ]);
  return {
    parentNumber,
    parentIssue: parentIssue ?? undefined,
    parentSubIssueTotal: subIssues.length,
    parentSubIssueClosed: subIssues.filter((subIssue) => subIssue.state === "closed").length
  };
}

async function loadProjects(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number
): Promise<GitHubProjectItem[]> {
  try {
    return await getIssueProjects(session, repository, issueNumber);
  } catch {
    return [];
  }
}
