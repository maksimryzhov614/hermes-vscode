import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { BridgeClient, ChatMessage, ContentPart } from "./bridgeClient";
import { ChatPanel, AttachedDescriptor, ChatMessageOut, Mode, ThemeOverride, ExamplePrompt, ClusterDescriptor } from "./chatPanel";
import { activeFile, AttachedFile, renderFilesForPrompt, resolveMentions } from "./codeContext";
import { applyEditNow, parseEdits, ProposedEdit, registerProposedProvider, reviewEdit } from "./diffApply";
import { discover } from "./discovery";
import { checkForUpdates } from "./updater";

const TOKEN_KEY = "hermes.token";
const DISCOVERED_KEY = "hermes.discoveredUrl";
const FALLBACK_URL_KEY = "hermes.fallbackUrl";
const HISTORY_KEY = "hermes.history";
const VISIBLE_LOG_KEY = "hermes.visibleLog";
const MODE_KEY = "hermes.mode";
const SHOW_USAGE_KEY = "hermes.showUsage";

let mode: Mode = "default";
let client: BridgeClient | null = null;
let panel: ChatPanel | null = null;
let history: ChatMessage[] = [];
let visibleLog: ChatMessageOut[] = [];
let pairAbort: AbortController | null = null;
let chatAbort: AbortController | null = null;
let secrets: vscode.SecretStorage;
let memento: vscode.Memento;
let workspaceMemento: vscode.Memento;
let output: vscode.OutputChannel;
let lastUserPrompt: string | null = null;
let isUsingFallback = false;

interface Pending {
  files: AttachedFile[];
  images: { id: string; dataUrl: string }[];
}
const pending: Pending = { files: [], images: [] };
const editIndex = new Map<string, ProposedEdit>();
const clusterIndex = new Map<string, string[]>();

const SYSTEM_PROMPT = `You are Hermes, integrated into the user's VS Code on a remote machine.

CRITICAL — file operations:
You DO NOT have any direct access to the user's filesystem. Your built-in file/terminal/code_execution tools, if you have them, run on a SERVER far away from the user's machine; they cannot touch the user's PC. The ONLY way to create, modify, or delete files on the user's machine is to emit a \`~~~hermes-edit~~~\` block. The editor watches for these blocks and applies them locally with the user's approval.

You MUST use this format for ANY file operation requested by the user — code, config, text, JSON, anything. Do not "describe" the change in prose, do not call any other tool, do not ask the user to copy-paste. Emit the block.

Format (one block per file):

  ~~~hermes-edit path=relative/path.ext mode=replace
  <full final file contents>
  ~~~

Modes:
  replace  — overwrite an existing file with full new contents
  create   — make a new file (body is the full contents)
  delete   — remove the file (body is empty)

Paths are relative to the workspace root.

When citing existing files in your reply (not editing them), reference them like \`src/foo.ts\` or \`src/foo.ts:42\` — the editor renders these as clickable links.

Outside hermes-edit blocks, write concise markdown (headings, lists, **bold**, \`code\`, fenced code blocks).`;

