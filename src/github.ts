import type { Repository } from "./repository";
import { configureResponseCache, getResponseCache, isPersistentIssueUrl, type CacheStorage } from "./githubCache";

const CACHE_TTL_MS = 15_000;

export interface GitHubAuth {
  readonly accessToken: string;
}

export interface GitHubIssue {
  number: number;
  id?: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user?: { login: string; avatar_url?: string };
  assignees?: Array<{ login: string; avatar_url?: string }>;
  labels?: Array<{ name: string }>;
  pull_request?: unknown;
  updated_at?: string;
  created_at?: string;
  closed_at?: string | null;
  state_reason?: string | null;
}

export interface GitHubComment {
  id: number;
  body: string | null;
  created_at: string;
  user?: { login: string; avatar_url?: string };
}

interface SearchResponse {
  items: GitHubIssue[];
}

interface RawProjectField {
  id: string;
  name: string;
  dataType: string;
  options?: Array<{ id: string; name: string }>;
}

interface RawProjectValue {
  field?: { id: string };
  date?: string;
  name?: string;
  optionId?: string;
  text?: string;
  number?: number;
}

interface RawProjectItem {
  id: string;
  project: {
    id: string;
    title: string;
    url?: string;
    fields?: { nodes: RawProjectField[] };
  };
  fieldValues?: { nodes: RawProjectValue[] };
}

export interface IssueFilters {
  state: "open" | "closed" | "all";
  author: string;
  label: string;
}

export interface IssueUpdateOptions {
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

export interface GitHubProjectField {
  id: string;
  name: string;
  dataType: string;
  value?: string;
  optionId?: string;
  options?: Array<{ id: string; name: string }>;
}

export interface GitHubProjectItem {
  id: string;
  projectId: string;
  title: string;
  url?: string;
  fields: GitHubProjectField[];
}

export function initializeGitHubCache(storage: CacheStorage): void {
  configureResponseCache(storage);
}

export function invalidateRepositoryCache(repository: Repository): void {
  const prefix = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/`;
  getResponseCache().invalidate((key) => key.startsWith(prefix));
}

export async function searchIssues(
  session: GitHubAuth,
  repository: Repository,
  text: string,
  maxResults: number
): Promise<GitHubIssue[]> {
  const query = [
    `repo:${repository.owner}/${repository.name}`,
    "is:issue",
    "in:title,body",
    text
  ].join(" ");
  return searchByQuery(session, query, maxResults);
}

export async function listIssues(
  session: GitHubAuth,
  repository: Repository,
  filters: IssueFilters,
  _maxResults: number
): Promise<GitHubIssue[]> {
  const params = new URLSearchParams({
    per_page: "100",
    sort: "created",
    direction: "asc"
  });
  params.set("state", filters.state);
  if (filters.author) params.set("creator", filters.author);
  if (filters.label) params.set("labels", filters.label);

  const issues: GitHubIssue[] = [];
  for (let page = 1; ; page += 1) {
    params.set("page", String(page));
    const pageIssues = await request<GitHubIssue[]>(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues?${params.toString()}`,
      session
    );
    issues.push(...pageIssues.filter((issue) => !issue.pull_request));
    if (pageIssues.length < 100) break;
  }
  return issues;
}

async function searchByQuery(
  session: GitHubAuth,
  query: string,
  maxResults: number
): Promise<GitHubIssue[]> {
  const params = new URLSearchParams({ q: query, per_page: String(maxResults), sort: "updated", order: "desc" });
  const response = await request<SearchResponse>(
    `https://api.github.com/search/issues?${params.toString()}`,
    session
  );
  return response.items;
}

