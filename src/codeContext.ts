import * as vscode from "vscode";
import * as path from "node:path";

const MAX_FILE_BYTES = 200_000;   // ~200 KB per file in context
const MAX_TOTAL_BYTES = 500_000;

export interface AttachedFile {
  /** Display path: relative to workspace if possible, else basename. */
  label: string;
  absPath: string;
  language?: string;
  content: string;
  truncated: boolean;
}

/** Read the active editor's file (or selection if any). */
export async function activeFile(opts: { selectionOnly?: boolean } = {}): Promise<AttachedFile | null> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  const doc = ed.document;
  let text: string;
  if (opts.selectionOnly && !ed.selection.isEmpty) {
    text = doc.getText(ed.selection);
  } else {
    text = doc.getText();
  }
  return makeAttached(doc.uri, doc.languageId, text);
}

export async function readFileByPath(p: string, base?: string): Promise<AttachedFile | null> {
  let target: vscode.Uri;
  if (path.isAbsolute(p)) {
    target = vscode.Uri.file(p);
  } else {
    const folder = base ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return null;
    target = vscode.Uri.file(path.join(folder, p));
  }
  try {
    const data = await vscode.workspace.fs.readFile(target);
    const text = Buffer.from(data).toString("utf8");
    const ext = path.extname(target.fsPath).slice(1);
    return makeAttached(target, langFromExt(ext), text);
  } catch { return null; }
}

/** Resolve `@mentions` in a prompt to attached files. Returns clean prompt + list. */
export async function resolveMentions(
  prompt: string
): Promise<{ prompt: string; files: AttachedFile[] }> {
  const re = /@(\S+)/g;
  const matches = [...prompt.matchAll(re)];
  if (matches.length === 0) return { prompt, files: [] };
  const files: AttachedFile[] = [];
  let cleaned = prompt;
  for (const m of matches) {
    const f = await readFileByPath(m[1]);
    if (f) {
      files.push(f);
      cleaned = cleaned.replace(m[0], `\`${f.label}\``);
    }
  }
  return { prompt: cleaned, files };
}

function makeAttached(uri: vscode.Uri, langId: string | undefined, text: string): AttachedFile {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const rel = folder ? path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/") : path.basename(uri.fsPath);
  let truncated = false;
  if (text.length > MAX_FILE_BYTES) {
    text = text.slice(0, MAX_FILE_BYTES) + `\n\n[…truncated, original ${text.length} bytes]`;
    truncated = true;
  }
  return {
    label: rel || path.basename(uri.fsPath),
    absPath: uri.fsPath,
    language: langId,
    content: text,
    truncated
  };
}

/** Format files into a single block for inclusion in the prompt. */
export function renderFilesForPrompt(files: AttachedFile[]): string {
  if (files.length === 0) return "";
  const parts: string[] = [];
  let total = 0;
  for (const f of files) {
    const fence = "```" + (f.language ?? "");
    const block = `${fence} path=${f.label}\n${f.content}\n\`\`\``;
    if (total + block.length > MAX_TOTAL_BYTES) {
      parts.push(`[…${files.length - parts.length} more file(s) omitted to fit context]`);
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n\n");
}

function langFromExt(ext: string): string | undefined {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
    rb: "ruby", php: "php", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
    cs: "csharp", swift: "swift", sh: "bash", zsh: "bash", fish: "fish",
    yaml: "yaml", yml: "yaml", json: "json", toml: "toml", xml: "xml",
    md: "markdown", html: "html", css: "css", scss: "scss",
    sql: "sql", graphql: "graphql"
  };
  return map[ext.toLowerCase()];
}