export function activate(ctx: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Hermes");
  ctx.subscriptions.push(output);
  secrets = ctx.secrets;
  memento = ctx.globalState;
  workspaceMemento = ctx.workspaceState;
  registerProposedProvider(ctx);

  panel = new ChatPanel(ctx.extensionUri, {
    onPair: () => startPairing(),
    onCancelPair: () => cancelPairing(),
    onPrompt: (t) => sendPrompt(t),
    onClear: () => clearHistory(),
    onAttachFile: () => attachActiveFile(false),
    onAttachSelection: () => attachActiveFile(true),
    onRemoveAttachment: (id) => removeAttachment(id),
    onPasteImage: (dataUrl) => attachImage(dataUrl),
    onReviewEdit: (id) => reviewEditById(id),
    onApplyCluster: (cid) => applyCluster(cid),
    onRejectCluster: (cid) => rejectCluster(cid),
    onStop: () => stopGeneration(),
    onRetry: () => retryLast(),
    onModeChange: (m) => setMode(m),
    onSettingsChange: (s) => applySettings(s),
    onOpenFile: (p, line) => openFileFromLink(p, line),
  });

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("hermes.openChat", () => panel?.reveal()),
    vscode.commands.registerCommand("hermes.signOut", () => signOut()),
    vscode.commands.registerCommand("hermes.pair", () => startPairing()),
    vscode.commands.registerCommand("hermes.rediscover", () => rediscover()),
    vscode.commands.registerCommand("hermes.clearHistory", () => clearHistory()),
    vscode.commands.registerCommand("hermes.sendFile", () => attachActiveFile(false).then(() => panel?.reveal())),
    vscode.commands.registerCommand("hermes.sendSelection", () => attachActiveFile(true).then(() => panel?.reveal())),
    vscode.commands.registerCommand("hermes.askAboutSelection", () => askAboutSelection()),
    vscode.commands.registerCommand("hermes.checkForUpdates", () => checkForUpdates(ctx, log, { silent: false }))
  );

  // Refresh examples / workspace info on editor change
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateExamplesAndWorkspace()),
    vscode.window.onDidChangeTextEditorSelection(() => updateExamplesAndWorkspace()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateExamplesAndWorkspace())
  );

  // Restore persisted state
  const savedHistory = workspaceMemento.get<ChatMessage[]>(HISTORY_KEY) || [];
  const savedLog = workspaceMemento.get<ChatMessageOut[]>(VISIBLE_LOG_KEY) || [];
  mode = (memento.get<string>(MODE_KEY) as Mode | undefined) || "default";
  history = savedHistory;
  visibleLog = savedLog;

  panel.setMode(mode);
  pushSettingsToPanel();
  if (visibleLog.length) panel.loadHistory(visibleLog);
  updateExamplesAndWorkspace();

  refreshClient().catch((e) => log("activate failed: " + String(e)));

  setTimeout(() => checkForUpdates(ctx, log, { silent: true }).catch(() => {}), 5000);
}

export function deactivate(): void {
  pairAbort?.abort();
  chatAbort?.abort();
}

function setMode(m: Mode): void {
  mode = m;
  void memento.update(MODE_KEY, m);
  panel?.setMode(m);
  history = [];
  persistHistory();
}

function applySettings(s: { bridgeUrl?: string; mode?: Mode; themeOverride?: ThemeOverride; showUsage?: boolean }): void {
  if (typeof s.bridgeUrl === "string") {
    void vscode.workspace.getConfiguration("hermes").update("bridgeUrl", s.bridgeUrl, vscode.ConfigurationTarget.Global);
    refreshClient().catch(() => {});
  }
  if (s.mode && s.mode !== mode) setMode(s.mode);
  if (s.themeOverride) {
    void vscode.workspace.getConfiguration("hermes").update("theme", s.themeOverride, vscode.ConfigurationTarget.Global);
  }
  if (typeof s.showUsage === "boolean") {
    void memento.update(SHOW_USAGE_KEY, s.showUsage);
  }
}

function pushSettingsToPanel(): void {
  const cfg = vscode.workspace.getConfiguration("hermes");
  panel?.setSettings({
    bridgeUrl: cfg.get<string>("bridgeUrl") || "",
    mode,
    themeOverride: (cfg.get<string>("theme") as ThemeOverride) || "auto",
    showUsage: memento.get<boolean>(SHOW_USAGE_KEY, true),
  });
}

