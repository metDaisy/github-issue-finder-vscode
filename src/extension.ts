import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { addIssueDependency, addSubIssue, createIssueComment, getIssue, getIssueProjects, listIssues, listRepositoryLabels, searchIssues, updateIssue, updateProjectField, type GitHubAuth, type GitHubIssue, type GitHubProjectItem, type IssueUpdateOptions } from "./github";
import { loadIssueDetails } from "./issueDetails";
import { showIssuePanel, type IssuePanelAction, type IssuePanelController } from "./issuePanel";
import { IssueTreeProvider, type IssueTreeContext } from "./issueTree";
import { findProjectField } from "./projectFields";
import { getCurrentRepository, type Repository } from "./repository";

// Keep this scope identical to the built-in GitHub Pull Requests extension so
// both extensions reuse the same stored authentication session.
const GITHUB_AUTH_SCOPES = ["repo"];

export function activate(context: vscode.ExtensionContext): void {
  const issueTree = new IssueTreeProvider(() => getIssueContext());
  const searchView = vscode.window.createTreeView("githubIssueFinder.searchView", {
    treeDataProvider: issueTree
  });
  const commands = [
    vscode.commands.registerCommand("githubIssueFinder.search", () => searchCurrentRepository(issueTree)),
    vscode.commands.registerCommand("githubIssueFinder.refresh", () => issueTree.refresh()),
    vscode.commands.registerCommand("githubIssueFinder.filterState", () => filterState(issueTree)),
    vscode.commands.registerCommand("githubIssueFinder.filterAuthor", () => filterAuthor(issueTree)),
    vscode.commands.registerCommand("githubIssueFinder.filterLabel", () => filterLabel(issueTree)),
    vscode.commands.registerCommand("githubIssueFinder.clearFilters", () => issueTree.clearFilters()),
    vscode.commands.registerCommand("githubIssueFinder.configureFilters", () => configureFilters(issueTree)),
    vscode.commands.registerCommand("githubIssueFinder.openIssueFromTree", (issueNumber: number) => openIssueFromTree(issueNumber, issueTree))
  ];
  context.subscriptions.push(searchView, ...commands);
  void issueTree.refresh();
}

export function deactivate(): void {}

async function searchCurrentRepository(issueTree: IssueTreeProvider): Promise<void> {
  try {
    const repository = await getCurrentRepository();
    const session = await getGitHubSession();
    if (!session) throw new Error("GitHub authentication was cancelled.");

    const input = await vscode.window.showInputBox({
      title: `${repository.owner}/${repository.name} - Search GitHub Issues`,
      prompt: "Enter an Issue number (#123) or search title and body",
      placeHolder: "#123, login failure, payment timeout",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "Enter a number or search text."
    });
    if (!input) return;

    const issues = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Searching Issues in ${repository.name}` },
      () => findIssues(session, repository, input.trim())
    );
    if (issues.length === 0) {
      void vscode.window.showInformationMessage(`No Issues found for "${input.trim()}".`);
      return;
    }

    const selected = await vscode.window.showQuickPick(
      issues.map((issue) => toQuickPickItem(issue)),
      {
        title: `${repository.owner}/${repository.name} - ${issues.length} Issue(s)`,
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "Select an Issue to open inside the IDE"
      }
    );
    if (!selected) return;
    await openIssueWithDetails(selected.issue, { session, repository }, issueTree);
  } catch (error) {
    showError(error);
  }
}

async function handlePanelAction(
  action: IssuePanelAction,
  session: GitHubAuth,
  repository: Repository,
  issueTree: IssueTreeProvider,
  controller: IssuePanelController
): Promise<void> {
  try {
    if (action.type === "issue") {
      const issue = await getIssue(session, repository, action.number);
      if (!issue) throw new Error(`#${action.number} is not an Issue in this repository.`);
      await openIssueWithDetails(issue, { session, repository }, issueTree);
      return;
    }
    if (action.type === "filter") {
      issueTree.setFilters(action.filters);
      return;
    }
    if (action.type === "addComment") {
      if (!action.body.trim()) throw new Error("Comment cannot be empty.");
      await createIssueComment(session, repository, controller.issueNumber, action.body);
      await reloadIssuePanel(session, repository, controller.issueNumber, controller);
      return;
    }
    if (action.type === "updateIssue") {
      if (!action.title.trim()) throw new Error("Issue title cannot be empty.");
      await updateIssue(session, repository, controller.issueNumber, action.title.trim(), action.body);
      await reloadIssuePanel(session, repository, controller.issueNumber, controller);
      return;
    }
    if (action.type === "previewIssue") {
      controller.preview(action.body);
      return;
    }
    if (action.type === "previewComment") {
      controller.preview(action.body, "comment");
      return;
    }
    if (action.type === "copyLink" || action.type === "copyMarkdown" || action.type === "reportContent") {
      const issue = await getIssue(session, repository, controller.issueNumber);
      if (!issue) throw new Error(`#${controller.issueNumber} is not an Issue in this repository.`);
      if (action.type === "copyLink") {
        await vscode.env.clipboard.writeText(issue.html_url);
        void vscode.window.showInformationMessage("Issue link copied.");
      } else if (action.type === "copyMarkdown") {
        await vscode.env.clipboard.writeText(`[${issue.title}](${issue.html_url})`);
        void vscode.window.showInformationMessage("Issue Markdown link copied.");
      } else {
        await vscode.env.openExternal(vscode.Uri.parse(`${issue.html_url}/report`));
      }
      return;
    }
    if (action.type === "updateProjectDate") {
      await updateProjectDate(session, repository, controller.issueNumber, action.field, action.value);
      await reloadIssuePanel(session, repository, controller.issueNumber, controller);
      return;
    }
    if (action.type === "relationship") {
      const changed = await editRelationship(session, repository, controller.issueNumber, action.relationship);
      if (!changed) return;
      await reloadIssuePanel(session, repository, controller.issueNumber, controller);
      issueTree.invalidateParent(controller.issueNumber);
      void issueTree.refresh();
      return;
    }
    if (action.type === "editField") {
      await editIssueField(action.field, session, repository, controller.issueNumber);
      await reloadIssuePanel(session, repository, controller.issueNumber, controller);
      void issueTree.refresh();
      return;
    }
    if (action.type === "refresh") {
      await reloadIssuePanel(session, repository, controller.issueNumber, controller);
      return;
    }
    await openSourceReference(repository, action.path, action.reference);
  } catch (error) {
    showError(error);
  }
}

