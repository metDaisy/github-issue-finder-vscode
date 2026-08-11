import * as vscode from "vscode";
import { marked } from "marked";
import type { GitHubComment, GitHubIssue, GitHubProjectItem, IssueFilters } from "./github";
import type { IssueRelationships } from "./issueRelationships";
import { findProjectField, formatProjectDate } from "./projectFields";
import type { Repository } from "./repository";

export type IssuePanelAction =
  | { type: "issue"; number: number }
  | { type: "filter"; filters: Partial<IssueFilters> }
  | { type: "source"; path: string; reference?: string }
  | { type: "addComment"; body: string }
  | { type: "updateIssue"; title: string; body: string }
  | { type: "previewIssue"; body: string }
  | { type: "previewComment"; body: string }
  | { type: "copyLink" }
  | { type: "copyMarkdown" }
  | { type: "reportContent" }
  | { type: "updateProjectDate"; field: "startDate" | "endDate"; value: string }
  | { type: "relationship"; relationship: "parent" | "blockedBy" | "blocking" | "relatesTo" }
  | { type: "editField"; field: "assignees" | "labels" | "status" | "project" | "startDate" | "endDate" }
  | { type: "refresh" };

export interface IssuePanelController {
  readonly issueNumber: number;
  update(issue: GitHubIssue, comments: GitHubComment[], relationships?: IssueRelationships, projects?: GitHubProjectItem[]): void;
  preview(body: string, target?: "issue" | "comment"): void;
}

export interface IssuePanelOpenResult {
  controller: IssuePanelController;
  created: boolean;
}

interface OpenIssuePanel {
  panel: vscode.WebviewPanel;
  controller: IssuePanelController;
}

const openIssuePanels = new Map<string, OpenIssuePanel>();

export function showIssuePanel(
  issue: GitHubIssue,
  comments: GitHubComment[],
  repository: Repository,
  onAction: (action: IssuePanelAction, controller: IssuePanelController) => void,
  relationships: IssueRelationships = {},
  projects: GitHubProjectItem[] = []
): IssuePanelOpenResult {
  const key = issuePanelKey(repository, issue.number);
  const existing = openIssuePanels.get(key);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.Active, false);
    return { controller: existing.controller, created: false };
  }

  const panel = vscode.window.createWebviewPanel(
    "githubIssueFinder.issue",
    `Issue #${issue.number}`,
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  let currentIssue = issue;
  let currentComments = comments;
  let currentRelationships = relationships;
  let currentProjects = projects;
  const controller: IssuePanelController = {
    issueNumber: issue.number,
    update(nextIssue, nextComments, nextRelationships = {}, nextProjects = []) {
      currentIssue = nextIssue;
      currentComments = nextComments;
      currentRelationships = nextRelationships;
      currentProjects = nextProjects;
      panel.title = `Issue #${nextIssue.number}`;
      panel.webview.html = renderIssue(panel.webview, currentIssue, currentComments, repository, currentRelationships, currentProjects);
    },
    preview(body, target = "issue") {
      void panel.webview.postMessage({ type: "preview", target, html: renderMarkdown(body, repository) });
    }
  };
  panel.webview.onDidReceiveMessage((message: IssuePanelAction) => onAction(message, controller));
  openIssuePanels.set(key, { panel, controller });
  panel.onDidDispose(() => {
    if (openIssuePanels.get(key)?.panel === panel) openIssuePanels.delete(key);
  });
  panel.webview.html = renderIssue(panel.webview, currentIssue, currentComments, repository, currentRelationships, currentProjects);
  return { controller, created: true };
}

function issuePanelKey(repository: Repository, issueNumber: number): string {
  return `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}#${issueNumber}`;
}

