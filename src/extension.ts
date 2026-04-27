import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { BridgeClient, ChatMessage, ContentPart } from "./bridgeClient";
import { ChatPanel, AttachedDescriptor, ChatMessageOut, Mode } from "./chatPanel";
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

let mode: Mode = "default";

let client: BridgeClient | null = null;
let panel: ChatPanel | null = null;
let history: ChatMessage[] = [];
let visibleLog: ChatMessageOut[] = [];   // what's shown in the panel; persisted
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
const clusterIndex = new Map<string, string[]>(); // clusterId → editIds

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

Examples:

  User: "create hello.txt with the text 'hi'"
  You:
  ~~~hermes-edit path=hello.txt mode=create
  hi
  ~~~

  User: "fix the bug in src/add.ts"
  You: I see the operator is wrong.
  ~~~hermes-edit path=src/add.ts mode=replace
  export function add(a: number, b: number): number {
    return a + b;
  }
  ~~~

  User: "delete tmp/foo.log"
  You:
  ~~~hermes-edit path=tmp/foo.log mode=delete
  ~~~

Context:
The user can attach files and screenshots to their messages. Treat any \`\`\`<lang> path=...\`\`\`
fenced blocks in their message as the *current* contents of those files. Outside hermes-edit
blocks, write concise markdown (headings, lists, **bold**, \`code\`, fenced blocks) — the editor renders it.`;

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
    onOpenSettings: () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "hermes"),
    onAttachFile: () => attachActiveFile(false),
    onAttachSelection: () => attachActiveFile(true),
    onRemoveAttachment: (id) => removeAttachment(id),
    onPasteImage: (dataUrl) => attachImage(dataUrl),
    onReviewEdit: (id) => reviewEditById(id),
    onApplyCluster: (cid) => applyCluster(cid),
    onRejectCluster: (cid) => rejectCluster(cid),
    onStop: () => stopGeneration(),
    onRetry: () => retryLast(),
    onModeChange: (m) => setMode(m)
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
    vscode.commands.registerCommand("hermes.checkForUpdates", () =>
      checkForUpdates(ctx, log, { silent: false }))
  );

  // Auto check for updates 5s after activate (silent — only nags if newer exists)
  setTimeout(() => checkForUpdates(ctx, log, { silent: true }).catch(() => {}), 5000);

  // Restore persisted state for this workspace
  const savedHistory = workspaceMemento.get<ChatMessage[]>(HISTORY_KEY) || [];
  const savedLog = workspaceMemento.get<ChatMessageOut[]>(VISIBLE_LOG_KEY) || [];
  const savedMode = (memento.get<string>(MODE_KEY) as Mode | undefined) || "default";
  history = savedHistory;
  visibleLog = savedLog;
  mode = savedMode;
  panel.setMode(mode);
  if (visibleLog.length) panel.loadHistory(visibleLog);

  refreshClient().catch((e) => log("activate failed: " + String(e)));
}

function setMode(m: Mode): void {
  mode = m;
  void memento.update(MODE_KEY, m);
  panel?.setMode(m);
  pushAndPersist({
    role: "system",
    text: `Mode: ${m === "default" ? "🛡 Default — review each edit"
                : m === "auto"    ? "⚡ Auto-edit — apply without asking"
                : "📋 Plan — Hermes plans first, executes after your 'go'"}`,
    kind: "info"
  });
  // History continuity: reset agent context so the new mode prompt takes effect
  // on next turn. We keep visibleLog so the chat doesn't appear wiped.
  history = [];
  persistHistory();
}

export function deactivate(): void {
  pairAbort?.abort();
  chatAbort?.abort();
}

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
    panel?.setStatus("looking for hermes-bridge…");
    panel?.setState({ kind: "needsPair" });
    const found = await discover((s) => log(s));
    if (found) {
      await memento.update(DISCOVERED_KEY, found);
      baseUrl = found;
    } else {
      panel?.setStatus("no bridge found — set URL in Settings");
      panel?.setState({ kind: "error", message: "Could not auto-discover hermes-bridge" });
      return;
    }
  }
  const token = await secrets.get(TOKEN_KEY);
  client = new BridgeClient({ baseUrl, token: token ?? undefined });
  if (token) {
    panel?.setStatus(`connected · ${shortUrl(baseUrl)}`);
    panel?.setState({ kind: "ready" });
  } else {
    panel?.setStatus(`found bridge · ${shortUrl(baseUrl)} · not paired`);
    panel?.setState({ kind: "needsPair" });
  }
}

