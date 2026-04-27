import * as vscode from "vscode";

export type PanelState =
  | { kind: "needsPair" }
  | { kind: "pairing"; code: string; expiresIn: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type Mode = "default" | "auto" | "plan";
export type ThemeOverride = "auto" | "light" | "dark";

export interface ChatMessageOut {
  role: "user" | "assistant" | "system";
  text: string;
  kind?: string;
  retryable?: boolean;
  /** For assistant messages: append to the LAST assistant bubble's footer. */
  usage?: { in: number; out: number };
  markdown?: boolean;
}

export interface AttachedDescriptor {
  id: string;
  type: "file" | "image";
  label: string;
  thumbnail?: string;
}

export interface EditDescriptor {
  id: string;
  path: string;
  mode: "replace" | "create" | "delete";
  status: "pending" | "applied" | "rejected";
}

export interface ClusterDescriptor {
  id: string;
  count: number;
  edits: { id: string; path: string; mode: "replace" | "create" | "delete"; status: "pending" | "applied" | "rejected" }[];
}

export interface ExamplePrompt {
  icon: string;
  text: string;
  /** Optional fully-qualified prompt to send (defaults to text). */
  prompt?: string;
}

export interface WorkspaceInfo {
  name: string | null;
  branch?: string | null;
}

export interface ChatPanelHandlers {
  onPair: () => void;
  onCancelPair: () => void;
  onPrompt: (text: string) => void;
  onClear: () => void;
  onAttachFile: () => void;
  onAttachSelection: () => void;
  onRemoveAttachment: (id: string) => void;
  onPasteImage: (base64DataUrl: string) => void;
  onReviewEdit: (id: string) => void;
  onApplyCluster: (clusterId: string) => void;
  onRejectCluster: (clusterId: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onModeChange: (mode: Mode) => void;
  /** Settings: { bridgeUrl?, mode?, themeOverride?, showUsage? } */
  onSettingsChange: (s: { bridgeUrl?: string; mode?: Mode; themeOverride?: ThemeOverride; showUsage?: boolean }) => void;
  /** Open a file at optional line via vscode.commands. */
  onOpenFile: (path: string, line?: number) => void;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "hermes.chatView";
  private view?: vscode.WebviewView;
  private queued: { type: string; payload: any }[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: ChatPanelHandlers
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    for (const q of this.queued) view.webview.postMessage({ type: q.type, ...q.payload });
    this.queued = [];
  }

  setState(s: PanelState): void { this.post("state", { state: s }); }
  push(m: ChatMessageOut): void { this.post("message", m); }
  setStatus(text: string, busy = false, errored = false): void { this.post("status", { text, busy, errored }); }
  reveal(): void { this.view?.show?.(true); }
  setAttachments(items: AttachedDescriptor[]): void { this.post("attachments", { items }); }
  pushEdit(e: EditDescriptor): void { this.post("edit", e); }
  updateEdit(id: string, status: EditDescriptor["status"]): void { this.post("editStatus", { id, status }); }
  pushCluster(c: ClusterDescriptor): void { this.post("cluster", c); }
  updateClusterEdit(clusterId: string, editId: string, status: EditDescriptor["status"]): void {
    this.post("clusterEditStatus", { clusterId, editId, status });
  }
  loadHistory(items: ChatMessageOut[]): void { this.post("loadHistory", { items }); }
  setMode(mode: Mode): void { this.post("mode", { mode }); }
  setExamples(items: ExamplePrompt[]): void { this.post("examples", { items }); }
  setWorkspace(info: WorkspaceInfo): void { this.post("workspace", info); }
  setSettings(s: { bridgeUrl: string; mode: Mode; themeOverride: ThemeOverride; showUsage: boolean }): void {
    this.post("settings", s);
  }
  setUsage(usage: { in: number; out: number; cost?: string }): void { this.post("usage", usage); }

  private post(type: string, payload: any): void {
    if (!this.view) { this.queued.push({ type, payload }); return; }
    this.view.webview.postMessage({ type, ...payload });
  }

  private onMessage(m: any): void {
    switch (m?.type) {
      case "pair": this.handlers.onPair(); break;
      case "cancelPair": this.handlers.onCancelPair(); break;
      case "prompt":
        if (typeof m.text === "string" && m.text.trim()) this.handlers.onPrompt(m.text);
        break;
      case "clear": this.handlers.onClear(); break;
      case "attachFile": this.handlers.onAttachFile(); break;
      case "attachSelection": this.handlers.onAttachSelection(); break;
      case "removeAttachment":
        if (typeof m.id === "string") this.handlers.onRemoveAttachment(m.id);
        break;
      case "pasteImage":
        if (typeof m.dataUrl === "string") this.handlers.onPasteImage(m.dataUrl);
        break;
      case "reviewEdit":
        if (typeof m.id === "string") this.handlers.onReviewEdit(m.id);
        break;
      case "applyCluster":
        if (typeof m.clusterId === "string") this.handlers.onApplyCluster(m.clusterId);
        break;
      case "rejectCluster":
        if (typeof m.clusterId === "string") this.handlers.onRejectCluster(m.clusterId);
        break;
      case "stop": this.handlers.onStop(); break;
      case "retry": this.handlers.onRetry(); break;
      case "setMode":
        if (m.mode === "default" || m.mode === "auto" || m.mode === "plan") this.handlers.onModeChange(m.mode);
        break;
      case "settingsChange":
        this.handlers.onSettingsChange(m.value || {});
        break;
      case "openFile":
        if (typeof m.path === "string") this.handlers.onOpenFile(m.path, m.line);
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root{
  color-scheme: light dark;
  --hermes-accent: var(--vscode-focusBorder, #0e639c);
  --hermes-radius: 12px;
  --hermes-radius-sm: 8px;
  --hermes-gap: 8px;
  --hermes-bubble-bg: rgba(127,127,127,.06);
  --hermes-bubble-border: rgba(127,127,127,.16);
}
@supports (background: color-mix(in srgb, red, blue)) {
  :root {
    --hermes-bubble-bg: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
    --hermes-bubble-border: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  }
}
*{box-sizing:border-box;}
body{
  margin:0;display:flex;flex-direction:column;height:100vh;
  font-family:var(--vscode-font-family);
  color:var(--vscode-foreground,#1f2937);
  background:var(--vscode-sideBar-background,#fafafa);
  font-size:var(--vscode-font-size,13px);
  line-height:1.5;overflow-wrap:anywhere;
}

/* ─── HEADER ─── */
header{
  display:flex;align-items:center;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--vscode-panel-border);
  background:transparent;font-size:11.5px;
}
.ws{display:flex;align-items:center;gap:4px;min-width:0;opacity:.75;}
.ws .ws-icon{font-size:13px;}
.ws .ws-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ws .ws-branch{opacity:.6;font-family:var(--vscode-editor-font-family);font-size:10.5px;
  padding:1px 6px;border-radius:999px;background:var(--vscode-input-background,#eee);}
.spacer{flex:1;}
.h-btn{
  background:transparent;color:var(--vscode-foreground,#1f2937);border:none;
  padding:4px 6px;cursor:pointer;font-size:14px;line-height:1;border-radius:4px;
  opacity:.6;transition:opacity .12s,background .12s;
}
.h-btn:hover{opacity:1;background:var(--vscode-list-hoverBackground);}
.dot{
  width:8px;height:8px;border-radius:50%;background:#3fb950;
  cursor:default;transition:background .15s,box-shadow .15s;
  position:relative;
}
.dot.busy{background:#d29922;animation:pulse 1.4s infinite;}
.dot.error{background:#f85149;}
@keyframes pulse{50%{box-shadow:0 0 0 4px rgba(210,153,34,.18);}}
.dot:hover::after{
  content: attr(data-tip); position:absolute; right:0; top:14px;
  background:var(--vscode-editor-background,#fff); color:var(--vscode-foreground,#1f2937);
  border:1px solid var(--vscode-panel-border); border-radius:4px;
  padding:3px 8px; font-size:10px; white-space:nowrap;
  box-shadow:0 2px 6px rgba(0,0,0,.15); z-index:50;
}

/* ─── SETTINGS PANEL ─── */
.settings-sheet{
  display:none; position:absolute; top:34px; right:8px; z-index:60;
  background:var(--vscode-editor-background,#fff); color:var(--vscode-foreground,#1f2937);
  border:1px solid var(--vscode-panel-border); border-radius:var(--hermes-radius-sm);
  width:min(320px, calc(100vw - 16px));
  box-shadow:0 6px 24px rgba(0,0,0,.18);
  animation:slideDown .16s ease;
}
.settings-sheet.show{display:block;}
@keyframes slideDown{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}
.settings-sheet h3{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.6;
  margin:12px 12px 4px;font-weight:600;}
.settings-row{padding:6px 12px;display:flex;flex-direction:column;gap:4px;}
.settings-row label{font-size:11px;opacity:.7;}
.settings-row input[type=text],.settings-row select{
  background:var(--vscode-input-background,#fff); color:var(--vscode-input-foreground,inherit);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border)); padding:4px 6px;
  border-radius:4px; font:inherit; font-size:12px; outline:none;
}
.settings-row input:focus,.settings-row select:focus{border-color:var(--hermes-accent);}
.settings-row.cb{flex-direction:row;align-items:center;gap:6px;}
.settings-row.cb label{order:2;flex:1;font-size:12px;opacity:.85;}

/* ─── PAIR VIEW ─── */
#pair{padding:24px 16px;display:none;flex-direction:column;gap:14px;align-items:center;text-align:center;}
.big-logo{
  width:56px;height:56px;border-radius:50%;
  background:linear-gradient(135deg,var(--hermes-accent),#8a2be2);
  display:grid;place-items:center;color:#fff;font-size:26px;
  box-shadow:0 4px 12px rgba(0,0,0,.15);
}
#pair h2{margin:0;font-size:14px;font-weight:600;}
#pair p{margin:0;opacity:.7;line-height:1.5;max-width:340px;font-size:12.5px;}
.code{
  font-family:var(--vscode-editor-font-family);font-size:24px;letter-spacing:6px;font-weight:600;
  padding:12px 20px;background:var(--vscode-input-background);
  border:1px solid var(--hermes-accent);border-radius:var(--hermes-radius-sm);
}
.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.spinner{display:inline-block;width:10px;height:10px;border:2px solid transparent;
  border-top-color:currentColor;border-radius:50%;animation:spin 1s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}

/* ─── CHAT ─── */
#chat{flex:1;display:none;flex-direction:column;min-height:0;position:relative;}
#log{flex:1;overflow-y:auto;padding:10px 12px 8px;display:flex;flex-direction:column;gap:6px;scroll-behavior:smooth;}

/* Bubbles: vertical accent stripe + tinted bg, no avatars */
.msg{
  position:relative;padding:8px 12px 8px 14px;
  color:var(--vscode-foreground,#1f2937);
  border-radius:var(--hermes-radius);border-top-left-radius:var(--hermes-radius-sm);
  animation:slideIn .2s ease;line-height:1.5;
}
@keyframes slideIn{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:translateY(0);}}

.msg.user{
  background:var(--vscode-input-background,#f3f4f6);
  border-left:3px solid var(--hermes-accent);
  white-space:pre-wrap;
}
.msg.assistant{
  background:var(--hermes-bubble-bg);
  border-left:3px solid var(--hermes-bubble-border);
}
.msg.assistant.md p{margin:0 0 6px;}
.msg.assistant.md p:last-child{margin-bottom:0;}
.msg.assistant.md h1,.msg.assistant.md h2,.msg.assistant.md h3{margin:8px 0 4px;font-weight:600;font-size:14px;}
.msg.assistant.md h1{font-size:15px;}
.msg.assistant.md ul,.msg.assistant.md ol{margin:2px 0 6px;padding-left:18px;}
.msg.assistant.md li{margin:1px 0;}
.msg.assistant.md blockquote{border-left:2px solid var(--hermes-accent);padding-left:8px;margin:4px 0;opacity:.85;}
.msg.assistant.md hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:6px 0;}
.msg.assistant.md a{color:var(--vscode-textLink-foreground,var(--hermes-accent));text-decoration:none;}
.msg.assistant.md a:hover{text-decoration:underline;}
.msg.assistant.md strong{font-weight:600;}
.msg.assistant.md em{font-style:italic;}
.msg.assistant.md .file-link{
  color:var(--vscode-textLink-foreground,var(--hermes-accent));
  text-decoration:none;font-family:var(--vscode-editor-font-family);font-size:.92em;
  background:var(--vscode-input-background,transparent);padding:0 4px;border-radius:3px;
  cursor:pointer;
}
.msg.assistant.md .file-link:hover{text-decoration:underline;}
.msg.assistant.md table{
  border-collapse:collapse;margin:6px 0;font-size:12px;
}
.msg.assistant.md th,.msg.assistant.md td{
  border:1px solid var(--vscode-panel-border);padding:3px 8px;text-align:left;
}
.msg.assistant.md th{background:var(--vscode-input-background,#f5f5f5);font-weight:600;}

.msg.assistant.md code{
  font-family:var(--vscode-editor-font-family);
  background:var(--vscode-textBlockQuote-background,rgba(127,127,127,.1));
  padding:1px 5px;border-radius:3px;font-size:12px;
}
.code-wrap{position:relative;margin:6px 0;}
.code-wrap .lang-label{
  position:absolute;top:-1px;right:8px;
  padding:1px 8px;font-size:9.5px;letter-spacing:.5px;text-transform:uppercase;
  background:var(--vscode-panel-border);color:var(--vscode-foreground,#1f2937);opacity:.7;
  border-radius:0 0 4px 4px;font-family:var(--vscode-editor-font-family);
}
.code-wrap .copy-btn{
  position:absolute;top:4px;right:4px;
  background:var(--vscode-button-background);color:var(--vscode-button-foreground);
  border:none;padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;
  opacity:0;transition:opacity .12s;
}
.code-wrap:hover .copy-btn{opacity:1;}
.code-wrap .copy-btn.done{background:#3fb950;color:#fff;}
.msg.assistant.md pre{
  background:var(--vscode-textBlockQuote-background,rgba(127,127,127,.08));
  padding:10px 12px 8px;border-radius:var(--hermes-radius-sm);
  overflow-x:auto;margin:0;font-size:12px;
  border:1px solid var(--vscode-panel-border);
}
.msg.assistant.md pre code{background:none;padding:0;}

.msg.system{
  background:transparent;font-style:italic;opacity:.7;font-size:11.5px;
  border-left:none;padding:2px 12px;
}
.msg.error{
  background:var(--vscode-inputValidation-errorBackground,rgba(220,38,38,.12));
  color:var(--vscode-inputValidation-errorForeground,#dc2626);
  border-left:3px solid #dc2626;
}
.msg.error .retry-btn{
  background:transparent;color:inherit;border:1px solid currentColor;
  padding:3px 10px;font-size:11px;cursor:pointer;border-radius:4px;margin-top:6px;
}

/* Token-usage footer inside the assistant bubble */
.usage-footer{
  margin-top:6px;padding-top:5px;border-top:1px solid var(--hermes-bubble-border);
  font-family:var(--vscode-editor-font-family);font-size:10px;opacity:.5;
  display:flex;gap:8px;
}

/* Typing indicator */
.typing{display:inline-flex;gap:3px;align-items:center;padding:3px 0;}
.typing span{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.4;animation:bounce 1.4s infinite ease-in-out;}
.typing span:nth-child(2){animation-delay:.16s;}
.typing span:nth-child(3){animation-delay:.32s;}
@keyframes bounce{0%,80%,100%{transform:scale(.6);opacity:.4;}40%{transform:scale(1);opacity:1;}}

/* Syntax tokens — high-contrast default; dark theme upgrade */
.tk-kw{color:#7c3aed;}
.tk-str{color:#15803d;}
.tk-num{color:#b45309;}
.tk-com{color:#6b7280;font-style:italic;}
.tk-fn{color:#1d4ed8;}
body.vscode-dark .tk-kw,body[data-vscode-theme-kind*="dark"] .tk-kw,body.hermes-dark .tk-kw{color:#c792ea;}
body.vscode-dark .tk-str,body[data-vscode-theme-kind*="dark"] .tk-str,body.hermes-dark .tk-str{color:#c3e88d;}
body.vscode-dark .tk-num,body[data-vscode-theme-kind*="dark"] .tk-num,body.hermes-dark .tk-num{color:#f78c6c;}
body.vscode-dark .tk-com,body[data-vscode-theme-kind*="dark"] .tk-com,body.hermes-dark .tk-com{color:#8b97b1;font-style:italic;}
body.vscode-dark .tk-fn,body[data-vscode-theme-kind*="dark"] .tk-fn,body.hermes-dark .tk-fn{color:#82aaff;}

/* Cluster card (collapsible multi-edit) */
.cluster{
  margin:8px 0;border:1px solid var(--hermes-accent);border-radius:var(--hermes-radius-sm);
  background:var(--hermes-bubble-bg);overflow:hidden;animation:slideIn .2s ease;
}
.cluster .head{
  display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;
  user-select:none;transition:background .12s;
}
.cluster .head:hover{background:var(--vscode-list-hoverBackground);}
.cluster .head .icon{font-size:14px;}
.cluster .head .label{flex:1;font-weight:500;font-size:12px;}
.cluster .head .chevron{transition:transform .15s;font-size:10px;opacity:.6;}
.cluster.expanded .head .chevron{transform:rotate(90deg);}
.cluster .body{display:none;padding:0 10px 8px;border-top:1px solid var(--hermes-bubble-border);}
.cluster.expanded .body{display:block;}
.cluster .actions{display:flex;gap:6px;padding:6px 10px;border-top:1px solid var(--hermes-bubble-border);background:var(--vscode-input-background,transparent);}
.cluster .actions button{flex:1;padding:5px;font-size:11px;}

/* Single edit card (and rows inside cluster) */
.edit{
  margin:6px 0;padding:6px 10px;border:1px solid var(--vscode-panel-border);
  border-radius:var(--hermes-radius-sm);background:var(--vscode-input-background,transparent);
  display:flex;align-items:center;gap:8px;font-size:12px;
  animation:slideIn .2s ease;
}
.edit:hover{border-color:var(--hermes-accent);}
.edit.applied{border-color:#3fb950;background:rgba(63,185,80,.06);}
.edit.rejected{opacity:.45;}
.edit .icon{font-size:14px;flex-shrink:0;}
.edit .meta{flex:1;min-width:0;}
.edit .path{font-family:var(--vscode-editor-font-family);font-size:11.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.edit .mode-tag{font-size:9.5px;text-transform:uppercase;opacity:.55;letter-spacing:.5px;}
.edit .review-btn{
  background:transparent;color:var(--vscode-foreground,#1f2937);
  border:1px solid var(--vscode-panel-border);
  padding:3px 10px;font-size:11px;cursor:pointer;border-radius:4px;
  flex-shrink:0;
}
.edit .review-btn:hover{border-color:var(--hermes-accent);}
.edit.applied .icon::after{content:" ✓";color:#3fb950;}
.edit.applied .review-btn{display:none;}

/* Attachment chips above composer */
#attachments{padding:0;display:none;}
#attachments.has-items{
  display:flex;gap:5px;flex-wrap:wrap;padding:6px 10px;
  border-top:1px dashed var(--vscode-panel-border);
}
.attach{
  display:inline-flex;align-items:center;gap:5px;padding:3px 7px 3px 4px;
  background:var(--vscode-badge-background,var(--hermes-bubble-bg));
  color:var(--vscode-badge-foreground,inherit);
  border-radius:4px;font-size:11px;animation:slideIn .15s;
}
.attach img{height:18px;width:18px;object-fit:cover;border-radius:2px;}
.attach button{background:none;border:none;color:inherit;cursor:pointer;padding:0 2px;font:inherit;opacity:.65;}
.attach button:hover{opacity:1;}

/* Stop FAB */
#stopFab{
  display:none; position:absolute; bottom:80px; left:50%; transform:translateX(-50%);
  z-index:30;
  background:var(--vscode-inputValidation-warningBackground,#92400e);
  color:var(--vscode-foreground,#fff); border:1px solid currentColor;
  padding:5px 14px; font-size:11.5px; cursor:pointer; border-radius:999px;
  box-shadow:0 4px 12px rgba(0,0,0,.25);
  display:none;
}
#stopFab.show{display:inline-flex;align-items:center;gap:5px;}
#stopFab:hover{opacity:.85;}

/* ─── COMPOSER ─── */
#composer{padding:8px 10px;border-top:1px solid var(--vscode-panel-border);background:transparent;}
.input-shell{
  background:var(--vscode-input-background,#f3f4f6);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));
  border-radius:var(--hermes-radius);
  transition:border-color .12s,box-shadow .12s;
  position:relative;
}
.input-shell:focus-within{
  border-color:var(--hermes-accent);
  box-shadow:0 0 0 2px color-mix(in srgb, var(--hermes-accent) 18%, transparent);
}
textarea{
  width:100%;min-height:42px;max-height:240px;resize:none;
  padding:10px 12px 6px; font:inherit;
  background:transparent; color:var(--vscode-input-foreground,inherit);
  border:none;outline:none;
}
.input-row{
  display:flex;align-items:center;gap:4px;padding:2px 8px 6px;
}
.attach-menu-wrap{position:relative;}
.icon-btn{
  background:transparent;color:var(--vscode-foreground,inherit);border:none;
  padding:3px 7px;font-size:13px;cursor:pointer;border-radius:4px;opacity:.55;
  transition:opacity .12s,background .12s,color .12s;line-height:1;
}
.icon-btn:hover{opacity:1;background:var(--vscode-list-hoverBackground);color:var(--hermes-accent);}
.attach-menu{
  position:absolute;bottom:calc(100% + 4px);left:0;
  background:var(--vscode-editor-background,#fff);color:var(--vscode-foreground,#1f2937);
  border:1px solid var(--vscode-panel-border);border-radius:var(--hermes-radius-sm);
  box-shadow:0 4px 16px rgba(0,0,0,.2);
  min-width:200px;display:none;padding:4px;z-index:80;
}
.attach-menu.show{display:block;animation:slideDown .12s ease;}
.attach-menu .item{padding:7px 10px;border-radius:4px;cursor:pointer;display:flex;gap:8px;align-items:center;font-size:12px;}
.attach-menu .item:hover{background:var(--vscode-list-hoverBackground);}
.attach-menu .item .icon{width:16px;text-align:center;}
.attach-menu .item .hint{margin-left:auto;opacity:.5;font-size:10px;font-family:var(--vscode-editor-font-family);}

.spacer-flex{flex:1;}
.mode-pill{
  background:transparent;color:var(--vscode-foreground,inherit);
  border:1px solid var(--vscode-panel-border);
  padding:2px 8px 2px 6px;font-size:11px;border-radius:999px;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px;
}
.mode-pill:hover{border-color:var(--hermes-accent);background:var(--vscode-list-hoverBackground);}
.mode-pill .caret{font-size:8px;opacity:.55;}
.mode-menu{
  position:absolute;bottom:calc(100% + 4px);right:0;left:auto;
  background:var(--vscode-editor-background,#fff);color:var(--vscode-foreground,#1f2937);
  border:1px solid var(--vscode-panel-border);border-radius:var(--hermes-radius-sm);
  box-shadow:0 4px 16px rgba(0,0,0,.2);
  width:min(280px,calc(100vw - 24px));display:none;z-index:90;padding:4px;
}
.mode-menu.show{display:block;animation:slideDown .12s ease;}
.mode-item{padding:8px 10px;border-radius:4px;cursor:pointer;display:flex;gap:8px;align-items:flex-start;}
.mode-item:hover{background:var(--vscode-list-hoverBackground);}
.mode-item.active{background:color-mix(in srgb, var(--hermes-accent) 12%, transparent);}
.mode-item .mi-icon{font-size:13px;flex-shrink:0;}
.mode-item .mi-body{flex:1;}
.mode-item .mi-name{font-weight:500;font-size:12px;}
.mode-item .mi-desc{font-size:10.5px;opacity:.6;margin-top:1px;line-height:1.4;}
.mode-item .mi-cmd{font-family:var(--vscode-editor-font-family);font-size:10px;opacity:.4;margin-top:1px;}

#send{
  background:var(--vscode-button-background);color:var(--vscode-button-foreground);
  border:none;padding:5px 14px;cursor:pointer;font:inherit;font-size:12px;font-weight:500;
  border-radius:999px;transition:opacity .12s;display:inline-flex;align-items:center;gap:4px;
}
#send:hover:not(:disabled){background:var(--vscode-button-hoverBackground);}
#send:disabled{opacity:.35;cursor:not-allowed;}

/* Slash command autocomplete */
.slash-pop{
  position:absolute;bottom:calc(100% + 4px);left:8px;
  background:var(--vscode-editor-background,#fff);color:var(--vscode-foreground,#1f2937);
  border:1px solid var(--vscode-panel-border);border-radius:var(--hermes-radius-sm);
  box-shadow:0 4px 16px rgba(0,0,0,.2);
  min-width:240px;display:none;padding:4px;z-index:70;
}
.slash-pop.show{display:block;}
.slash-pop .item{padding:6px 10px;border-radius:4px;cursor:pointer;display:flex;gap:8px;font-size:12px;}
.slash-pop .item:hover,.slash-pop .item.sel{background:var(--vscode-list-hoverBackground);}
.slash-pop .item .cmd{font-family:var(--vscode-editor-font-family);color:var(--hermes-accent);min-width:70px;}
.slash-pop .item .desc{flex:1;opacity:.7;}

/* Empty state */
#empty{
  display:none;flex-direction:column;align-items:center;justify-content:center;
  padding:32px 20px;text-align:center;gap:14px;flex:1;
}
#empty h3{margin:0;font-size:14px;font-weight:600;}
#empty p{margin:0;opacity:.65;font-size:12px;max-width:340px;line-height:1.55;}
#empty .examples{display:flex;flex-direction:column;gap:5px;width:100%;max-width:320px;margin-top:6px;}
.ex-card{
  padding:9px 11px;background:var(--vscode-input-background,transparent);
  border:1px solid var(--vscode-panel-border);border-radius:var(--hermes-radius-sm);
  cursor:pointer;font-size:12px;text-align:left;
  color:var(--vscode-foreground,#1f2937);
  display:flex;gap:8px;align-items:center;
}
.ex-card:hover{border-color:var(--hermes-accent);background:var(--vscode-list-hoverBackground);}

/* scrollbar */
#log::-webkit-scrollbar{width:8px;}
#log::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:4px;}
#log::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground);}
</style></head>
<body>
<header>
  <div class="ws">
    <span class="ws-icon">📁</span>
    <span class="ws-name" id="wsName">no folder</span>
    <span class="ws-branch" id="wsBranch" style="display:none;"></span>
  </div>
  <span class="spacer"></span>
  <button class="h-btn" id="settingsBtn" title="Settings">⚙</button>
  <span class="dot" id="statusDot" data-tip="connecting"></span>
</header>

<div class="settings-sheet" id="settingsSheet">
  <h3>Connection</h3>
  <div class="settings-row">
    <label for="setBridgeUrl">Bridge URL</label>
    <input type="text" id="setBridgeUrl" placeholder="https://hermes.example.com">
  </div>
  <h3>Behavior</h3>
  <div class="settings-row">
    <label for="setMode">Mode</label>
    <select id="setMode">
      <option value="default">🛡 Default — review every edit</option>
      <option value="auto">⚡ Auto-edit — apply instantly</option>
      <option value="plan">📋 Plan — confirm plan first</option>
    </select>
  </div>
  <div class="settings-row cb">
    <input type="checkbox" id="setShowUsage">
    <label for="setShowUsage">Show token usage on each reply</label>
  </div>
  <h3>Appearance</h3>
  <div class="settings-row">
    <label for="setTheme">Theme</label>
    <select id="setTheme">
      <option value="auto">Match VS Code</option>
      <option value="light">Force light</option>
      <option value="dark">Force dark</option>
    </select>
  </div>
</div>

<div id="pair">
  <div class="big-logo">⌘</div>
  <h2 id="pairTitle">Pair this VS Code with Hermes</h2>
  <p id="pairBody">A one-time code will be sent to your Telegram. Tap <b>Approve</b> there once — and this device is paired forever.</p>
  <div class="row">
    <button id="btnPair" class="mode-pill" style="border-color:var(--hermes-accent);color:var(--hermes-accent);font-size:12px;padding:5px 14px;">Start pairing</button>
  </div>
  <div id="codeBlock" style="display:none;">
    <p style="margin-bottom:8px;">Open Telegram and tap <b>Approve</b>:</p>
    <div class="code" id="codeText">--------</div>
    <p style="opacity:.55;font-size:11.5px;"><span class="spinner"></span>&nbsp;waiting for approval…</p>
    <button id="btnCancelPair" class="icon-btn" style="border:1px solid var(--vscode-panel-border);padding:3px 12px;">Cancel</button>
  </div>
</div>

<div id="chat">
  <div id="log">
    <div id="empty">
      <div class="big-logo">⌘</div>
      <h3>Ready when you are</h3>
      <p>Ask anything, or pick an example below. Type <code style="background:var(--vscode-input-background);padding:0 4px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px;">/</code> to switch modes or run a command.</p>
      <div class="examples" id="examples"></div>
    </div>
  </div>
  <button id="stopFab">■ Stop</button>
  <div id="attachments"></div>
  <div id="composer">
    <div class="input-shell">
      <textarea id="input" placeholder="Ask Hermes…  (Enter to send · Shift+Enter newline · / for commands · paste image with Ctrl+V)"></textarea>
      <div class="input-row">
        <div class="attach-menu-wrap">
          <button id="attachBtn" class="icon-btn" title="Attach">⊕</button>
          <div class="attach-menu" id="attachMenu">
            <div class="item" data-action="file"><span class="icon">📄</span><span>Attach active file</span></div>
            <div class="item" data-action="selection"><span class="icon">✂️</span><span>Attach selection</span></div>
            <div class="item" data-action="paste-hint"><span class="icon">🖼</span><span>Paste image</span><span class="hint">⌘V</span></div>
            <div class="item" data-action="clear"><span class="icon">⟲</span><span>Clear conversation</span></div>
          </div>
        </div>
        <div class="spacer-flex"></div>
        <div class="attach-menu-wrap">
          <button id="modeBtn" class="mode-pill" title="Mode">
            <span id="modeIconSpan">🛡</span>
            <span id="modeLabelSpan">Default</span>
            <span class="caret">▾</span>
          </button>
          <div class="mode-menu" id="modeMenu">
            <div class="mode-item" data-mode="default">
              <span class="mi-icon">🛡</span>
              <div class="mi-body">
                <div class="mi-name">Default</div>
                <div class="mi-desc">Review every proposed file edit before applying.</div>
                <div class="mi-cmd">/default</div>
              </div>
            </div>
            <div class="mode-item" data-mode="auto">
              <span class="mi-icon">⚡</span>
              <div class="mi-body">
                <div class="mi-name">Auto-edit</div>
                <div class="mi-desc">Apply edits instantly. Cursor-style.</div>
                <div class="mi-cmd">/auto</div>
              </div>
            </div>
            <div class="mode-item" data-mode="plan">
              <span class="mi-icon">📋</span>
              <div class="mi-body">
                <div class="mi-name">Plan</div>
                <div class="mi-desc">Hermes plans first, waits for "go" before editing.</div>
                <div class="mi-cmd">/plan</div>
              </div>
            </div>
          </div>
        </div>
        <button id="send" disabled>Send <span style="opacity:.7;">↵</span></button>
      </div>
      <div class="slash-pop" id="slashPop"></div>
    </div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const statusDot=$('statusDot'), wsName=$('wsName'), wsBranch=$('wsBranch');
const settingsBtn=$('settingsBtn'), settingsSheet=$('settingsSheet');
const setBridgeUrl=$('setBridgeUrl'), setMode=$('setMode'), setShowUsage=$('setShowUsage'), setTheme=$('setTheme');
const pair=$('pair'), chat=$('chat'), log=$('log'), empty=$('empty');
const codeBlock=$('codeBlock'), codeText=$('codeText'), pairBody=$('pairBody'), pairTitle=$('pairTitle');
const examplesDiv=$('examples');
const stopFab=$('stopFab');
const attachmentsBar=$('attachments');
const input=$('input'), sendBtn=$('send');
const attachBtn=$('attachBtn'), attachMenu=$('attachMenu');
const modeBtn=$('modeBtn'), modeMenu=$('modeMenu'), modeIconSpan=$('modeIconSpan'), modeLabelSpan=$('modeLabelSpan');
const slashPop=$('slashPop');

let lastAssistant=null;
let typingEl=null;
let currentMode='default';
let showUsage=true;
let themeOverride='auto';
const editEls=new Map();
const clusterEls=new Map();
const MODE_META={'default':{icon:'🛡',label:'Default'},'auto':{icon:'⚡',label:'Auto-edit'},'plan':{icon:'📋',label:'Plan'}};

const SLASH_CMDS = [
  { cmd: '/default', desc: 'Switch to Default mode (review each)' },
  { cmd: '/auto',    desc: 'Switch to Auto-edit (apply instantly)' },
  { cmd: '/plan',    desc: 'Switch to Plan mode (confirm first)' },
  { cmd: '/clear',   desc: 'Clear conversation history' },
  { cmd: '/help',    desc: 'Show available commands' }
];
let slashSel = 0;

// ─── Theme detection (luminance based, with override) ─────────────────────
function detectTheme(){
  if (themeOverride !== 'auto') {
    document.body.classList.toggle('hermes-light', themeOverride === 'light');
    document.body.classList.toggle('hermes-dark',  themeOverride === 'dark');
    return;
  }
  const bg = getComputedStyle(document.body).backgroundColor || '';
  const m = bg.match(/rgba?\\(([^)]+)\\)/);
  if (!m) return;
  const [r,g,b] = m[1].split(',').map(s => parseFloat(s.trim()));
  if (isNaN(r)) return;
  const lum = 0.2126*r + 0.7152*g + 0.0722*b;
  document.body.classList.remove('hermes-light','hermes-dark');
  document.body.classList.add(lum > 140 ? 'hermes-light' : 'hermes-dark');
}
detectTheme();
new MutationObserver(detectTheme).observe(document.body,{attributes:true,attributeFilter:['class','data-vscode-theme-kind']});

// ─── Helpers ─────────────────────────────────────────────────────────────
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function show(view){
  pair.style.display = view==='pair'?'flex':'none';
  chat.style.display = view==='chat'?'flex':'none';
  updateEmpty();
}
function updateEmpty(){
  const has = log.querySelectorAll('.msg, .edit, .cluster').length > 0;
  empty.style.display = has ? 'none' : 'flex';
}

// ─── Markdown renderer (with file-link & table support) ──────────────────
function renderMarkdown(src){
  const lines = src.split('\\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\\s*\`\`\`([a-zA-Z0-9_+-]*)\\s*$/);
    if (fence) {
      const lang = (fence[1]||'').toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^\\s*\`\`\`\\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const code = buf.join('\\n');
      const langLbl = lang ? '<span class="lang-label">'+escapeHtml(lang)+'</span>' : '';
      const dataAttr = escapeHtml(code).replace(/"/g,'&quot;');
      out.push('<div class="code-wrap">'+langLbl+
        '<button class="copy-btn" data-code="'+dataAttr+'">Copy</button>'+
        '<pre><code>'+highlight(code, lang)+'</code></pre></div>');
      continue;
    }
    const h = line.match(/^(#{1,3})\\s+(.+)$/);
    if (h) { out.push('<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>'); i++; continue; }
    if (/^---+\\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.startsWith('> ')) { out.push('<blockquote>'+inline(line.slice(2))+'</blockquote>'); i++; continue; }

    // Table: header | --- | rows
    if (/\\|/.test(line) && i+1 < lines.length && /^\\s*\\|?\\s*[-:]+/.test(lines[i+1])) {
      const head = line.split('|').map(c => c.trim()).filter(c=>c.length);
      i += 2;
      const rows = [];
      while (i < lines.length && /\\|/.test(lines[i]) && lines[i].trim() !== '') {
        rows.push(lines[i].split('|').map(c => c.trim()).filter(c=>c.length));
        i++;
      }
      let html = '<table><thead><tr>'+head.map(h=>'<th>'+inline(h)+'</th>').join('')+'</tr></thead><tbody>';
      for (const r of rows) html += '<tr>'+r.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>';
      html += '</tbody></table>';
      out.push(html);
      continue;
    }

    if (/^\\s*[-*]\\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i])) {
        items.push('<li>'+inline(lines[i].replace(/^\\s*[-*]\\s+/, ''))+'</li>'); i++;
      }
      out.push('<ul>'+items.join('')+'</ul>');
      continue;
    }
    if (/^\\s*\\d+\\.\\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) {
        items.push('<li>'+inline(lines[i].replace(/^\\s*\\d+\\.\\s+/, ''))+'</li>'); i++;
      }
      out.push('<ol>'+items.join('')+'</ol>');
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|>|---|\\s*[-*]|\\s*\\d+\\.|\\s*\`\`\`|\\|)/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    out.push('<p>'+inline(para.join(' '))+'</p>');
  }
  return out.join('');
}
function inline(s){
  s = escapeHtml(s);
  s = s.replace(/\`([^\`\\n]+)\`/g, (_,t)=>'<code>'+t+'</code>');
  s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\\W)\\*([^*\\n]+)\\*(?=\\W|$)/g, '$1<em>$2</em>');
  // file references: src/foo.ts:42 or path/to/file.ext (heuristic: contains / and a known ext)
  s = s.replace(/(^|\\s|[(\\[])((?:[a-zA-Z0-9_\\-./]+)\\/[a-zA-Z0-9_\\-.]+\\.[a-zA-Z0-9]{1,8})(?::(\\d+))?/g,
    (m, pre, path, line) => pre + '<a class="file-link" data-path="'+path+'"'+(line?' data-line="'+line+'"':'')+'>'+path+(line?':'+line:'')+'</a>');
  s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2">$1</a>');
  return s;
}

const KW = {
  ts: ['async','await','break','case','catch','class','const','continue','default','do','else','enum','export','extends','false','finally','for','from','function','if','import','in','instanceof','interface','let','new','null','of','private','public','protected','readonly','return','static','super','switch','this','throw','true','try','type','typeof','undefined','var','void','while','yield'],
  js: ['async','await','break','case','catch','class','const','continue','default','do','else','export','extends','false','finally','for','from','function','if','import','in','instanceof','let','new','null','of','return','super','switch','this','throw','true','try','typeof','undefined','var','void','while','yield'],
  py: ['and','as','assert','async','await','break','class','continue','def','del','elif','else','except','False','finally','for','from','global','if','import','in','is','lambda','None','nonlocal','not','or','pass','raise','return','True','try','while','with','yield'],
  sh: ['if','then','else','elif','fi','for','do','done','while','case','esac','function','return','export','local','source'],
  rs: ['as','async','await','break','const','continue','crate','dyn','else','enum','extern','false','fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return','self','static','struct','super','trait','true','type','unsafe','use','where','while']
};
function highlight(code, lang){
  let key = lang;
  if (lang==='tsx'||lang==='jsx') key='ts';
  if (lang==='python') key='py';
  if (lang==='bash'||lang==='zsh'||lang==='shell') key='sh';
  if (lang==='rust') key='rs';
  if (lang==='javascript') key='js';
  if (lang==='typescript') key='ts';
  const kws = KW[key];
  if (!kws) return escapeHtml(code);
  let s = escapeHtml(code);
  if (key==='py'||key==='sh') {
    s = s.replace(/(^|\\n)([^\\n]*#[^\\n]*)/g, (m,a,b)=>a+'<span class="tk-com">'+b+'</span>');
  } else {
    s = s.replace(/(\\/\\/[^\\n]*)/g,'<span class="tk-com">$1</span>');
    s = s.replace(/(\\/\\*[\\s\\S]*?\\*\\/)/g,'<span class="tk-com">$1</span>');
  }
  s = s.replace(/(&quot;[^&\\n]*?&quot;|&#39;[^&\\n]*?&#39;|\`[^\`\\n]*\`)/g,'<span class="tk-str">$1</span>');
  s = s.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g,'<span class="tk-num">$1</span>');
  const re = new RegExp('\\\\b('+kws.join('|')+')\\\\b','g');
  s = s.replace(re,'<span class="tk-kw">$1</span>');
  s = s.replace(/([A-Za-z_][A-Za-z0-9_]*)\\(/g,'<span class="tk-fn">$1</span>(');
  return s;
}

function bindRichLinks(scope){
  scope.querySelectorAll('.copy-btn:not(.bound)').forEach(btn => {
    btn.classList.add('bound');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const code = btn.getAttribute('data-code') || '';
      const decoded = code.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
      navigator.clipboard.writeText(decoded).then(() => {
        btn.textContent = '✓ Copied'; btn.classList.add('done');
        setTimeout(() => { btn.textContent='Copy'; btn.classList.remove('done'); }, 1400);
      });
    });
  });
  scope.querySelectorAll('.file-link:not(.bound)').forEach(a => {
    a.classList.add('bound');
    a.addEventListener('click', e => {
      e.preventDefault();
      const path = a.getAttribute('data-path');
      const line = a.getAttribute('data-line');
      vscode.postMessage({ type: 'openFile', path, line: line ? parseInt(line, 10) : undefined });
    });
  });
}

// ─── Bubbles ─────────────────────────────────────────────────────────────
function newBubble(role, kind){
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (kind || role);
  if (role === 'assistant') wrap.classList.add('md');
  log.appendChild(wrap);
  return wrap;
}
function removeTyping(){ if (typingEl) { typingEl.remove(); typingEl=null; } }
function showTyping(){
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'msg assistant';
  typingEl.style.opacity = '.6';
  typingEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  log.appendChild(typingEl);
  scrollToBottom();
}
function scrollToBottom(){ log.scrollTop = log.scrollHeight; }

function append(role, text, kind, opts){
  opts = opts || {};
  if (role === 'assistant' && !kind) {
    removeTyping();
    if (!lastAssistant) {
      lastAssistant = newBubble(role);
      lastAssistant._raw = '';
      lastAssistant._footer = null;
    }
    lastAssistant._raw += text;
    // re-render: keep existing footer if any
    lastAssistant.innerHTML = renderMarkdown(lastAssistant._raw);
    if (lastAssistant._usage) {
      const f = document.createElement('div');
      f.className = 'usage-footer';
      f.innerHTML = '<span>'+lastAssistant._usage.in.toLocaleString()+' in</span><span>'+lastAssistant._usage.out.toLocaleString()+' out</span>';
      lastAssistant.appendChild(f);
    }
    bindRichLinks(lastAssistant);
  } else {
    const b = newBubble(role, kind);
    b.textContent = text;
    if (opts.retryable) {
      const btn = document.createElement('button');
      btn.className = 'retry-btn';
      btn.textContent = '↻ Retry';
      btn.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
      b.appendChild(btn);
    }
    if (role === 'user') lastAssistant = null;
  }
  updateEmpty(); scrollToBottom();
}

function attachUsage(usage){
  if (!showUsage || !lastAssistant) return;
  lastAssistant._usage = usage;
  // re-render to add footer
  if (lastAssistant._raw !== undefined) {
    lastAssistant.innerHTML = renderMarkdown(lastAssistant._raw);
    const f = document.createElement('div');
    f.className = 'usage-footer';
    f.innerHTML = '<span>'+usage.in.toLocaleString()+' in</span><span>'+usage.out.toLocaleString()+' out</span>';
    lastAssistant.appendChild(f);
    bindRichLinks(lastAssistant);
  }
}

// ─── Edit cards ──────────────────────────────────────────────────────────
function modeIconFor(mode){ return mode==='create'?'✨':mode==='delete'?'🗑':'✏️'; }

function renderEdit(e){
  let el = editEls.get(e.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'edit';
    el.innerHTML = '<span class="icon">'+modeIconFor(e.mode)+'</span>'+
      '<div class="meta"><div class="path">'+escapeHtml(e.path)+'</div><span class="mode-tag">'+e.mode+'</span></div>'+
      '<button class="review-btn">Review</button>';
    el.querySelector('.review-btn').addEventListener('click', () => vscode.postMessage({type:'reviewEdit', id:e.id}));
    log.appendChild(el);
    editEls.set(e.id, el);
    updateEmpty();
  }
  el.classList.remove('applied','rejected');
  if (e.status==='applied') el.classList.add('applied');
  if (e.status==='rejected') el.classList.add('rejected');
  scrollToBottom();
}

function renderCluster(c){
  if (clusterEls.has(c.id)) return;
  const wrap = document.createElement('div');
  wrap.className = 'cluster';
  wrap.innerHTML =
    '<div class="head">'+
    '  <span class="icon">📦</span>'+
    '  <span class="label"><b>'+c.count+'</b> file changes proposed</span>'+
    '  <span class="chevron">▶</span>'+
    '</div>'+
    '<div class="body" id="cb-'+c.id+'"></div>'+
    '<div class="actions">'+
    '  <button class="apply-all">Apply All</button>'+
    '  <button class="reject-all" style="background:transparent;border:1px solid var(--vscode-panel-border);">Reject All</button>'+
    '</div>';
  const head = wrap.querySelector('.head');
  head.addEventListener('click', () => wrap.classList.toggle('expanded'));
  wrap.querySelector('.apply-all').addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({type:'applyCluster',clusterId:c.id});});
  wrap.querySelector('.reject-all').addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({type:'rejectCluster',clusterId:c.id});});
  const body = wrap.querySelector('.body');
  for (const e of c.edits) {
    const row = document.createElement('div');
    row.className = 'edit';
    row.innerHTML = '<span class="icon">'+modeIconFor(e.mode)+'</span>'+
      '<div class="meta"><div class="path">'+escapeHtml(e.path)+'</div><span class="mode-tag">'+e.mode+'</span></div>'+
      '<button class="review-btn">Review</button>';
    row.querySelector('.review-btn').addEventListener('click', () => vscode.postMessage({type:'reviewEdit', id:e.id}));
    body.appendChild(row);
    editEls.set(e.id, row);
  }
  log.appendChild(wrap);
  clusterEls.set(c.id, wrap);
  updateEmpty(); scrollToBottom();
}

// ─── Attachments ─────────────────────────────────────────────────────────
function renderAttachments(items){
  attachmentsBar.innerHTML = '';
  attachmentsBar.classList.toggle('has-items', items.length > 0);
  for (const it of items) {
    const el = document.createElement('span');
    el.className = 'attach';
    if (it.thumbnail) {
      const img = document.createElement('img'); img.src = it.thumbnail; img.alt='';
      el.appendChild(img);
    } else {
      const ic = document.createElement('span'); ic.textContent = it.type==='image'?'🖼':'📄'; el.appendChild(ic);
    }
    const lbl = document.createElement('span'); lbl.textContent = it.label; el.appendChild(lbl);
    const x = document.createElement('button'); x.textContent='✕'; x.title='Remove';
    x.addEventListener('click', () => vscode.postMessage({type:'removeAttachment', id:it.id}));
    el.appendChild(x);
    attachmentsBar.appendChild(el);
  }
}

// ─── Examples (smart) ────────────────────────────────────────────────────
function renderExamples(items){
  examplesDiv.innerHTML = '';
  for (const ex of items) {
    const b = document.createElement('button');
    b.className = 'ex-card';
    b.innerHTML = '<span>'+(ex.icon||'•')+'</span><span>'+escapeHtml(ex.text)+'</span>';
    b.addEventListener('click', () => {
      input.value = ex.prompt || ex.text;
      input.focus();
      onInputChange();
    });
    examplesDiv.appendChild(b);
  }
}

// ─── Workspace ───────────────────────────────────────────────────────────
function setWorkspace(info){
  wsName.textContent = info.name || 'no folder';
  if (info.branch) {
    wsBranch.textContent = info.branch;
    wsBranch.style.display = '';
  } else {
    wsBranch.style.display = 'none';
  }
}

// ─── Send / input ────────────────────────────────────────────────────────
function send(){
  const v = input.value.trim();
  if (!v) return;
  // Slash commands intercepted
  const slashMatch = v.match(/^\\/(\\w+)\\b/);
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase();
    if (cmd === 'plan' || cmd === 'auto' || cmd === 'default') {
      setActiveMode(cmd);
      vscode.postMessage({type:'setMode', mode: cmd});
      input.value=''; onInputChange(); slashPop.classList.remove('show');
      append('system','Mode → '+MODE_META[cmd].label,'system');
      return;
    }
    if (cmd === 'clear') {
      log.querySelectorAll('.msg, .edit, .cluster').forEach(n => n.remove());
      lastAssistant=null; editEls.clear(); clusterEls.clear();
      vscode.postMessage({type:'clear'});
      input.value=''; onInputChange(); slashPop.classList.remove('show');
      updateEmpty();
      return;
    }
    if (cmd === 'help') {
      let txt = 'Available commands:\\n'+SLASH_CMDS.map(c => c.cmd+' — '+c.desc).join('\\n');
      append('system', txt, 'system');
      input.value=''; onInputChange(); slashPop.classList.remove('show');
      return;
    }
  }
  append('user', v);
  showTyping();
  vscode.postMessage({type:'prompt', text:v});
  input.value=''; onInputChange();
}
function autoResize(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight, 240)+'px'; }
function onInputChange(){
  autoResize();
  sendBtn.disabled = input.value.trim().length === 0;
  // slash autocomplete
  const v = input.value.trim();
  if (v.startsWith('/') && !v.includes(' ')) {
    const q = v.slice(1).toLowerCase();
    const matches = SLASH_CMDS.filter(c => c.cmd.slice(1).startsWith(q));
    if (matches.length) {
      slashPop.innerHTML = matches.map((c,i) => '<div class="item'+(i===slashSel?' sel':'')+'" data-cmd="'+c.cmd+'"><span class="cmd">'+c.cmd+'</span><span class="desc">'+c.desc+'</span></div>').join('');
      slashPop.classList.add('show');
      slashPop.querySelectorAll('.item').forEach(el => {
        el.addEventListener('click', () => { input.value = el.dataset.cmd; onInputChange(); input.focus(); });
      });
      return;
    }
  }
  slashPop.classList.remove('show');
}

// ─── Mode ────────────────────────────────────────────────────────────────
function setActiveMode(m){
  currentMode = m;
  const meta = MODE_META[m] || MODE_META.default;
  modeIconSpan.textContent = meta.icon;
  modeLabelSpan.textContent = meta.label;
  modeMenu.querySelectorAll('.mode-item').forEach(el => el.classList.toggle('active', el.dataset.mode===m));
  setMode.value = m;
}

// ─── Settings sheet ──────────────────────────────────────────────────────
function pushSettings(){
  vscode.postMessage({
    type: 'settingsChange',
    value: {
      bridgeUrl: setBridgeUrl.value.trim(),
      mode: setMode.value,
      themeOverride: setTheme.value,
      showUsage: setShowUsage.checked
    }
  });
}

// ─── Wire DOM ────────────────────────────────────────────────────────────
$('btnPair').addEventListener('click', () => vscode.postMessage({type:'pair'}));
$('btnCancelPair').addEventListener('click', () => vscode.postMessage({type:'cancelPair'}));
sendBtn.addEventListener('click', send);
stopFab.addEventListener('click', () => vscode.postMessage({type:'stop'}));
input.addEventListener('input', onInputChange);
input.addEventListener('keydown', e => {
  if (slashPop.classList.contains('show')) {
    if (e.key === 'Tab' || e.key === 'Enter') {
      const sel = slashPop.querySelector('.item.sel') || slashPop.querySelector('.item');
      if (sel) { e.preventDefault(); input.value = sel.dataset.cmd; onInputChange(); return; }
    }
    if (e.key === 'Escape') { slashPop.classList.remove('show'); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener('paste', e => {
  for (const it of (e.clipboardData?.items || [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const blob = it.getAsFile(); if (!blob) continue;
      e.preventDefault();
      const r = new FileReader();
      r.onload = () => vscode.postMessage({type:'pasteImage', dataUrl:r.result});
      r.readAsDataURL(blob);
    }
  }
});

// Attach menu
attachBtn.addEventListener('click', e => { e.stopPropagation(); attachMenu.classList.toggle('show'); modeMenu.classList.remove('show'); });
attachMenu.addEventListener('click', e => {
  const it = e.target.closest('.item'); if (!it) return;
  const a = it.dataset.action;
  attachMenu.classList.remove('show');
  if (a === 'file') vscode.postMessage({type:'attachFile'});
  else if (a === 'selection') vscode.postMessage({type:'attachSelection'});
  else if (a === 'paste-hint') input.focus();
  else if (a === 'clear') {
    log.querySelectorAll('.msg, .edit, .cluster').forEach(n => n.remove());
    lastAssistant=null; editEls.clear(); clusterEls.clear();
    vscode.postMessage({type:'clear'});
    updateEmpty();
  }
});

// Mode menu
modeBtn.addEventListener('click', e => { e.stopPropagation(); modeMenu.classList.toggle('show'); attachMenu.classList.remove('show'); });
modeMenu.addEventListener('click', e => {
  const it = e.target.closest('.mode-item'); if (!it) return;
  const m = it.dataset.mode;
  setActiveMode(m); modeMenu.classList.remove('show');
  vscode.postMessage({type:'setMode', mode:m});
});
document.addEventListener('click', () => { attachMenu.classList.remove('show'); modeMenu.classList.remove('show'); });

// Settings
settingsBtn.addEventListener('click', e => { e.stopPropagation(); settingsSheet.classList.toggle('show'); });
settingsSheet.addEventListener('click', e => e.stopPropagation());
[setBridgeUrl, setMode, setShowUsage, setTheme].forEach(el => {
  el.addEventListener('change', () => {
    if (el === setMode) setActiveMode(el.value);
    if (el === setTheme) { themeOverride = el.value; detectTheme(); }
    if (el === setShowUsage) showUsage = el.checked;
    pushSettings();
  });
  if (el === setBridgeUrl) el.addEventListener('blur', pushSettings);
});

// ─── Inbound from extension ──────────────────────────────────────────────
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type==='message') append(m.role, m.text, m.kind, {retryable: m.retryable});
  else if (m.type==='status') {
    statusDot.dataset.tip = m.text || '';
    statusDot.classList.toggle('busy', !!m.busy);
    statusDot.classList.toggle('error', !!m.errored);
    stopFab.classList.toggle('show', !!m.busy);
    if (!m.busy) removeTyping();
  }
  else if (m.type==='attachments') renderAttachments(m.items);
  else if (m.type==='edit') renderEdit(m);
  else if (m.type==='cluster') renderCluster(m);
  else if (m.type==='editStatus') {
    const el = editEls.get(m.id);
    if (el) {
      el.classList.remove('applied','rejected');
      if (m.status==='applied') el.classList.add('applied');
      if (m.status==='rejected') el.classList.add('rejected');
    }
  }
  else if (m.type==='clusterEditStatus') {
    const el = editEls.get(m.editId);
    if (el) {
      el.classList.remove('applied','rejected');
      if (m.status==='applied') el.classList.add('applied');
      if (m.status==='rejected') el.classList.add('rejected');
    }
  }
  else if (m.type==='loadHistory') {
    log.querySelectorAll('.msg, .edit, .cluster').forEach(n => n.remove());
    lastAssistant=null;
    for (const it of m.items) append(it.role, it.text, it.kind);
    updateEmpty();
  }
  else if (m.type==='mode') setActiveMode(m.mode || 'default');
  else if (m.type==='examples') renderExamples(m.items || []);
  else if (m.type==='workspace') setWorkspace(m);
  else if (m.type==='settings') {
    setBridgeUrl.value = m.bridgeUrl || '';
    setMode.value = m.mode || 'default';
    setTheme.value = m.themeOverride || 'auto';
    setShowUsage.checked = !!m.showUsage;
    showUsage = !!m.showUsage;
    themeOverride = m.themeOverride || 'auto';
    setActiveMode(m.mode || 'default');
    detectTheme();
  }
  else if (m.type==='usage') attachUsage({in: m.in, out: m.out});
  else if (m.type==='state') {
    const s = m.state;
    if (s.kind==='needsPair') { show('pair'); codeBlock.style.display='none'; pairTitle.textContent='Pair this VS Code with Hermes'; }
    else if (s.kind==='pairing') { show('pair'); codeBlock.style.display='block'; codeText.textContent=s.code; }
    else if (s.kind==='ready') { show('chat'); input.focus(); onInputChange(); }
    else if (s.kind==='error') { show('pair'); codeBlock.style.display='none'; pairTitle.textContent='Error';
      pairBody.textContent=s.message+' — open ⚙ Settings.'; }
  }
});
onInputChange();
</script></body></html>`;
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