export async function getIssue(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number
): Promise<GitHubIssue | undefined> {
  const issue = await request<GitHubIssue>(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}`,
    session
  );
  return issue.pull_request ? undefined : issue;
}

export async function getIssueProjects(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number
): Promise<GitHubProjectItem[]> {
  const response = await graphqlRequest<{
    repository?: {
      issue?: {
        projectItems?: { nodes: RawProjectItem[] };
      };
    };
  }>(session, `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          projectItems(first: 100, includeArchived: false) {
            nodes {
              id
              project {
                id
                title
                url
                fields(first: 100) {
                  nodes {
                    __typename
                    ... on ProjectV2Field { id name dataType }
                    ... on ProjectV2SingleSelectField {
                      id
                      name
                      dataType
                      options { id name }
                    }
                    ... on ProjectV2IterationField { id name dataType }
                  }
                }
              }
              fieldValues(first: 100) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldDateValue {
                    date
                    field { ... on ProjectV2Field { id name dataType } }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    optionId
                    field {
                      ... on ProjectV2SingleSelectField {
                        id
                        name
                        dataType
                        options { id name }
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field { ... on ProjectV2Field { id name dataType } }
                  }
                  ... on ProjectV2ItemFieldNumberValue {
                    number
                    field { ... on ProjectV2Field { id name dataType } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { owner: repository.owner, name: repository.name, number: issueNumber });

  return (response.repository?.issue?.projectItems?.nodes ?? []).map((item) => {
    const values = new Map((item.fieldValues?.nodes ?? []).map((value) => [value.field?.id, value]));
    const fields = (item.project.fields?.nodes ?? []).map((field) => {
      const value = values.get(field.id);
      return {
        id: field.id,
        name: field.name,
        dataType: field.dataType,
        value: projectFieldValue(value),
        optionId: value?.optionId,
        options: field.options
      };
    });
    return {
      id: item.id,
      projectId: item.project.id,
      title: item.project.title,
      url: item.project.url,
      fields
    };
  });
}

export async function updateProjectField(
  session: GitHubAuth,
  item: GitHubProjectItem,
  field: GitHubProjectField,
  value: string | undefined
): Promise<void> {
  if (!value) {
    await graphqlRequest(session, `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
        clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
          projectV2Item { id }
        }
      }
    `, { projectId: item.projectId, itemId: item.id, fieldId: field.id });
    return;
  }

  const fieldValue = field.dataType === "DATE"
    ? { date: value }
    : field.dataType === "SINGLE_SELECT"
      ? { singleSelectOptionId: value }
      : { text: value };
  await graphqlRequest(session, `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: $value
      }) {
        projectV2Item { id }
      }
    }
  `, { projectId: item.projectId, itemId: item.id, fieldId: field.id, value: fieldValue });
}

export async function getIssueComments(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number
): Promise<GitHubComment[]> {
  const params = new URLSearchParams({ per_page: "100" });
  return request<GitHubComment[]>(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}/comments?${params.toString()}`,
    session
  );
}

export async function listRepositoryLabels(
  session: GitHubAuth,
  repository: Repository
): Promise<Array<{ name: string }>> {
  const labels: Array<{ name: string }> = [];
  for (let page = 1; ; page += 1) {
    const params = new URLSearchParams({ per_page: "100", page: String(page) });
    const pageLabels = await request<Array<{ name: string }>>(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/labels?${params.toString()}`,
      session
    );
    labels.push(...pageLabels);
    if (pageLabels.length < 100) break;
  }
  return labels;
}

export async function createIssueComment(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number,
  body: string
): Promise<GitHubComment> {
  return request<GitHubComment>(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}/comments`,
    session,
    { method: "POST", body: JSON.stringify({ body }) }
  );
}

export async function updateIssue(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number,
  title: string,
  body: string,
  options: IssueUpdateOptions = {}
): Promise<GitHubIssue> {
  const payload = { title, body, ...options };
  return request<GitHubIssue>(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}`,
    session,
    { method: "PATCH", body: JSON.stringify(payload) }
  );
}

export async function getParentIssueNumber(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number
): Promise<number | undefined> {
  try {
    const parent = await request<{ number: number }>(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}/parent`,
      session
    );
    return parent.number;
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) {
      return undefined;
    }
    throw error;
  }
}

export async function getIssueSubIssues(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number
): Promise<GitHubIssue[]> {
  const params = new URLSearchParams({ per_page: "100" });
  return request<GitHubIssue[]>(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}/sub_issues?${params.toString()}`,
    session
  );
}

export async function addSubIssue(
  session: GitHubAuth,
  repository: Repository,
  parentIssueNumber: number,
  subIssueId: number
): Promise<void> {
  await request(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${parentIssueNumber}/sub_issues`,
    session,
    { method: "POST", body: JSON.stringify({ sub_issue_id: subIssueId }) }
  );
}

export async function addIssueDependency(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number,
  blockingIssueId: number
): Promise<void> {
  await request(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}/dependencies/blocked_by`,
    session,
    { method: "POST", body: JSON.stringify({ issue_id: blockingIssueId }) }
  );
}

async function request<T>(url: string, session: GitHubAuth, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const cacheable = method === "GET";
  const cache = getResponseCache();
  const cached = cacheable ? cache.get<T>(url) : undefined;
  const now = Date.now();
  if (cached && now - cached.validatedAt < CACHE_TTL_MS) return cached.body;

  const requestHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${session.accessToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-issue-finder",
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined)
  };
  if (cached?.etag) requestHeaders["If-None-Match"] = cached.etag;
  if (cached?.lastModified) requestHeaders["If-Modified-Since"] = cached.lastModified;

  const response = await fetch(url, {
    ...init,
    headers: requestHeaders
  });

  if (response.status === 304 && cached) {
    cache.set(url, { ...cached, validatedAt: Date.now() });
    return cached.body;
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const body = (await response.json()) as T;
  if (cacheable) {
    cache.set(url, {
      body,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      validatedAt: Date.now(),
      persistent: isPersistentIssueUrl(url)
    });
  }
  return body;
}

function projectFieldValue(value: RawProjectValue | undefined): string | undefined {
  if (!value) return undefined;
  return value.date ?? value.name ?? value.text ?? (value.number === undefined ? undefined : String(value.number));
}

async function graphqlRequest<T>(session: GitHubAuth, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${session.accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-issue-finder",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || payload.errors?.length) {
    const detail = payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
    throw new Error(`GitHub Projects API request failed: ${detail}`);
  }
  return payload.data as T;
}