async function rediscover(): Promise<void> {
  await memento.update(DISCOVERED_KEY, undefined);
  await memento.update(FALLBACK_URL_KEY, undefined);
  isUsingFallback = false;
  await refreshClient();
}

function shortUrl(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

// ─── Pairing ──────────────────────────────────────────────────────────────

async function startPairing(): Promise<void> {
  const { baseUrl } = getCfg();
  if (!baseUrl) {
    vscode.window.showErrorMessage("Set 'Hermes › Bridge URL' in settings first.");
    return;
  }
  client = client ?? new BridgeClient({ baseUrl });
  pairAbort?.abort();
  pairAbort = new AbortController();

  const clientName = `VSCode on ${os.hostname()}`;
  let init;
  try { init = await client.pairInit(clientName); }
  catch (e: any) {
    panel?.setState({ kind: "error", message: `pair init failed: ${e.message}` });
    return;
  }

  panel?.setStatus("waiting for approval in Telegram…");
  panel?.setState({ kind: "pairing", code: init.code, expiresIn: init.expiresIn });

  const deadline = Date.now() + Math.min(init.expiresIn, 300) * 1000;
  while (Date.now() < deadline) {
    if (pairAbort.signal.aborted) {
      panel?.setStatus("pairing cancelled");
      panel?.setState({ kind: "needsPair" });
      return;
    }
    await sleep(2000);
    try {
      const token = await client.pairPoll(init.code);
      if (token) {
        await secrets.store(TOKEN_KEY, token);
        client.setToken(token);
        await clearHistory();
        panel?.setStatus("paired ✓");
        panel?.setState({ kind: "ready" });
        return;
      }
    } catch (e: any) {
      panel?.setState({ kind: "error", message: e.message });
      return;
    }
  }
  panel?.setStatus("pairing timed out");
  panel?.setState({ kind: "needsPair" });
}

function cancelPairing(): void { pairAbort?.abort(); }

// ─── Attachments ──────────────────────────────────────────────────────────

async function attachActiveFile(selectionOnly: boolean): Promise<void> {
  const f = await activeFile({ selectionOnly });
  if (!f) {
    vscode.window.showInformationMessage(
      selectionOnly
        ? "No text selected in the active editor — select something first, then click ✂️."
        : "No active editor — open a file first, then click 📄."
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
  for (const f of pending.files) {
    items.push({
      id: `f-${f.absPath}`,
      type: "file",
      label: `${f.label}${f.truncated ? " (truncated)" : ""}`
    });
  }
  for (const i of pending.images) {
    items.push({ id: i.id, type: "image", label: "screenshot", thumbnail: i.dataUrl });
  }
  panel?.setAttachments(items);
}

// ─── Workspace tree (auto context) ────────────────────────────────────────

async function workspaceTree(maxEntries = 100): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "";
  const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", "out", "__pycache__", ".next", ".vscode-test", "target"]);
  const entries: string[] = [];
  async function walk(uri: vscode.Uri, depth: number, prefix: string): Promise<void> {
    if (entries.length >= maxEntries || depth > 3) return;
    let items: [string, vscode.FileType][];
    try { items = await vscode.workspace.fs.readDirectory(uri); }
    catch { return; }
    items.sort(([a], [b]) => a.localeCompare(b));
    for (const [name, kind] of items) {
      if (entries.length >= maxEntries) return;
      if (name.startsWith(".") && name !== ".env.example") continue;
      if (SKIP.has(name)) continue;
      const rel = path.posix.join(prefix, name);
      entries.push(rel + (kind === vscode.FileType.Directory ? "/" : ""));
      if (kind === vscode.FileType.Directory) {
        await walk(vscode.Uri.joinPath(uri, name), depth + 1, rel);
      }
    }
  }
  await walk(folder.uri, 0, "");
  if (!entries.length) return "";
  return `Workspace tree (top ${entries.length}):\n` + entries.join("\n");
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
  for (const img of pending.images) {
    parts.push({ type: "image_url", image_url: { url: img.dataUrl, detail: "auto" } });
  }
  const userContent = pending.images.length > 0 ? parts : textPart;

  // System prompt + workspace tree + mode-specific addendum on first turn
  if (history.length === 0) {
    const tree = await workspaceTree();
    let sys = tree ? `${SYSTEM_PROMPT}\n\n${tree}` : SYSTEM_PROMPT;
    sys += "\n\n" + modeAddendum(mode);
    history.push({ role: "system", content: sys });
  }
  history.push({ role: "user", content: userContent });

  const summary = formatUserSummary(rawText, allFiles, pending.images.length);
  // Don't push to panel — webview already echoed the user's text immediately.
  // Just persist for history restoration after reload.
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
      (chunk) => {
        assistant += chunk;
        panel?.push({ role: "assistant", text: chunk });
      },
      {
        abort: chatAbort.signal,
        onUsage: (u) => { usage = u; }
      }
    );
    if (assistant.trim()) {
      history.push({ role: "assistant", content: assistant });
      visibleLog.push({ role: "assistant", text: assistant });
      const edits = parseEdits(assistant);

      // PLAN mode: suppress edit-card rendering until the user has explicitly
      // said "go" since the most recent assistant turn. The model should
      // already be following this — this is a belt-and-suspenders gate.
      const planLocked = mode === "plan" && !lastUserSaidGo();

      if (planLocked && edits.length) {
        log(`plan mode: ${edits.length} edit block(s) suppressed; user must confirm with 'go'`);
        pushAndPersist({
          role: "system",
          text: `📋 ${edits.length} edit(s) prepared. Reply "go" to proceed.`,
          kind: "info"
        });
      } else {
        if (edits.length > 1) {
          const clusterId = "cl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
          clusterIndex.set(clusterId, []);
          panel?.pushClusterBar(clusterId, edits.length);
          for (const e of edits) {
            const id = makeEditId();
            editIndex.set(id, e);
            clusterIndex.get(clusterId)!.push(id);
            panel?.pushEdit({ id, path: e.path, mode: e.mode, status: "pending" });
          }
        } else {
          for (const e of edits) {
            const id = makeEditId();
            editIndex.set(id, e);
            panel?.pushEdit({ id, path: e.path, mode: e.mode, status: "pending" });
          }
        }
        const autoApply = mode === "auto"
          || vscode.workspace.getConfiguration("hermes").get<boolean>("autoApply", false);
        if (autoApply) {
          for (const [id, e] of editIndex.entries()) {
            autoApplyEdit(id, e).catch((err) => log("autoApply: " + err));
          }
        }
      }
    }
    if (usage) {
      const u = usage as any;
      const usageText = `tokens — in: ${u.prompt_tokens ?? "?"}  out: ${u.completion_tokens ?? "?"}  total: ${u.total_tokens ?? "?"}`;
      pushAndPersist({ role: "system", text: usageText, kind: "usage" });
    }
    persistHistory();
    panel?.setStatus("ready", false);
  } catch (e: any) {
    panel?.setStatus("error", false);
    const msg = (e && e.message) ? e.message : String(e);
    if (chatAbort?.signal.aborted) {
      pushAndPersist({ role: "system", text: "[stopped]", kind: "info" });
    } else if (/HTTP 401/.test(msg)) {
      await secrets.delete(TOKEN_KEY);
      panel?.setState({ kind: "needsPair" });
      pushAndPersist({ role: "assistant", text: "Token rejected. Re-pair.", kind: "error" });
    } else if (await maybeFailoverAndRetry(msg)) {
      return;  // retry succeeded via fallback
    } else {
      pushAndPersist({ role: "assistant", text: `[error: ${msg}]`, kind: "error", retryable: true });
      log("chat error: " + msg);
    }
  }
}