function renderIssue(
  webview: vscode.Webview,
  issue: GitHubIssue,
  comments: GitHubComment[],
  repository: Repository,
  relationships: IssueRelationships = {},
  projects: GitHubProjectItem[] = []
): string {
  const avatar = renderAvatar(issue.user?.login, issue.user?.avatar_url);
  const labels = issue.labels?.map((label) => {
    const href = `issuefinder://filter?label=${encodeURIComponent(label.name)}`;
    return `<a class="label" href="${href}">${escapeHtml(label.name)}</a>`;
  }).join(" ") ?? "";
  const state = issue.state === "closed" ? "closed" : "open";
  const stateLink = `<a class="state-badge ${state}" href="issuefinder://filter?state=${state}"><span>●</span> ${state === "closed" ? "Closed" : "Open"}</a>`;
  const author = issue.user?.login ?? "unknown";
  const parentNumber = relationships.parentNumber ?? parseParentNumber(issue.body);
  const parentIssue = relationships.parentIssue;
  const parentState = parentIssue?.state === "closed" ? "closed" : "open";
  const parentProgress = relationships.parentSubIssueTotal !== undefined
    ? `<span class="subissue-progress"><span class="progress-icon ${parentState}"></span>${relationships.parentSubIssueClosed ?? 0} / ${relationships.parentSubIssueTotal}</span>`
    : "";
  const parentHtml = parentNumber && parentIssue
    ? `<div class="relationship-item">
        <a class="relationship-issue" href="issuefinder://issue/${parentNumber}">
          <span class="relationship-dot ${parentState}"></span>
          <strong>${escapeHtml(parentIssue.title)}</strong>
          <span class="number">#${parentNumber}</span>
        </a>
        <div class="relationship-repo">${escapeHtml(repository.owner)}/${escapeHtml(repository.name)}#${parentNumber}</div>
        ${parentProgress}
      </div>`
    : parentNumber
      ? `<a href="issuefinder://issue/${parentNumber}">#${parentNumber}</a>`
    : "No parent issue";
  const parentChip = parentNumber && parentIssue
    ? `<a class="filter-chip parent-chip" href="issuefinder://issue/${parentNumber}"><span class="parent-chip-dot ${parentState}"></span>Parent: ${escapeHtml(parentIssue.title)}</a>`
    : "";
  const commentsHtml = comments.length === 0
    ? "<p class=\"muted\">No comments</p>"
    : comments.map((comment) => renderComment(comment, repository)).join("");

  const nonce = createNonce();
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #e6edf3; background: #0d1117; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .page { max-width: 1450px; margin: 0 auto; padding: 28px 34px 80px; }
    .repo-line { color: #8b949e; font-size: 13px; margin-bottom: 12px; }
    .title-row { display: flex; align-items: center; gap: 10px; }
    h1 { font-size: 32px; font-weight: 400; line-height: 1.25; margin: 0; color: #f0f6fc; }
    .number { color: #8b949e; font-weight: 300; }
    .icon-button { color: #8b949e; background: transparent; border: 0; font-size: 20px; cursor: pointer; padding: 5px; }
    .status-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 18px 0 24px; color: #8b949e; }
    .state-badge { display: inline-flex; gap: 6px; align-items: center; border-radius: 22px; padding: 5px 13px; font-weight: 600; color: #fff; text-decoration: none; }
    .state-badge.open { background: #da3633; }
    .state-badge.closed { background: #8957e5; }
    .filter-chip { border: 1px solid #30363d; border-radius: 18px; padding: 4px 10px; color: #c9d1d9; }
    .parent-chip { display: inline-flex; align-items: center; gap: 7px; }
    .parent-chip:hover { text-decoration: none; border-color: #8b949e; }
    .parent-chip-dot { width: 14px; height: 14px; border: 2px solid #da3633; border-radius: 50%; }
    .parent-chip-dot.closed { border-color: #8957e5; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 285px; gap: 34px; align-items: start; }
    .main-column { min-width: 0; }
    .toolbar { display: flex; gap: 8px; justify-content: flex-end; margin: 0 0 12px; }
    button { color: #c9d1d9; background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
    button:hover { background: #30363d; border-color: #8b949e; }
    .primary { color: #fff; background: #238636; border-color: rgba(240,246,252,.1); }
    .primary:hover { background: #2ea043; }
    .conversation-card { position: relative; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; margin-bottom: 12px; }
    .card-header { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 10px 14px; background: #161b22; border-bottom: 1px solid #30363d; color: #8b949e; }
    .card-header strong { color: #f0f6fc; }
    .card-header .spacer { flex: 1; }
    .card-header .timestamp { white-space: nowrap; }
    .card-header > span:last-child { color: #8b949e; padding: 2px 6px; font-size: 18px; line-height: 1; cursor: pointer; border-radius: 6px; }
    .card-header > span:last-child:hover { color: #f0f6fc; background: #21262d; }
    .card-menu-wrap { position: relative; }
    .card-menu-button { color: #8b949e; background: transparent; border: 0; padding: 2px 6px; font-size: 18px; line-height: 1; }
    .card-menu-button:hover { background: #21262d; border-color: transparent; }
    .card-menu { position: absolute; z-index: 3; top: 30px; right: 0; width: 242px; padding: 4px; background: #0d1117; border: 1px solid #30363d; border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,.55); }
    .card-menu[hidden] { display: none; }
    .card-menu button { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: transparent; text-align: left; padding: 9px 10px; }
    .card-menu button:hover { background: #21262d; }
    .card-menu .menu-separator { height: 1px; margin: 4px -4px; background: #30363d; }
    .avatar { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; background: #8957e5; font-weight: 600; flex: 0 0 auto; }
    .avatar-img { object-fit: cover; }
    .owner-badge { border: 1px solid #1f6feb; color: #58a6ff; border-radius: 18px; padding: 2px 8px; font-size: 12px; }
    .card-body { padding: 20px; background: #0d1117; }
    .issue-footer-actions { display: flex; align-items: center; gap: 8px; padding: 0 20px 18px; background: #0d1117; }
    .subissue-button { font-weight: 600; }
    .subissue-button span { margin-left: 12px; color: #8b949e; }
    .reaction-button { width: 34px; height: 34px; border-radius: 50%; padding: 0; font-size: 20px; }
    .body { min-width: 0; overflow-wrap: anywhere; font-size: 14px; line-height: 1.55; }
    .body > :first-child { margin-top: 0; }
    .body > :last-child { margin-bottom: 0; }
    .body p, .body ul, .body ol, .body blockquote, .body table, .body pre { margin-top: 0; margin-bottom: 16px; }
    .body ul, .body ol { padding-left: 2em; }
    .body li + li { margin-top: 4px; }
    .body h1, .body h2, .body h3 { margin: 24px 0 16px; color: #f0f6fc; line-height: 1.25; }
    .body h1 { font-size: 1.6em; padding-bottom: .3em; border-bottom: 1px solid #30363d; }
    .body h2 { font-size: 1.35em; padding-bottom: .3em; border-bottom: 1px solid #30363d; }
    .body h3 { font-size: 1.15em; }
    .body strong { color: #f0f6fc; }
    .body a { color: #58a6ff; }
    .body hr { height: 1px; margin: 24px 0; border: 0; background: #30363d; }
    .body pre { white-space: pre-wrap; overflow-x: auto; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
    .body code { font-family: "JetBrains Mono", monospace; background: rgba(110,118,129,.2); border-radius: 4px; padding: 2px 4px; }
    .body pre code { background: transparent; padding: 0; }
    .body blockquote { margin-left: 0; padding-left: 16px; color: #8b949e; border-left: 3px solid #30363d; }
    .body table { border-collapse: collapse; width: 100%; }
    .body th, .body td { border: 1px solid #30363d; padding: 6px 10px; }
    .body img { max-width: 100%; }
    .issue-actions { display: flex; justify-content: flex-end; padding: 12px 20px; border-top: 1px solid #21262d; }
    .form { border: 1px solid #30363d; border-radius: 6px; padding: 16px; margin: 12px 0; background: #161b22; }
    .form[hidden] { display: none; }
    .editor-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
    .editor-tabs button { border-radius: 6px; }
    .editor-tabs .active { color: #f0f6fc; background: #30363d; }
    .preview-content { min-height: 150px; padding: 10px 0; }
    .preview-content[hidden] { display: none; }
    label { display: block; margin: 8px 0 4px; color: #8b949e; }
    input, textarea { color: #e6edf3; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 9px; width: 100%; font-family: inherit; }
    textarea { min-height: 150px; resize: vertical; }
    .section-title { display: flex; align-items: center; justify-content: space-between; font-size: 16px; font-weight: 600; padding: 18px 0 10px; }
    .section-title button { margin-left: 12px; }
    .comment { margin: 12px 0; }
    .muted { color: #8b949e; }
    .label { display: inline-block; border: 1px solid #57606a; background: #30363d; color: #e6edf3; border-radius: 18px; padding: 3px 9px; font-size: 12px; text-decoration: none; }
    .sidebar { color: #8b949e; }
    .side-section { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 14px; margin-bottom: 10px; }
    .side-title { display: flex; align-items: center; justify-content: space-between; color: #8b949e; font-weight: 600; margin-bottom: 10px; }
    .gear { color: #8b949e; background: transparent; border: 0; padding: 0 2px; font-size: 14px; line-height: 1; }
    .gear:hover { color: #f0f6fc; background: transparent; border-color: transparent; }
    .side-value { color: #c9d1d9; }
    .field-value { color: #f0f6fc; font-size: 14px; font-weight: 600; }
    .field-hint { color: #8b949e; font-size: 12px; margin-top: 3px; }
    .mini-state { display: inline-flex; align-items: center; gap: 6px; border-radius: 14px; padding: 3px 9px; color: #fff; font-size: 12px; font-weight: 600; }
    .mini-state.open { background: #238636; }
    .mini-state.closed { background: #8957e5; }
    .date-value { color: #c9d1d9; font-variant-numeric: tabular-nums; }
    .date-editor { margin-top: 10px; }
    .date-editor[hidden] { display: none; }
    .project-card { margin-top: 8px; border: 1px solid #30363d; border-radius: 7px; overflow: hidden; background: #0d1117; }
    .project-name { display: flex; align-items: center; gap: 8px; padding: 14px; color: #f0f6fc; font-weight: 600; border-bottom: 1px solid #30363d; }
    .project-icon { color: #8b949e; font-size: 18px; }
    .project-field { display: grid; grid-template-columns: 1fr 1.2fr; align-items: center; gap: 12px; padding: 12px 14px; color: #8b949e; }
    .project-field + .project-field { padding-top: 4px; }
    .project-field-value { color: #f0f6fc; background: transparent; border: 0; padding: 3px 8px; text-align: left; }
    .project-field-value:hover { background: #21262d; border-color: transparent; }
    .project-status { display: inline-flex; width: fit-content; color: #58a6ff; background: rgba(31,111,235,.15); border: 1px solid #1f6feb; border-radius: 14px; font-size: 12px; font-weight: 600; }
    .relationship-menu { margin-top: 10px; padding: 6px; background: #0d1117; border: 1px solid #1f6feb; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
    .relationship-menu[hidden] { display: none; }
    .relationship-menu button { display: block; width: 100%; text-align: left; border: 0; background: transparent; }
    .relationship-menu button:hover { background: #21262d; }
    .relationship-item { position: relative; padding: 5px 0 3px; min-height: 52px; }
    .relationship-issue { display: flex; align-items: center; gap: 8px; padding-right: 62px; color: #f0f6fc; }
    .relationship-issue:hover { text-decoration: none; }
    .relationship-issue strong { font-weight: 600; overflow-wrap: anywhere; }
    .relationship-dot, .progress-icon { display: inline-flex; flex: 0 0 auto; border-radius: 50%; border: 2px solid #238636; }
    .relationship-dot { width: 19px; height: 19px; align-items: center; justify-content: center; }
    .relationship-dot.closed, .progress-icon.closed { border-color: #8957e5; }
    .relationship-repo { margin: 3px 0 0 27px; color: #8b949e; font-size: 12px; overflow-wrap: anywhere; }
    .subissue-progress { position: absolute; top: 5px; right: 0; display: inline-flex; align-items: center; gap: 5px; border: 1px solid #30363d; border-radius: 14px; padding: 2px 8px; color: #c9d1d9; font-size: 12px; white-space: nowrap; }
    .progress-icon { width: 16px; height: 16px; border-color: #8b949e; }
    @media (max-width: 850px) { .page { padding: 20px 16px 60px; } .layout { grid-template-columns: 1fr; } .sidebar { order: -1; display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="repo-line">${escapeHtml(repository.owner)}/${escapeHtml(repository.name)} · Issue #${issue.number}</div>
    <div class="title-row"><h1>${escapeHtml(issue.title)} <span class="number">#${issue.number}</span></h1><button class="icon-button" data-action="edit" title="Edit issue">✎</button></div>
    <div class="status-row">${stateLink}${parentChip}</div>
    <div class="layout">
      <main class="main-column">
        <article class="conversation-card">
          <div class="card-header">${avatar}<strong>${author}</strong><span>opened ${formatDate(issue.created_at ?? "")}</span><span class="spacer"></span><span class="owner-badge">Owner</span><span>•••</span></div>
          <div class="card-body"><div class="card-menu" id="issue-menu" hidden><button data-action="copyLink">↗ <span>Copy link</span></button><button data-action="copyMarkdown">▣ <span>Copy Markdown</span></button><button data-action="quote-reply">☷ <span>Quote reply</span></button><div class="menu-separator"></div><button data-action="edit">✎ <span>Edit</span></button><button data-action="refresh">↻ <span>Refresh</span></button><button data-action="reportContent">⚠ <span>Report content</span></button></div><div class="body">${renderMarkdown(issue.body, repository)}</div></div>
          <div class="issue-footer-actions"><button class="subissue-button" data-action="create-subissue">Create sub-issue <span>⌄</span></button><button class="reaction-button" title="Add reaction">☺</button></div>
        </article>
        <section class="form" id="edit-form" hidden>
          <label for="issue-title">Title</label><input id="issue-title" value="${escapeHtml(issue.title)}">
          <label>Body (Markdown)</label>
          <div class="editor-tabs"><button class="active" data-action="write-issue">Write</button><button data-action="preview-issue">Preview</button></div>
          <div id="issue-body-editor"><textarea id="issue-body">${escapeHtml(issue.body ?? "")}</textarea></div>
          <div id="issue-body-preview" class="body preview-content" hidden></div>
          <p><button class="primary" data-action="save-issue">Save changes</button> <button data-action="cancel-edit">Cancel</button></p>
        </section>
        <section class="form" id="comment-form" hidden>
          <label>Comment (Markdown)</label>
          <div class="editor-tabs"><button class="active" data-action="write-comment">Write</button><button data-action="preview-comment">Preview</button></div>
          <div id="comment-body-editor"><textarea id="comment-body" placeholder="Leave a comment"></textarea></div>
          <div id="comment-body-preview" class="body preview-content" hidden></div>
          <p><button class="primary" data-action="save-comment">Comment</button> <button data-action="cancel-comment">Cancel</button></p>
        </section>
        <div class="section-title"><span>Comments (${comments.length})</span><button data-action="comment">Add comment</button></div>
        ${commentsHtml}
      </main>
      <aside class="sidebar">
        <section class="side-section"><div class="side-title">Assignees <button class="gear" data-field="assignees" title="Edit assignees">⚙</button></div><div class="side-value">${renderAssignees(issue)}</div></section>
        <section class="side-section"><div class="side-title">Labels <button class="gear" data-field="labels" title="Edit labels">⚙</button></div><div>${labels || "<span class=\"muted\">None</span>"}</div></section>
        <section class="side-section"><div class="side-title">Projects <button class="gear" data-field="project" title="Edit project">⚙</button></div>${renderProjectDetails(projects, state)}</section>
        <section class="side-section"><div class="side-title">Relationships <button class="gear" data-action="relationships-menu" title="Edit relationships">⚙</button></div><div class="muted">Parent issue</div><div class="side-value">${parentHtml}</div><div class="relationship-menu" id="relationship-menu" hidden><button data-relationship="parent">Add parent</button><button data-relationship="blockedBy">Mark as blocked by</button><button data-relationship="blocking">Mark as blocking</button><button data-relationship="relatesTo">Add relates to</button></div></section>
      </aside>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const editForm = document.getElementById('edit-form');
    const commentForm = document.getElementById('comment-form');
    const issueBodyEditor = document.getElementById('issue-body-editor');
    const issueBodyPreview = document.getElementById('issue-body-preview');
    const commentBodyEditor = document.getElementById('comment-body-editor');
    const commentBodyPreview = document.getElementById('comment-body-preview');
    const issueMenu = document.getElementById('issue-menu');
    const issueMenuTrigger = document.querySelector('.card-header > span:last-child');
    const toggleIssueMenu = () => { if (issueMenu) issueMenu.hidden = !issueMenu.hidden; };
    issueMenuTrigger?.addEventListener('click', toggleIssueMenu);
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) {
        if (button.dataset.field) {
          if (button.dataset.field === 'startDate' || button.dataset.field === 'endDate') {
            const picker = document.querySelector('[data-project-date="' + button.dataset.field + '"]');
            if (picker) { picker.hidden = false; picker.focus(); if (picker.showPicker) picker.showPicker(); }
            return;
          }
          vscode.postMessage({ type: 'editField', field: button.dataset.field });
          return;
        }
        const action = button.dataset.action;
        if (action === 'issue-menu') { toggleIssueMenu(); return; }
        if (action === 'quote-reply') { commentForm.hidden = false; document.getElementById('comment-body').focus(); if (issueMenu) issueMenu.hidden = true; return; }
        if (action === 'relationships-menu') { const menu = document.getElementById('relationship-menu'); menu.hidden = !menu.hidden; return; }
        if (action === 'edit') editForm.hidden = false;
        if (action === 'comment') commentForm.hidden = false;
        if (action === 'cancel-edit') editForm.hidden = true;
        if (action === 'cancel-comment') commentForm.hidden = true;
        if (action === 'write-issue') { issueBodyEditor.hidden = false; issueBodyPreview.hidden = true; }
        if (action === 'preview-issue') vscode.postMessage({ type: 'previewIssue', body: document.getElementById('issue-body').value });
        if (action === 'write-comment') { commentBodyEditor.hidden = false; commentBodyPreview.hidden = true; }
        if (action === 'preview-comment') vscode.postMessage({ type: 'previewComment', body: document.getElementById('comment-body').value });
        if (action === 'copyLink' || action === 'copyMarkdown' || action === 'reportContent') { vscode.postMessage({ type: action }); if (issueMenu) issueMenu.hidden = true; }
        if (action === 'refresh') vscode.postMessage({ type: 'refresh' });
        if (action === 'save-issue') vscode.postMessage({ type: 'updateIssue', title: document.getElementById('issue-title').value, body: document.getElementById('issue-body').value });
        if (action === 'save-comment') vscode.postMessage({ type: 'addComment', body: document.getElementById('comment-body').value });
        if (button.dataset.relationship) vscode.postMessage({ type: 'relationship', relationship: button.dataset.relationship });
        return;
      }
      const link = event.target.closest('a');
      if (!link || !link.href.startsWith('issuefinder://')) return;
      event.preventDefault();
      const url = new URL(link.href);
      if (url.hostname === 'issue') vscode.postMessage({ type: 'issue', number: Number(url.pathname.slice(1)) });
      if (url.hostname === 'source') vscode.postMessage({ type: 'source', path: url.searchParams.get('path') || '', reference: url.searchParams.get('reference') || undefined });
      if (url.hostname === 'filter') {
        const filters = {};
        for (const key of ['state', 'author', 'label']) { const value = url.searchParams.get(key); if (value) filters[key] = value; }
        vscode.postMessage({ type: 'filter', filters });
      }
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'preview') return;
      if (event.data.target === 'comment') {
        commentBodyPreview.innerHTML = event.data.html;
        commentBodyEditor.hidden = true;
        commentBodyPreview.hidden = false;
      } else {
        issueBodyPreview.innerHTML = event.data.html;
        issueBodyEditor.hidden = true;
        issueBodyPreview.hidden = false;
      }
    });
    document.querySelectorAll('[data-project-date]').forEach((picker) => picker.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateProjectDate', field: picker.dataset.projectDate, value: picker.value });
      picker.hidden = true;
    }));
  </script>
</body>
</html>`;
}

function renderComment(comment: GitHubComment, repository: Repository): string {
  const author = comment.user?.login ?? "unknown";
  return `<article class="conversation-card comment"><div class="card-header">${renderAvatar(author, comment.user?.avatar_url)}<strong>${escapeHtml(author)}</strong><span>commented ${formatDate(comment.created_at)}</span><span class="spacer"></span><span>•••</span></div><div class="card-body"><div class="body">${renderMarkdown(comment.body, repository)}</div></div></article>`;
}

function renderAvatar(login: string | undefined, avatarUrl?: string): string {
  if (avatarUrl) return `<img class="avatar avatar-img" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(login ?? "user")}">`;
  return `<span class="avatar">${escapeHtml((login ?? "?").slice(0, 1).toUpperCase())}</span>`;
}

function renderAssignees(issue: GitHubIssue): string {
  const assignees = issue.assignees ?? [];
  if (assignees.length === 0) return `No one · <a href="#">Assign yourself</a>`;
  return assignees.map((assignee) => `<span class="side-value">${escapeHtml(assignee.login)}</span>`).join(", ");
}

function renderProjectDetails(projects: GitHubProjectItem[], issueState: string): string {
  if (projects.length === 0) return "<div class=\"side-value\">No project</div>";
  const project = projects[0];
  const status = findProjectField([project], ["status"]);
  const start = findProjectField([project], ["start date", "start_date"]);
  const end = findProjectField([project], ["end date", "end_date", "target date", "target_date"]);
  const statusValue = status?.value || (issueState === "closed" ? "Closed" : "Open");
  const startValue = start?.value ? formatProjectDate(start.value) : "No date";
  const endValue = end?.value ? formatProjectDate(end.value) : "No date";
  const projectTitle = project.url
    ? `<a href="${escapeHtml(project.url)}">${escapeHtml(project.title)}</a>`
    : escapeHtml(project.title);
  return `<div class="project-card">
    <div class="project-name"><span class="project-icon">▣</span>${projectTitle}</div>
    <div class="project-field"><span>Status</span><button class="project-field-value project-status" data-field="status">${escapeHtml(statusValue)}</button></div>
    <div class="project-field"><span>Start date</span><button class="project-field-value" data-field="startDate">${escapeHtml(startValue)}</button><input class="date-editor" data-project-date="startDate" type="date" value="${escapeHtml(start?.value ?? "")}" hidden></div>
    <div class="project-field"><span>End date</span><button class="project-field-value" data-field="endDate">${escapeHtml(endValue)}</button><input class="date-editor" data-project-date="endDate" type="date" value="${escapeHtml(end?.value ?? "")}" hidden></div>
  </div>${projects.length > 1 ? `<div class="field-hint">+${projects.length - 1} more project(s)</div>` : ""}`;
}

function parseParentNumber(body: string | null): number | undefined {
  const match = body?.match(/^\s*parent(?: issue)?\s*:\s*#?(\d+)/im);
  return match ? Number(match[1]) : undefined;
}

function renderMarkdown(body: string | null, repository: Repository): string {
  const source = linkifyReferences(body?.trim() || "No description", repository);
  const rendered = marked.parse(source, { async: false, gfm: true, breaks: true });
  return typeof rendered === "string" ? rendered : "";
}

function linkifyReferences(body: string, repository: Repository): string {
  void repository;
  let linked = body.replace(/(^|[^\w/])#(\d+)\b/g, "$1[#$2](issuefinder://issue/$2)");
  linked = linked.replace(/source:\s*`([^`]+)`\s*((?:\d+-\d+(?:\s*,\s*)?)+)/gi, (_match, sourcePath: string, references: string) => {
    const encodedPath = encodeURIComponent(sourcePath);
    const sourceLink = `[\`${sourcePath}\`](issuefinder://source?path=${encodedPath})`;
    const referenceLinks = (references.match(/\d+-\d+/g) ?? []).map((reference) => `[${reference}](issuefinder://source?path=${encodedPath}&reference=${encodeURIComponent(reference)})`).join(", ");
    return `source: ${sourceLink} ${referenceLinks}`;
  });
  return linked;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatDate(value: string): string {
  if (!value) return "recently";
  return new Date(value).toLocaleString();
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