async function editIssueField(
  field: Extract<IssuePanelAction, { type: "editField" }>["field"],
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number
): Promise<void> {
  const issue = await getIssue(session, repository, issueNumber);
  if (!issue) throw new Error(`#${issueNumber} is not an Issue in this repository.`);

  let projects: GitHubProjectItem[];
  try {
    projects = await getIssueProjects(session, repository, issueNumber);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub Projects 권한이 필요합니다. GITHUB_TOKEN에 Projects Read and write 권한을 추가하세요. (${detail})`);
  }
  if (field === "project") {
    const selectedProject = await vscode.window.showQuickPick(
      projects.map((project) => ({ label: project.title, description: "Open GitHub Project", url: project.url })),
      { title: `Projects for #${issueNumber}`, placeHolder: projects.length ? "Select a project to open" : "No linked Projects" }
    );
    if (selectedProject?.url) await vscode.env.openExternal(vscode.Uri.parse(selectedProject.url));
    return;
  }
  const projectField = field === "startDate"
    ? findProjectField(projects, ["start date", "start_date"])
    : field === "endDate"
      ? findProjectField(projects, ["end date", "end_date", "target date", "target_date"])
      : findProjectField(projects, ["status"]);

  if ((field === "status" || field === "startDate" || field === "endDate") && projectField && projects.length > 0) {
    const project = projects.find((candidate) => candidate.fields.some((candidateField) => candidateField.id === projectField.id));
    if (!project) throw new Error("The linked Project field could not be resolved.");
    if (field === "status") {
      const selected = await vscode.window.showQuickPick(
        (projectField.options ?? []).map((option) => ({ label: option.name, value: option.id })),
        { title: `Change Project status of #${issueNumber}`, placeHolder: projectField.value || "Select a status" }
      );
      if (selected) await updateProjectField(session, project, projectField, selected.value);
      return;
    }
    const value = await vscode.window.showInputBox({
      title: `Edit ${field === "startDate" ? "start" : "end"} date of #${issueNumber}`,
      prompt: "Use YYYY-MM-DD. Leave empty to clear the Project date.",
      value: projectField.value ?? "",
      validateInput: (input) => input && !/^\d{4}-\d{2}-\d{2}$/.test(input) ? "Use YYYY-MM-DD." : undefined
    });
    if (value !== undefined) await updateProjectField(session, project, projectField, value || undefined);
    return;
  }

  if (field === "startDate" || field === "endDate") {
    void vscode.window.showInformationMessage("This Issue is not linked to a Project with a matching date field.");
    return;
  }

  let options: IssueUpdateOptions;
  if (field === "status") {
    const selected = await vscode.window.showQuickPick([
      { label: "Open", value: "open" as const },
      { label: "Closed", value: "closed" as const }
    ], { title: `Change status of #${issue.number}`, placeHolder: `Current status: ${issue.state}` });
    if (!selected) return;
    options = { state: selected.value };
  } else if (field === "labels") {
    const repositoryLabels = await listRepositoryLabels(session, repository);
    const currentLabels = new Set(issue.labels?.map((label) => label.name) ?? []);
    const labelNames = [...new Set([...repositoryLabels.map((label) => label.name), ...currentLabels])].sort();
    const selected = await vscode.window.showQuickPick(
      labelNames.map((name) => ({ label: name, picked: currentLabels.has(name) })),
      { title: `Edit labels for #${issue.number}`, placeHolder: "Search labels", canPickMany: true }
    );
    if (!selected) return;
    options = { labels: selected.map((label) => label.label) };
  } else {
    const value = await vscode.window.showInputBox({
      title: `Edit assignees for #${issue.number}`,
      prompt: "Comma-separated GitHub logins. Leave empty to unassign everyone.",
      value: issue.assignees?.map((assignee) => assignee.login).join(", ") ?? ""
    });
    if (value === undefined) return;
    options = { assignees: splitCommaList(value).map((login) => login.replace(/^@/, "")) };
  }

  await updateIssue(session, repository, issue.number, issue.title, issue.body ?? "", options);
}