async function openFileFromLink(p: string, line?: number): Promise<void> {
  const root = workspaceRoot();
  const abs = path.isAbsolute(p) ? p : root ? path.join(root, p) : p;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const ed = await vscode.window.showTextDocument(doc, { preview: true });
    if (typeof line === "number" && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch (e: any) {
    vscode.window.showWarningMessage(`Cannot open ${p}: ${e.message}`);
  }
}

// ─── Workspace + smart examples ─────────────────────────────────────────

function updateExamplesAndWorkspace(): void {
  if (!panel) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  panel.setWorkspace({
    name: folder?.name ?? null,
    branch: folder ? readGitBranch(folder.uri.fsPath) : null,
  });

  const ed = vscode.window.activeTextEditor;
  const examples: ExamplePrompt[] = [];
  if (ed && !ed.selection.isEmpty) {
    const sel = ed.document.getText(ed.selection);
    const preview = sel.length > 40 ? sel.slice(0, 40).replace(/\s+/g, " ") + "…" : sel.replace(/\s+/g, " ");
    examples.push({ icon: "🔍", text: `Explain this selection (${preview})`, prompt: "Explain what this selected code does." });
    examples.push({ icon: "🐛", text: "Find a bug in this selection", prompt: "Find any bugs in this selected code and propose a fix." });
    examples.push({ icon: "🧪", text: "Write a test for this selection", prompt: "Write a unit test for this selected code." });
  } else if (ed) {
    const fname = path.basename(ed.document.fileName);
    examples.push({ icon: "📖", text: `Explain ${fname}`, prompt: `Explain what ${fname} does.` });
    examples.push({ icon: "🔧", text: `Refactor ${fname}`, prompt: `Suggest refactorings for ${fname}.` });
    examples.push({ icon: "🐛", text: `Find bugs in ${fname}`, prompt: `Read ${fname} and list any bugs you find.` });
  } else if (folder) {
    examples.push({ icon: "📦", text: `What is this project?`, prompt: "Look at the project structure and tell me what this codebase does." });
    examples.push({ icon: "✨", text: `Generate a README`, prompt: "Generate a README.md for this project." });
    examples.push({ icon: "🔧", text: `Set up .gitignore`, prompt: "Generate a .gitignore appropriate for this project." });
  } else {
    examples.push({ icon: "💡", text: "Open a folder to get smarter suggestions" });
    examples.push({ icon: "🖼", text: "Paste a screenshot — I can see images" });
    examples.push({ icon: "📋", text: "Try Plan mode for big changes (/plan)" });
  }
  panel.setExamples(examples);
}

function readGitBranch(repoPath: string): string | null {
  try {
    const headPath = path.join(repoPath, ".git", "HEAD");
    if (!fs.existsSync(headPath)) return null;
    const head = fs.readFileSync(headPath, "utf8").trim();
    const m = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 7);
  } catch { return null; }
}

// ─── Connection / pairing (unchanged from v0.9.x) ─────────────────────────

function getCfg(): { baseUrl: string } {
  const c = vscode.workspace.getConfiguration("hermes");
  const explicit = (c.get<string>("bridgeUrl") || "").trim().replace(/\/+$/, "");
  if (explicit) return { baseUrl: isUsingFallback ? (memento.get<string>(FALLBACK_URL_KEY) || explicit) : explicit };
  const cached = (memento?.get<string>(DISCOVERED_KEY) || "").trim();
  return { baseUrl: cached };
}

async function refreshClient(): Promise<void> {
  let { baseUrl } = getCfg();
  if (!baseUrl) {
    panel?.setStatus("looking for bridge…", false);
    panel?.setState({ kind: "needsPair" });
    const found = await discover((s) => log(s));
    if (found) {
      await memento.update(DISCOVERED_KEY, found);
      baseUrl = found;
    } else {
      panel?.setStatus("no bridge configured", false, true);
      panel?.setState({ kind: "error", message: "Bridge URL not set" });
      return;
    }
  }
  const token = await secrets.get(TOKEN_KEY);
  client = new BridgeClient({ baseUrl, token: token ?? undefined });
  if (token) {
    panel?.setStatus(`connected · ${shortUrl(baseUrl)}`, false);
    panel?.setState({ kind: "ready" });
  } else {
    panel?.setStatus(`bridge ready · not paired`, false);
    panel?.setState({ kind: "needsPair" });
  }
}

async function rediscover(): Promise<void> {
  await memento.update(DISCOVERED_KEY, undefined);
  await memento.update(FALLBACK_URL_KEY, undefined);
  isUsingFallback = false;
  await refreshClient();
}

function shortUrl(u: string): string { try { return new URL(u).host; } catch { return u; } }

async function startPairing(): Promise<void> {
  const { baseUrl } = getCfg();
  if (!baseUrl) {
    vscode.window.showErrorMessage("Set Bridge URL in ⚙ Settings first.");
    return;
  }
  client = client ?? new BridgeClient({ baseUrl });
  pairAbort?.abort();
  pairAbort = new AbortController();
  let init;
  try { init = await client.pairInit(`VSCode on ${os.hostname()}`); }
  catch (e: any) { panel?.setState({ kind: "error", message: `pair init: ${e.message}` }); return; }
  panel?.setStatus("waiting for approval…", true);
  panel?.setState({ kind: "pairing", code: init.code, expiresIn: init.expiresIn });
  const deadline = Date.now() + Math.min(init.expiresIn, 300) * 1000;
  while (Date.now() < deadline) {
    if (pairAbort.signal.aborted) { panel?.setStatus("cancelled", false); panel?.setState({ kind: "needsPair" }); return; }
    await sleep(2000);
    try {
      const token = await client.pairPoll(init.code);
      if (token) {
        await secrets.store(TOKEN_KEY, token);
        client.setToken(token);
        await clearHistory();
        panel?.setStatus("paired ✓", false);
        panel?.setState({ kind: "ready" });
        return;
      }
    } catch (e: any) { panel?.setState({ kind: "error", message: e.message }); return; }
  }
  panel?.setStatus("pairing timed out", false, true);
  panel?.setState({ kind: "needsPair" });
}

