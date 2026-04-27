import * as vscode from "vscode";
import * as path from "node:path";

/**
 * Detect and apply edits proposed by the agent.
 *
 * The agent is steered by the system prompt to wrap proposed file changes in:
 *
 *   ~~~hermes-edit path=relative/path.ts mode=replace
 *   <entire new file content>
 *   ~~~
 *
 *   ~~~hermes-edit path=relative/path.ts mode=create
 *   <new file content>
 *   ~~~
 *
 *   ~~~hermes-edit path=relative/path.ts mode=delete
 *   ~~~
 *
 * (Future: mode=patch with unified diff. Replace works for any size and is
 * unambiguous; we start with that.)
 *
 * `parseEdits` extracts every block from streamed text (called when the
 * stream finishes). `applyEdit` opens a vscode.diff preview and waits for the
 * user to click Accept (Save) or Reject (close without saving).
 */

export interface ProposedEdit {
  path: string;          // as written by the model (relative to workspace root)
  mode: "replace" | "create" | "delete";
  content: string;
  /** Position in the source markdown for highlighting later. */
  range: { start: number; end: number };
}

const FENCE = /~~~hermes-edit\s+([^\n]*)\n([\s\S]*?)~~~/g;

export function parseEdits(text: string): ProposedEdit[] {
  const out: ProposedEdit[] = [];
  for (const m of text.matchAll(FENCE)) {
    const headerStr = (m[1] ?? "").trim();
    const body = m[2] ?? "";
    const header = parseHeader(headerStr);
    if (!header.path) continue;
    out.push({
      path: header.path,
      mode: (header.mode as ProposedEdit["mode"]) ?? "replace",
      content: body.replace(/\n$/, ""),
      range: { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }
    });
  }
  return out;
}

function parseHeader(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** Open a diff preview, return user's decision. */
export async function reviewEdit(
  edit: ProposedEdit,
  workspaceRoot: string
): Promise<"applied" | "rejected" | "cancelled"> {
  const target = vscode.Uri.file(
    path.isAbsolute(edit.path) ? edit.path : path.join(workspaceRoot, edit.path)
  );

  // Fetch the original (or empty for create)
  let originalText = "";
  let originalExists = true;
  try {
    const data = await vscode.workspace.fs.readFile(target);
    originalText = Buffer.from(data).toString("utf8");
  } catch { originalExists = false; }

  if (edit.mode === "delete") {
    const choice = await vscode.window.showWarningMessage(
      `Hermes proposes deleting ${edit.path}`,
      { modal: true }, "Delete file", "Cancel"
    );
    if (choice === "Delete file") {
      try { await vscode.workspace.fs.delete(target); return "applied"; }
      catch { return "cancelled"; }
    }
    return "rejected";
  }

  if (edit.mode === "create" && originalExists) {
    const choice = await vscode.window.showWarningMessage(
      `${edit.path} already exists — overwrite with Hermes' version?`,
      { modal: true }, "Overwrite", "Cancel"
    );
    if (choice !== "Overwrite") return "rejected";
  }

  // Show diff preview using a virtual document for the proposed content.
  const proposedUri = makeProposedUri(target, edit.content);
  await vscode.commands.executeCommand(
    "vscode.diff",
    originalExists ? target : makeProposedUri(target, "", true),
    proposedUri,
    `Hermes: ${edit.path} (Save to apply)`
  );

  // Modal asks for confirmation now that user has seen the diff.
  const decision = await vscode.window.showInformationMessage(
    `Apply Hermes' changes to ${edit.path}?`,
    { modal: true }, "Apply", "Reject"
  );
  if (decision !== "Apply") return "rejected";

  try {
    // Ensure parent dir exists
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(target.fsPath))
    );
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(edit.content));
    return "applied";
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to write ${edit.path}: ${e.message}`);
    return "cancelled";
  }
}

/** Apply an edit without any UI prompt — used by auto-apply mode. */
export async function applyEditNow(edit: ProposedEdit, workspaceRoot: string): Promise<void> {
  const target = vscode.Uri.file(
    path.isAbsolute(edit.path) ? edit.path : path.join(workspaceRoot, edit.path)
  );
  if (edit.mode === "delete") {
    try { await vscode.workspace.fs.delete(target); }
    catch (e: any) { throw new Error(`delete failed: ${e.message}`); }
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(edit.content));
}

// ── proposed-content content provider (virtual scheme) ───────────────────

const SCHEME = "hermes-proposed";
const proposedStore = new Map<string, string>();
let providerRegistered = false;

function makeProposedUri(target: vscode.Uri, content: string, empty = false): vscode.Uri {
  const id = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  const u = vscode.Uri.parse(`${SCHEME}://hermes/${id}/${path.basename(target.fsPath)}`);
  proposedStore.set(u.toString(), empty ? "" : content);
  return u;
}

export function registerProposedProvider(ctx: vscode.ExtensionContext): void {
  if (providerRegistered) return;
  providerRegistered = true;
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent(uri) {
        return proposedStore.get(uri.toString()) ?? "";
      }
    })
  );
}