/** If chat fails with a transport-level error, try discovering a fallback URL
 *  (Tailscale peer) and retry the same history once. */
async function maybeFailoverAndRetry(msg: string): Promise<boolean> {
  if (isUsingFallback) return false;
  if (!/HTTP 5\d\d|aborted|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed/i.test(msg)) {
    return false;
  }
  log("primary failed (" + msg + "), trying fallback discovery");
  const found = await discover((s) => log(s));
  if (!found) return false;
  await memento.update(FALLBACK_URL_KEY, found);
  isUsingFallback = true;
  const token = await secrets.get(TOKEN_KEY);
  client = new BridgeClient({ baseUrl: found, token: token ?? undefined });
  panel?.setStatus(`fallback: ${shortUrl(found)}`, true);
  // Retry once
  try {
    await streamChat();
    return true;
  } catch {
    return false;
  }
}

function stopGeneration(): void {
  chatAbort?.abort();
}

async function retryLast(): Promise<void> {
  if (!lastUserPrompt) return;
  // Roll back history to before the last user message
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
  if (!root) {
    vscode.window.showErrorMessage("Open a folder/workspace before applying Hermes edits.");
    return;
  }
  const result = await reviewEdit(edit, root);
  if (result === "applied") panel?.updateEdit(id, "applied");
  else if (result === "rejected") panel?.updateEdit(id, "rejected");
}