function cancelPairing(): void { pairAbort?.abort(); }

// ─── Attachments ──────────────────────────────────────────────────────────

async function attachActiveFile(selectionOnly: boolean): Promise<void> {
  const f = await activeFile({ selectionOnly });
  if (!f) {
    vscode.window.showInformationMessage(
      selectionOnly ? "Select some text first, then click ✂️ Selection."
                    : "Open a file first, then click 📄 Attach active file."
    );
    return;
  }
  pending.files.push(f);
  refreshAttachmentsBar();
}

function attachImage(dataUrl: string): void {
  const id = "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  pending.images.push({ id, dataUrl });
  refreshAttachmentsBar();
}

function removeAttachment(id: string): void {
  pending.images = pending.images.filter((i) => i.id !== id);
  pending.files = pending.files.filter((f) => `f-${f.absPath}` !== id);
  refreshAttachmentsBar();
}

function clearPending(): void { pending.files = []; pending.images = []; refreshAttachmentsBar(); }

function refreshAttachmentsBar(): void {
  const items: AttachedDescriptor[] = [];
  for (const f of pending.files) items.push({ id: `f-${f.absPath}`, type: "file", label: `${f.label}${f.truncated ? " (truncated)" : ""}` });
  for (const i of pending.images) items.push({ id: i.id, type: "image", label: "screenshot", thumbnail: i.dataUrl });
  panel?.setAttachments(items);
}

// ─── Chat ─────────────────────────────────────────────────────────────────

async function sendPrompt(rawText: string): Promise<void> {
  if (!client || !(await secrets.get(TOKEN_KEY))) {
    panel?.setState({ kind: "needsPair" });
    return;
  }
  lastUserPrompt = rawText;
  const { prompt: cleanedPrompt, files: mentionFiles } = await resolveMentions(rawText);
  const allFiles = [...pending.files, ...mentionFiles];
  const filesBlock = renderFilesForPrompt(allFiles);
  const textPart = (filesBlock ? `${filesBlock}\n\n` : "") + cleanedPrompt;

  const parts: ContentPart[] = [{ type: "text", text: textPart }];
  for (const img of pending.images) parts.push({ type: "image_url", image_url: { url: img.dataUrl, detail: "auto" } });
  const userContent = pending.images.length > 0 ? parts : textPart;

  if (history.length === 0) {
    let sys = SYSTEM_PROMPT + "\n\n" + modeAddendum(mode);
    history.push({ role: "system", content: sys });
  }
  history.push({ role: "user", content: userContent });

  const summary = formatUserSummary(rawText, allFiles, pending.images.length);
  visibleLog.push({ role: "user", text: summary });
  persistHistory();
  clearPending();

  panel?.setStatus("thinking…", true);
  await streamChat();
}

