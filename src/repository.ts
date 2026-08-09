import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export interface Repository {
  owner: string;
  name: string;
  root: string;
}

export async function getCurrentRepository(): Promise<Repository> {
  const folder = getActiveWorkspaceFolder();
  if (!folder) {
    throw new Error("Open a GitHub repository before searching Issues.");
  }

  const { stdout: remoteOutput } = await execFileAsync(
    "git",
    ["config", "--get", "remote.origin.url"],
    { cwd: folder.uri.fsPath }
  );
  const remote = remoteOutput.trim();
  const parsed = parseGitHubRemote(remote);
  if (!parsed) {
    throw new Error(`The origin remote is not a GitHub repository: ${remote || "not found"}`);
  }

  return { ...parsed, root: folder.uri.fsPath };
}

function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeDocument = vscode.window.activeTextEditor?.document.uri;
  return activeDocument
    ? vscode.workspace.getWorkspaceFolder(activeDocument)
    : vscode.workspace.workspaceFolders?.[0];
}

export function parseGitHubRemote(remote: string): Omit<Repository, "root"> | undefined {
  const normalized = remote.trim().replace(/\.git$/, "");
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) {
    return undefined;
  }

  return { owner: match[1], name: match[2] };
}