function splitCommaList(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

async function updateProjectDate(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number,
  fieldName: "startDate" | "endDate",
  value: string
): Promise<void> {
  const projects = await getIssueProjects(session, repository, issueNumber);
  const field = findProjectField(projects, fieldName === "startDate" ? ["start date", "start_date"] : ["end date", "end_date", "target date", "target_date"]);
  if (!field || field.dataType !== "DATE") throw new Error("A matching Project date field was not found.");
  const project = projects.find((candidate) => candidate.fields.some((candidateField) => candidateField.id === field.id));
  if (!project) throw new Error("The linked Project could not be resolved.");
  await updateProjectField(session, project, field, value || undefined);
}

async function editRelationship(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number,
  relationship: "parent" | "blockedBy" | "blocking" | "relatesTo"
): Promise<boolean> {
  if (relationship === "relatesTo") {
    void vscode.window.showInformationMessage("GitHub does not expose a native REST mutation for a relates-to relationship yet.");
    return false;
  }
  const issues = (await listIssues(session, repository, { state: "all", author: "", label: "" }, 100))
    .filter((issue) => issue.number !== issueNumber && issue.id !== undefined);
  const selected = await vscode.window.showQuickPick(
    issues.map((issue) => ({ label: `#${issue.number} ${issue.title}`, description: issue.state, issue })),
    { title: relationship === "parent" ? "Add parent" : relationship === "blockedBy" ? "Mark as blocked by" : "Mark as blocking", placeHolder: "Search issues" }
  );
  if (!selected?.issue.id) return false;
  if (relationship === "parent") {
    const current = await getIssue(session, repository, issueNumber);
    if (!current?.id) throw new Error("The current Issue ID could not be resolved.");
    await addSubIssue(session, repository, selected.issue.number, current.id);
  } else if (relationship === "blockedBy") {
    await addIssueDependency(session, repository, issueNumber, selected.issue.id);
  } else {
    const current = await getIssue(session, repository, issueNumber);
    if (!current?.id) throw new Error("The current Issue ID could not be resolved.");
    await addIssueDependency(session, repository, selected.issue.number, current.id);
  }
  return true;
}

async function openIssueWithDetails(
  issue: GitHubIssue,
  issueContext: IssueTreeContext,
  issueTree: IssueTreeProvider
): Promise<void> {
  const details = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Loading Issue #${issue.number}` },
    () => loadIssueDetails(issueContext.session, issueContext.repository, issue)
  );
  let controller: IssuePanelController;
  controller = showIssuePanel(issue, details.comments, issueContext.repository, (action, panelController) => {
    void handlePanelAction(action, issueContext.session, issueContext.repository, issueTree, panelController);
  }, details.relationships, details.projects);
}

async function reloadIssuePanel(
  session: GitHubAuth,
  repository: Repository,
  issueNumber: number,
  controller: IssuePanelController
): Promise<void> {
  const issue = await getIssue(session, repository, issueNumber);
  if (!issue) throw new Error(`#${issueNumber} is not an Issue in this repository.`);
  const details = await loadIssueDetails(session, repository, issue);
  controller.update(issue, details.comments, details.relationships, details.projects);
}