async function streamChat(): Promise<void> {
  if (!client) return;
  chatAbort?.abort();
  chatAbort = new AbortController();
  let assistant = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;

  try {
    await client.chatStream(
      history,
      (chunk) => { assistant += chunk; panel?.push({ role: "assistant", text: chunk }); },
      { abort: chatAbort.signal, onUsage: (u) => { usage = u; } }
    );
    if (assistant.trim()) {
      history.push({ role: "assistant", content: assistant });
      visibleLog.push({ role: "assistant", text: assistant });

      const edits = parseEdits(assistant);
      const planLocked = mode === "plan" && !lastUserSaidGo();
      if (planLocked && edits.length) {
        log(`plan mode: ${edits.length} edit(s) suppressed`);
        visibleLog.push({ role: "system", text: `📋 ${edits.length} edit(s) prepared. Reply "go" to proceed.`, kind: "info" });
        panel?.push({ role: "system", text: `📋 ${edits.length} edit(s) prepared. Reply "go" to proceed.`, kind: "info" });
      } else if (edits.length > 1) {
        const clusterId = "cl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
        clusterIndex.set(clusterId, []);
        const cluster: ClusterDescriptor = {
          id: clusterId, count: edits.length,
          edits: edits.map((e) => {
            const id = makeEditId();
            editIndex.set(id, e);
            clusterIndex.get(clusterId)!.push(id);
            return { id, path: e.path, mode: e.mode, status: "pending" };
          })
        };
        panel?.pushCluster(cluster);
        const autoApply = mode === "auto";
        if (autoApply) for (const e of cluster.edits) autoApplyEdit(e.id, editIndex.get(e.id)!).catch(() => {});
      } else {
        for (const e of edits) {
          const id = makeEditId();
          editIndex.set(id, e);
          panel?.pushEdit({ id, path: e.path, mode: e.mode, status: "pending" });
          if (mode === "auto") autoApplyEdit(id, e).catch(() => {});
        }
      }
    }
    if (usage) {
      const u = usage as any;
      panel?.setUsage({ in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0 });
    }
    persistHistory();
    panel?.setStatus("ready", false);
  } catch (e: any) {
    panel?.setStatus("error", false, true);
    const msg = (e && e.message) ? e.message : String(e);
    if (chatAbort?.signal.aborted) {
      visibleLog.push({ role: "system", text: "[stopped]", kind: "info" });
      panel?.push({ role: "system", text: "[stopped]", kind: "info" });
    } else if (/HTTP 401/.test(msg)) {
      await secrets.delete(TOKEN_KEY);
      panel?.setState({ kind: "needsPair" });
      panel?.push({ role: "assistant", text: "Token rejected. Re-pair via Settings.", kind: "error" });
    } else if (await maybeFailoverAndRetry(msg)) {
      return;
    } else {
      panel?.push({ role: "assistant", text: `[error: ${msg}]`, kind: "error", retryable: true });
      log("chat error: " + msg);
    }
  }
}

async function maybeFailoverAndRetry(msg: string): Promise<boolean> {
  if (isUsingFallback) return false;
  if (!/HTTP 5\d\d|aborted|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed/i.test(msg)) return false;
  log("primary failed, trying fallback discovery");
  const found = await discover((s) => log(s));
  if (!found) return false;
  await memento.update(FALLBACK_URL_KEY, found);
  isUsingFallback = true;
  const token = await secrets.get(TOKEN_KEY);
  client = new BridgeClient({ baseUrl: found, token: token ?? undefined });
  panel?.setStatus(`fallback: ${shortUrl(found)}`, true);
  try { await streamChat(); return true; } catch { return false; }
}

function stopGeneration(): void { chatAbort?.abort(); }

async function retryLast(): Promise<void> {
  if (!lastUserPrompt) return;
  const lastUserIdx = [...history].reverse().findIndex((m) => m.role === "user");
  if (lastUserIdx >= 0) history.splice(history.length - lastUserIdx - 1);
  await sendPrompt(lastUserPrompt);
}