async function autoApplyEdit(id: string, edit: ProposedEdit): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Hermes proposed an edit but no folder is open.");
    return;
  }
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
    try { await applyEditNow(e, root); panel?.updateEdit(id, "applied"); ok++; }
    catch { panel?.updateEdit(id, "rejected"); fail++; }
  }
  vscode.window.showInformationMessage(`Hermes: applied ${ok} edit(s)${fail ? `, ${fail} failed` : ""}.`);
}

function rejectCluster(clusterId: string): void {
  const ids = clusterIndex.get(clusterId);
  if (!ids) return;
  for (const id of ids) panel?.updateEdit(id, "rejected");
}

function workspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function modeAddendum(m: Mode): string {
  if (m === "auto") {
    return `Mode: AUTO-EDIT. The user has enabled auto-apply — your hermes-edit blocks will be applied immediately without their review. Be careful and surgical: avoid unrelated changes, prefer minimal diffs, double-check paths.`;
  }
  if (m === "plan") {
    return `Mode: PLAN. Before making ANY file change, you must FIRST present a numbered plan and ASK the user "Proceed?" — do NOT emit any \`~~~hermes-edit~~~\` blocks yet. Wait for the user to reply with "go" / "yes" / "proceed" / "do it" or similar confirmation. ONLY in your reply AFTER that confirmation may you emit hermes-edit blocks. If the user wants changes to the plan, revise the plan and ask again.`;
  }
  return `Mode: DEFAULT. Each hermes-edit block you emit will be shown to the user as a Review card; they will accept or reject each one individually.`;
}

function lastUserSaidGo(): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const c = history[i].content;
    const text = typeof c === "string"
      ? c
      : c.map((p: any) => p?.type === "text" ? p.text : "").join(" ");
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

// ─── "Ask about this" command from editor ─────────────────────────────────

async function askAboutSelection(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showInformationMessage("No active editor."); return; }
  const hasSel = !ed.selection.isEmpty;
  await attachActiveFile(hasSel);
  panel?.reveal();
  const prompt = await vscode.window.showInputBox({
    prompt: hasSel ? "Ask Hermes about this selection" : "Ask Hermes about this file",
    placeHolder: "Explain what this does / find the bug / suggest a refactor / ..."
  });
  if (prompt) sendPrompt(prompt);
  else clearPending();
}

// ─── Persistence ──────────────────────────────────────────────────────────

function pushAndPersist(m: ChatMessageOut): void {
  visibleLog.push(m);
  panel?.push(m);
  persistHistory();
}

function persistHistory(): void {
  void workspaceMemento.update(HISTORY_KEY, history);
  void workspaceMemento.update(VISIBLE_LOG_KEY, visibleLog);
}

async function clearHistory(): Promise<void> {
  history = [];
  visibleLog = [];
  editIndex.clear();
  clusterIndex.clear();
  clearPending();
  await workspaceMemento.update(HISTORY_KEY, undefined);
  await workspaceMemento.update(VISIBLE_LOG_KEY, undefined);
  panel?.loadHistory([]);
}

// ─── auth ────────────────────────────────────────────────────────────────

async function signOut(): Promise<void> {
  // Best-effort revoke at the bridge — fire-and-forget; works even if offline
  try {
    const t = await secrets.get(TOKEN_KEY);
    if (t && client) {
      // POST /pair/revoke (we don't have a method on the client; do raw)
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
  } catch { /* ignore */ }
  await secrets.delete(TOKEN_KEY);
  await clearHistory();
  await refreshClient();
  vscode.window.showInformationMessage("Hermes: signed out.");
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function log(msg: string): void { output.appendLine(`[${new Date().toISOString()}] ${msg}`); }