async function openIssueFromTree(issueNumber: number, issueTree: IssueTreeProvider): Promise<void> {
  try {
    const issueContext = await getIssueContext();
    if (!issueContext) throw new Error("Sign in to GitHub and open a GitHub repository first.");
    const issue = await getIssue(issueContext.session, issueContext.repository, issueNumber);
    if (!issue) throw new Error(`#${issueNumber} is not an Issue in this repository.`);
    await openIssueWithDetails(issue, issueContext, issueTree);
  } catch (error) {
    showError(error);
  }
}

async function getIssueContext(): Promise<IssueTreeContext | undefined> {
  try {
    const repository = await getCurrentRepository();
    const session = await getGitHubSession();
    return session ? { repository, session } : undefined;
  } catch {
    return undefined;
  }
}

async function filterState(issueTree: IssueTreeProvider): Promise<void> {
  const selected = await vscode.window.showQuickPick([
    { label: "Open", value: "open" as const },
    { label: "Closed", value: "closed" as const },
    { label: "All", value: "all" as const }
  ], { title: "Issue state filter" });
  if (selected) issueTree.setFilters({ state: selected.value });
}

async function filterAuthor(issueTree: IssueTreeProvider): Promise<void> {
  const author = await vscode.window.showInputBox({
    title: "Issue author filter",
    prompt: "GitHub login; leave empty for all authors",
    value: issueTree.currentFilters.author
  });
  if (author !== undefined) issueTree.setFilters({ author: author.trim() });
}

async function filterLabel(issueTree: IssueTreeProvider): Promise<void> {
  const label = await vscode.window.showInputBox({
    title: "Issue label filter",
    prompt: "Label such as domain:catalog; leave empty for all labels",
    value: issueTree.currentFilters.label
  });
  if (label !== undefined) issueTree.setFilters({ label: label.trim() });
}

async function configureFilters(issueTree: IssueTreeProvider): Promise<void> {
  const selected = await vscode.window.showQuickPick([
    { label: "State", description: "open / closed / all", command: () => filterState(issueTree) },
    { label: "Author", description: "GitHub login", command: () => filterAuthor(issueTree) },
    { label: "Label", description: "domain:catalog", command: () => filterLabel(issueTree) },
    { label: "Clear filters", description: "Reset to open Issues", command: () => issueTree.clearFilters() }
  ], { title: "Configure Issue filters" });
  if (selected) await selected.command();
}

async function openSourceReference(repository: Repository, sourcePath: string, reference?: string): Promise<void> {
  if (!sourcePath) throw new Error("The source document path is empty.");
  const root = path.resolve(repository.root);
  const filePath = path.resolve(root, sourcePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("The source path is outside the current repository.");
  }
  if (!fs.existsSync(filePath)) throw new Error(`Source document not found: ${sourcePath}`);

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  let line = 0;
  if (reference) {
    const heading = new RegExp(`^\\s*#{1,6}\\s*${escapeRegExp(reference)}(?:[.\\s:-]|$)`, "i");
    for (let index = 0; index < document.lineCount; index += 1) {
      if (heading.test(document.lineAt(index).text)) {
        line = index;
        break;
      }
    }
  }
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function getGitHubSession(): Promise<GitHubAuth | undefined> {
  const token = process.env.GITHUB_CLASSIC_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (token) return { accessToken: token };

  const existingSession = await vscode.authentication.getSession("github", GITHUB_AUTH_SCOPES, { silent: true });
  if (existingSession) return existingSession;
  return vscode.authentication.getSession("github", GITHUB_AUTH_SCOPES, { createIfNone: true });
}

async function findIssues(session: GitHubAuth, repository: Repository, input: string): Promise<GitHubIssue[]> {
  const number = parseIssueNumber(input);
  if (number !== undefined) {
    const issue = await getIssue(session, repository, number);
    return issue ? [issue] : [];
  }
  const configuredLimit = vscode.workspace.getConfiguration("githubIssueFinder").get<number>("maxResults", 30);
  return searchIssues(session, repository, input, configuredLimit);
}

function parseIssueNumber(input: string): number | undefined {
  const match = input.match(/^#?(\d+)$/);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

interface IssueQuickPickItem extends vscode.QuickPickItem {
  issue: GitHubIssue;
}

function toQuickPickItem(issue: GitHubIssue): IssueQuickPickItem {
  const labels = issue.labels?.map((label) => label.name).join(", ");
  const body = issue.body?.replace(/\s+/g, " ").trim() || "No description";
  return {
    label: `#${issue.number} ${issue.title}`,
    description: `${issue.state} · ${issue.user?.login ?? "unknown"}${labels ? ` · ${labels}` : ""}`,
    detail: body.slice(0, 240),
    issue
  };
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`GitHub Issue Finder: ${message}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