function makeEditId(): string {
  return "edit-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

async function reviewEditById(id: string): Promise<void> {
  const edit = editIndex.get(id);
  if (!edit) return;
  const root = workspaceRoot();
  if (!root) { vscode.window.showErrorMessage("Open a folder before applying edits."); return; }
  const result = await reviewEdit(edit, root);
  // Find which cluster (if any) this edit belongs to and update there
  let clusterId: string | undefined;
  for (const [cid, ids] of clusterIndex.entries()) {
    if (ids.includes(id)) { clusterId = cid; break; }
  }
  if (result === "applied") {
    if (clusterId) panel?.updateClusterEdit(clusterId, id, "applied");
    else panel?.updateEdit(id, "applied");
  } else if (result === "rejected") {
    if (clusterId) panel?.updateClusterEdit(clusterId, id, "rejected");
    else panel?.updateEdit(id, "rejected");
  }
}

async function autoApplyEdit(id: string, edit: ProposedEdit): Promise<void> {
  const root = workspaceRoot();
  if (!root) { vscode.window.showWarningMessage("Hermes proposed edit but no folder open."); return; }
  try {
    await applyEditNow(edit, root);
    panel?.updateEdit(id, "applied");
    const verb = edit.mode === "delete" ? "Deleted" : edit.mode === "create" ? "Created" : "Updated";
    vscode.window.showInformationMessage(`Hermes: ${verb} ${edit.path}`);
  } catch (e: any) {
    panel?.updateEdit(id, "rejected");
    vscode.window.showErrorMessage(`Hermes failed to apply ${edit.path}: ${e.message}`);
  }
}

async function applyCluster(clusterId: string): Promise<void> {
  const ids = clusterIndex.get(clusterId);
  if (!ids) return;
  const root = workspaceRoot();
  if (!root) { vscode.window.showErrorMessage("Open a folder first."); return; }
  let ok = 0, fail = 0;
  for (const id of ids) {
    const e = editIndex.get(id);
    if (!e) continue;
    try { await applyEditNow(e, root); panel?.updateClusterEdit(clusterId, id, "applied"); ok++; }
    catch { panel?.updateClusterEdit(clusterId, id, "rejected"); fail++; }
  }
  vscode.window.showInformationMessage(`Hermes: applied ${ok} edit(s)${fail ? `, ${fail} failed` : ""}.`);
}

function rejectCluster(clusterId: string): void {
  const ids = clusterIndex.get(clusterId);
  if (!ids) return;
  for (const id of ids) panel?.updateClusterEdit(clusterId, id, "rejected");
}

function workspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function modeAddendum(m: Mode): string {
  if (m === "auto") return `Mode: AUTO-EDIT — your hermes-edit blocks will be applied immediately. Be surgical.`;
  if (m === "plan") return `Mode: PLAN. BEFORE making any file change, present a numbered plan and ASK "Proceed?". Do NOT emit hermes-edit blocks until the user replies "go" / "yes" / "proceed".`;
  return `Mode: DEFAULT — each hermes-edit block becomes a Review card the user accepts/rejects.`;
}

function lastUserSaidGo(): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const c = history[i].content;
    const text = typeof c === "string" ? c : c.map((p: any) => p?.type === "text" ? p.text : "").join(" ");
    return /\b(go|yes|proceed|do it|давай|поехали|да|вперед|действуй)\b/i.test(text);
  }
  return false;
}

function formatUserSummary(prompt: string, files: AttachedFile[], imageCount: number): string {
  const parts: string[] = [];
  if (files.length) parts.push("📄 " + files.map((f) => f.label).join(", "));
  if (imageCount > 0) parts.push(`🖼 ${imageCount} image${imageCount > 1 ? "s" : ""}`);
  if (parts.length === 0) return prompt;
  return parts.join(" · ") + "\n\n" + prompt;
}

async function askAboutSelection(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showInformationMessage("No active editor."); return; }
  const hasSel = !ed.selection.isEmpty;
  await attachActiveFile(hasSel);
  panel?.reveal();
  const prompt = await vscode.window.showInputBox({
    prompt: hasSel ? "Ask Hermes about this selection" : "Ask Hermes about this file",
    placeHolder: "Explain / find bug / refactor / ..."
  });
  if (prompt) sendPrompt(prompt);
  else clearPending();
}

function persistHistory(): void {
  void workspaceMemento.update(HISTORY_KEY, history);
  void workspaceMemento.update(VISIBLE_LOG_KEY, visibleLog);
}

async function clearHistory(): Promise<void> {
  history = []; visibleLog = []; editIndex.clear(); clusterIndex.clear();
  clearPending();
  await workspaceMemento.update(HISTORY_KEY, undefined);
  await workspaceMemento.update(VISIBLE_LOG_KEY, undefined);
  panel?.loadHistory([]);
}

async function signOut(): Promise<void> {
  try {
    const t = await secrets.get(TOKEN_KEY);
    if (t && client) {
      const url = new URL("/pair/revoke", (client as any).cfg.baseUrl);
      const lib = url.protocol === "https:" ? require("node:https") : require("node:http");
      const req = lib.request({
        method: "POST", hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        headers: { "Authorization": `Bearer ${t}`, "Content-Length": 0 }
      });
      req.on("error", () => {});
      req.end();
    }
  } catch {}
  await secrets.delete(TOKEN_KEY);
  await clearHistory();
  await refreshClient();
  vscode.window.showInformationMessage("Hermes: signed out.");
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function log(msg: string): void { output.appendLine(`[${new Date().toISOString()}] ${msg}`); }
