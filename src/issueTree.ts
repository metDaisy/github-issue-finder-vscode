import * as vscode from "vscode";
import { getParentIssueNumber, listIssues, type GitHubAuth, type GitHubIssue, type IssueFilters } from "./github";
import type { Repository } from "./repository";

export interface IssueTreeContext {
  session: GitHubAuth;
  repository: Repository;
}

interface IssueNode {
  issue: GitHubIssue;
  children: IssueNode[];
}

const DEFAULT_FILTERS: IssueFilters = { state: "open", author: "", label: "" };

export class IssueTreeProvider implements vscode.TreeDataProvider<IssueTreeItem | FilterTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private roots: IssueNode[] = [];
  private allIssues: GitHubIssue[] = [];
  private loading = false;
  private message = "Loading Issues...";
  private filters: IssueFilters = { ...DEFAULT_FILTERS };
  private parentCacheRepository = "";
  private readonly parentCache = new Map<number, number | null>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly getContext: () => Promise<IssueTreeContext | undefined>
  ) {}

  get currentFilters(): IssueFilters {
    return { ...this.filters };
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.message = "Loading Issues...";
    this.changeEmitter.fire();
    try {
      const context = await this.getContext();
      if (!context) {
        this.message = "Sign in to GitHub to load Issues.";
        this.roots = [];
        return;
      }
      const repositoryKey = `${context.repository.owner}/${context.repository.name}`;
      if (this.parentCacheRepository !== repositoryKey) {
        this.parentCacheRepository = repositoryKey;
        this.parentCache.clear();
      }
      const maxResults = vscode.workspace.getConfiguration("githubIssueFinder").get<number>("maxResults", 100);
      this.allIssues = await listIssues(context.session, context.repository, this.filters, maxResults);
      const parents = await this.resolveParents(this.allIssues, context);
      this.roots = buildTree(this.allIssues, parents);
      this.message = this.roots.length === 0 ? "No Issues match the current filters." : "";
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
      this.roots = [];
    } finally {
      this.loading = false;
      this.changeEmitter.fire();
    }
  }

  setFilters(filters: Partial<IssueFilters>): void {
    this.filters = {
      ...this.filters,
      ...filters,
      state: filters.state ?? this.filters.state,
      author: filters.author ?? this.filters.author,
      label: filters.label ?? this.filters.label
    };
    void this.refresh();
  }

  clearFilters(): void {
    this.filters = { ...DEFAULT_FILTERS };
    void this.refresh();
  }

  invalidateParent(issueNumber: number): void {
    this.parentCache.delete(issueNumber);
  }

  getTreeItem(element: IssueTreeItem | FilterTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: IssueTreeItem | FilterTreeItem): Array<IssueTreeItem | FilterTreeItem> {
    if (element instanceof IssueTreeItem) {
      return element.node.children.map((node) => new IssueTreeItem(node));
    }
    const filterItem = new FilterTreeItem(this.filters);
    if (this.message) {
      return [filterItem, new MessageTreeItem(this.message)];
    }
    return [filterItem, ...this.roots.map((node) => new IssueTreeItem(node))];
  }

  private async resolveParents(
    issues: GitHubIssue[],
    context: IssueTreeContext
  ): Promise<Map<number, number>> {
    const parents = new Map<number, number>();
    const unresolved = issues.filter((issue) => {
      const parent = parseParentNumber(issue.body);
      if (parent !== undefined) {
        parents.set(issue.number, parent);
        return false;
      }
      return true;
    });

    const uncached = unresolved.filter((issue) => {
      const cached = this.parentCache.get(issue.number);
      if (cached === undefined) return true;
      if (cached !== null) parents.set(issue.number, cached);
      return false;
    });
    const nativeParents = await Promise.all(uncached.map(async (issue) => ({
      issue: issue.number,
      parent: await getParentIssueNumber(context.session, context.repository, issue.number)
    })));
    for (const item of nativeParents) {
      this.parentCache.set(item.issue, item.parent ?? null);
      if (item.parent !== undefined) parents.set(item.issue, item.parent);
    }
    return parents;
  }
}

export function parseParentNumber(body: string | null): number | undefined {
  const match = body?.match(/^\s*parent(?: issue)?\s*:\s*#?(\d+)/im);
  return match ? Number(match[1]) : undefined;
}

function buildTree(issues: GitHubIssue[], parents: Map<number, number>): IssueNode[] {
  const nodes = new Map(issues.map((issue) => [issue.number, { issue, children: [] as IssueNode[] }]));
  const roots: IssueNode[] = [];
  for (const node of nodes.values()) {
    const parentNumber = parents.get(node.issue.number);
    const parent = parentNumber === undefined ? undefined : nodes.get(parentNumber);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: IssueNode[]) => {
    items.sort((a, b) => a.issue.number - b.issue.number);
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

export class IssueTreeItem extends vscode.TreeItem {
  constructor(readonly node: IssueNode) {
    super(`#${node.issue.number} ${node.issue.title}`, node.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.description = `${node.issue.state}${node.issue.labels?.length ? ` · ${node.issue.labels.map((label) => label.name).join(", ")}` : ""}`;
    this.tooltip = node.issue.body?.replace(/\s+/g, " ").trim() || node.issue.title;
    this.iconPath = node.children.length
      ? new vscode.ThemeIcon("list-tree", stateColor(node.issue.state))
      : new vscode.ThemeIcon("circle-filled", stateColor(node.issue.state));
    this.command = {
      command: "githubIssueFinder.openIssueFromTree",
      title: "Open Issue",
      arguments: [node.issue.number]
    };
  }
}

function stateColor(state: string): vscode.ThemeColor {
  return new vscode.ThemeColor(state === "closed" ? "charts.purple" : "charts.green");
}

export class FilterTreeItem extends vscode.TreeItem {
  constructor(filters: IssueFilters) {
    super(`Filters: ${filters.state} · ${filters.author || "all authors"} · ${filters.label || "all labels"}`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("filter");
    this.command = { command: "githubIssueFinder.configureFilters", title: "Configure Issue Filters" };
    this.tooltip = "Click to configure Issue filters";
  }
}

class MessageTreeItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("info");
  }
}
