import * as vscode from "vscode";

export type PanelState =
  | { kind: "needsPair" }
  | { kind: "pairing"; code: string; expiresIn: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface ChatMessageOut {
  role: "user" | "assistant" | "system";
  text: string;
  kind?: string;
  retryable?: boolean;
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
  inCluster?: boolean;
  clusterId?: string;
  clusterCount?: number;
}

export type Mode = "default" | "auto" | "plan";

export interface ChatPanelHandlers {
  onPair: () => void;
  onCancelPair: () => void;
  onPrompt: (text: string) => void;
  onClear: () => void;
  onOpenSettings: () => void;
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
  setStatus(text: string, busy = false): void { this.post("status", { text, busy }); }
  reveal(): void { this.view?.show?.(true); }
  setAttachments(items: AttachedDescriptor[]): void { this.post("attachments", { items }); }
  pushEdit(e: EditDescriptor): void { this.post("edit", e); }
  updateEdit(id: string, status: EditDescriptor["status"]): void { this.post("editStatus", { id, status }); }
  pushClusterBar(clusterId: string, count: number): void { this.post("cluster", { clusterId, count }); }
  setBusy(busy: boolean): void { this.post("busy", { busy }); }
  loadHistory(items: ChatMessageOut[]): void { this.post("loadHistory", { items }); }
  setMode(mode: Mode): void { this.post("mode", { mode }); }

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
      case "settings": this.handlers.onOpenSettings(); break;
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
      case "examplePrompt":
        if (typeof m.text === "string") this.handlers.onPrompt(m.text);
        break;
      case "setMode":
        if (m.mode === "default" || m.mode === "auto" || m.mode === "plan") {
          this.handlers.onModeChange(m.mode);
        }
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
  --hermes-radius: 10px;
  --hermes-radius-sm: 6px;
  --hermes-gap: 10px;
  --hermes-bubble-pad: 10px 12px;
  --hermes-shadow: 0 1px 2px rgba(0,0,0,.06);
  /* fallback assistant-bubble shading (when color-mix isn't supported) */
  --hermes-bubble-bg: rgba(127,127,127,.06);
  --hermes-bubble-border: rgba(127,127,127,.18);
}
@supports (background: color-mix(in srgb, red, blue)) {
  :root {
    --hermes-bubble-bg:    color-mix(in srgb, var(--vscode-foreground) 5%,  var(--vscode-editor-background));
    --hermes-bubble-border: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  }
}
*{box-sizing:border-box;}
body{
  margin:0;display:flex;flex-direction:column;height:100vh;
  font-family:var(--vscode-font-family);
  color:var(--vscode-foreground,#1f2937);    /* fallback dark grey for broken themes */
  background:var(--vscode-sideBar-background,#fafafa);
  /* Honour VS Code zoom — falls back to 13px on older builds */
  font-size:var(--vscode-font-size,13px);
  line-height:1.5;
  overflow-wrap:anywhere;
}

/* ─── Header ─── */
header{
  padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);
  display:flex;align-items:center;gap:8px;
  background:linear-gradient(180deg,var(--vscode-editor-background) 0%,transparent 100%);
}
header .logo{
  width:22px;height:22px;flex-shrink:0;border-radius:50%;
  background:linear-gradient(135deg,var(--hermes-accent),#8a2be2);
  display:grid;place-items:center;color:#fff;font-size:13px;font-weight:bold;
  box-shadow:var(--hermes-shadow);
}
header .title{font-weight:600;letter-spacing:.2px;}
header .right{margin-left:auto;display:flex;gap:6px;align-items:center;}
header .pill{
  font-size:10px;padding:2px 8px;border-radius:999px;
  background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
  display:flex;align-items:center;gap:4px;
}
header .pill.busy{background:var(--vscode-inputValidation-warningBackground);}
.dot{width:6px;height:6px;border-radius:50%;background:#3fb950;animation:pulse 2s infinite;}
.dot.warn{background:#d29922;}
@keyframes pulse{50%{opacity:.4;}}

#stopBtn{display:none;background:var(--vscode-inputValidation-warningBackground);
  border:none;color:inherit;padding:3px 10px;cursor:pointer;font-size:11px;border-radius:4px;
  transition:opacity .15s;}
#stopBtn:hover{opacity:.8;}
#stopBtn.show{display:inline-flex;align-items:center;gap:4px;}

/* ─── Pair view ─── */
#pair{padding:24px 16px;display:none;flex-direction:column;gap:16px;align-items:center;text-align:center;}
#pair .big-logo{
  width:64px;height:64px;border-radius:50%;
  background:linear-gradient(135deg,var(--hermes-accent),#8a2be2);
  display:grid;place-items:center;color:#fff;font-size:32px;
  box-shadow:0 4px 12px rgba(0,0,0,.15);
  margin-bottom:8px;
  animation:fadeIn .4s ease;
}
#pair h2{margin:0;font-size:15px;font-weight:600;}
#pair p{margin:0;opacity:.75;line-height:1.55;max-width:340px;}
.code{
  font-family:var(--vscode-editor-font-family);font-size:28px;letter-spacing:6px;font-weight:600;
  padding:14px 22px;background:var(--vscode-input-background);
  border:1px solid var(--vscode-focusBorder);border-radius:var(--hermes-radius);
  box-shadow:var(--hermes-shadow);
}
.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}

/* ─── Chat ─── */
#chat{flex:1;display:none;flex-direction:column;min-height:0;}
#log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:var(--hermes-gap);}

.msg{
  padding:var(--hermes-bubble-pad);border-radius:var(--hermes-radius);
  word-wrap:break-word;line-height:1.5;
  animation:slideIn .25s ease;position:relative;
  color:var(--vscode-foreground,#1f2937);    /* fallback for broken themes */
}
@keyframes slideIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}

.msg-row{display:flex;gap:8px;align-items:flex-start;}
.avatar{
  width:24px;height:24px;border-radius:50%;flex-shrink:0;font-size:13px;
  display:grid;place-items:center;color:#fff;font-weight:600;margin-top:2px;
}
.avatar.user{background:linear-gradient(135deg,#666,#444);}
.avatar.assistant{background:linear-gradient(135deg,var(--hermes-accent),#8a2be2);}
.avatar.system{background:#555;font-size:10px;}

.msg-body{flex:1;min-width:0;}
.msg.user .bubble{
  background:var(--vscode-input-background,#f3f4f6);
  color:var(--vscode-input-foreground,var(--vscode-foreground,#1f2937));
  padding:var(--hermes-bubble-pad);border-radius:var(--hermes-radius);
  border-top-left-radius:var(--hermes-radius-sm);
  border-left:3px solid var(--hermes-accent);
  white-space:pre-wrap;
}
.msg.assistant .bubble{
  background:var(--hermes-bubble-bg);
  color:var(--vscode-foreground,#1f2937);
  padding:var(--hermes-bubble-pad);border-radius:var(--hermes-radius);
  border-top-left-radius:var(--hermes-radius-sm);
  border:1px solid var(--hermes-bubble-border);
}
.msg.system .bubble{
  font-size:11.5px;opacity:.7;font-style:italic;padding:4px 10px;
}
.msg.error .bubble{
  background:var(--vscode-inputValidation-errorBackground);
  color:var(--vscode-inputValidation-errorForeground);
  padding:var(--hermes-bubble-pad);border-radius:var(--hermes-radius);
  border:1px solid var(--vscode-inputValidation-errorBorder,transparent);
}
.msg.usage .bubble{
  font-size:10.5px;opacity:.5;font-family:var(--vscode-editor-font-family);
  padding:2px 10px;text-align:right;
}
.msg.thinking .bubble{
  opacity:.6;font-style:italic;background:transparent;padding:6px 10px;
}

.retry-btn{
  background:transparent;color:inherit;border:1px solid currentColor;
  padding:3px 10px;font-size:11px;cursor:pointer;border-radius:var(--hermes-radius-sm);
  margin-top:6px;display:inline-flex;align-items:center;gap:4px;transition:opacity .15s;
}
.retry-btn:hover{opacity:.8;}

/* typing indicator */
.typing{display:inline-flex;gap:3px;align-items:center;padding:4px 0;}
.typing span{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.4;animation:bounce 1.4s infinite ease-in-out;}
.typing span:nth-child(2){animation-delay:.16s;}
.typing span:nth-child(3){animation-delay:.32s;}
@keyframes bounce{0%,80%,100%{transform:scale(.6);opacity:.4;}40%{transform:scale(1);opacity:1;}}

/* markdown */
.md p{margin:0 0 8px;}
.md p:last-child{margin-bottom:0;}
.md h1,.md h2,.md h3{margin:12px 0 6px;font-size:14px;font-weight:600;}
.md h1{font-size:15px;}
.md ul,.md ol{margin:0 0 8px;padding-left:22px;}
.md li{margin:2px 0;}
.md code{
  font-family:var(--vscode-editor-font-family);
  background:var(--vscode-textBlockQuote-background);
  padding:1px 5px;border-radius:3px;font-size:12px;
}
.md pre{
  background:var(--vscode-textBlockQuote-background);
  padding:10px 12px;border-radius:var(--hermes-radius-sm);
  overflow-x:auto;margin:8px 0;font-size:12px;
  border:1px solid var(--vscode-panel-border);position:relative;
}
.md pre code{background:none;padding:0;}
.md pre .copy-btn{
  position:absolute;top:6px;right:6px;
  background:var(--vscode-button-background);color:var(--vscode-button-foreground);
  border:none;padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;
  opacity:0;transition:opacity .15s;
}
.md pre:hover .copy-btn{opacity:1;}
.md pre .copy-btn.done{background:#3fb950;color:#fff;}
.md blockquote{border-left:3px solid var(--hermes-accent);padding-left:10px;margin:6px 0;opacity:.85;}
.md a{color:var(--vscode-textLink-foreground);text-decoration:none;}
.md a:hover{text-decoration:underline;}
.md strong{font-weight:600;}
.md em{font-style:italic;}
.md hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:10px 0;}

/* Syntax tokens — DEFAULT palette is high-contrast and works on BOTH themes
   (slightly less pretty on dark, but never invisible).
   Dark themes get a brighter override for nicer aesthetics. */
.tk-kw{color:#7c3aed;}                /* deep purple */
.tk-str{color:#15803d;}               /* dark green */
.tk-num{color:#b45309;}               /* burnt orange */
.tk-com{color:#6b7280;font-style:italic;} /* mid grey */
.tk-fn{color:#1d4ed8;}                /* dark blue */
/* Dark-theme upgrade — only when we're SURE we're on dark */
body.vscode-dark .tk-kw,
body[data-vscode-theme-kind*="dark"] .tk-kw,
body.hermes-dark-detected .tk-kw{color:#c792ea;}
body.vscode-dark .tk-str,
body[data-vscode-theme-kind*="dark"] .tk-str,
body.hermes-dark-detected .tk-str{color:#c3e88d;}
body.vscode-dark .tk-num,
body[data-vscode-theme-kind*="dark"] .tk-num,
body.hermes-dark-detected .tk-num{color:#f78c6c;}
body.vscode-dark .tk-com,
body[data-vscode-theme-kind*="dark"] .tk-com,
body.hermes-dark-detected .tk-com{color:#8b97b1;font-style:italic;}
body.vscode-dark .tk-fn,
body[data-vscode-theme-kind*="dark"] .tk-fn,
body.hermes-dark-detected .tk-fn{color:#82aaff;}

/* edit cards / cluster bar */
.cluster-bar{
  margin:10px 0 6px;padding:8px 12px;border:1px dashed var(--hermes-accent);
  border-radius:var(--hermes-radius);display:flex;justify-content:space-between;align-items:center;
  background:linear-gradient(135deg,var(--vscode-input-background),transparent);
  font-size:12px;animation:slideIn .25s ease;
}
.cluster-bar .actions{display:flex;gap:6px;}

.edit{
  margin:8px 0;padding:10px 12px;border:1px solid var(--vscode-panel-border);
  border-radius:var(--hermes-radius);background:var(--vscode-input-background);
  box-shadow:var(--hermes-shadow);transition:border-color .2s,box-shadow .2s;
  animation:slideIn .25s ease;
}
.edit:hover{border-color:var(--hermes-accent);}
.edit .head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;}
.edit .left{display:flex;align-items:center;gap:8px;min-width:0;}
.edit .icon{font-size:16px;flex-shrink:0;}
.edit .meta{min-width:0;}
.edit .path{font-family:var(--vscode-editor-font-family);font-size:12px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.edit .mode{font-size:9.5px;text-transform:uppercase;opacity:.55;letter-spacing:.5px;}
.edit .actions{display:flex;gap:4px;flex-shrink:0;}
.edit.applied{border-color:#3fb950;background:rgba(63,185,80,.06);}
.edit.applied .icon::after{content:" ✓";color:#3fb950;}
.edit.rejected{opacity:.5;}
.edit .status{font-size:10px;text-transform:uppercase;opacity:.55;margin-top:2px;letter-spacing:.5px;}

/* attachments */
#attachments{padding:0 10px;display:none;}
#attachments.has-items{
  display:flex;gap:6px;flex-wrap:wrap;padding:8px 10px;
  margin:0 10px 0;border-top:1px dashed var(--vscode-panel-border);
  background:color-mix(in srgb, var(--hermes-accent) 4%, transparent);
}
.attach{
  display:inline-flex;align-items:center;gap:6px;padding:4px 8px 4px 6px;
  background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
  border-radius:var(--hermes-radius-sm);font-size:11px;font-weight:500;
  animation:popIn .25s;
  border:1px solid color-mix(in srgb, var(--hermes-accent) 30%, transparent);
}
@keyframes popIn{from{transform:scale(.85);opacity:0;}to{transform:scale(1);opacity:1;}}
.attach img{height:24px;width:24px;object-fit:cover;border-radius:3px;}
.attach .attach-meta{display:flex;flex-direction:column;line-height:1.2;}
.attach .attach-type{font-size:9px;text-transform:uppercase;opacity:.55;letter-spacing:.5px;}
.attach button{background:none;border:none;color:inherit;cursor:pointer;padding:0 2px;font:inherit;opacity:.6;font-size:13px;}
.attach button:hover{opacity:1;}

/* composer — single rounded container with inline icons */
#composer{
  border-top:1px solid var(--vscode-panel-border);padding:10px;
  background:var(--vscode-editor-background);
}
.input-shell{
  display:flex;flex-direction:column;gap:0;
  background:var(--vscode-input-background);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));
  border-radius:var(--hermes-radius);
  transition:border-color .15s,box-shadow .15s;
  position:relative;        /* anchor for child absolute elements */
  /* NB: no overflow:hidden — that clips the mode menu popup */
}
#composer{overflow:visible;}
.input-shell:focus-within{
  border-color:var(--hermes-accent);
  box-shadow:0 0 0 2px color-mix(in srgb, var(--hermes-accent) 18%, transparent);
}
textarea{
  width:100%;min-height:42px;max-height:200px;resize:none;padding:10px 12px 4px;font:inherit;
  background:transparent;color:var(--vscode-input-foreground);
  border:none;outline:none;
}
.input-actions{
  display:flex;align-items:center;gap:2px;padding:2px 6px 6px;
}
.input-actions .left{display:flex;gap:0;}
.input-actions .right{margin-left:auto;display:flex;align-items:center;gap:6px;}
.input-actions button.icon-btn{
  background:transparent;color:var(--vscode-foreground);border:none;
  padding:4px 7px;font-size:14px;cursor:pointer;border-radius:4px;opacity:.55;
  transition:opacity .15s,background .15s,color .15s;
  display:inline-flex;align-items:center;gap:4px;
}
.input-actions button.icon-btn:hover{
  opacity:1;background:var(--vscode-list-hoverBackground);color:var(--hermes-accent);
}
.input-actions button.icon-btn .lbl{font-size:11px;font-weight:500;}
.input-actions button.icon-btn:hover .lbl{display:inline;}
button{
  background:var(--vscode-button-background);color:var(--vscode-button-foreground);
  border:none;padding:6px 12px;cursor:pointer;font:inherit;font-size:12px;
  border-radius:var(--hermes-radius-sm);transition:background .15s;
}
button:hover{background:var(--vscode-button-hoverBackground);}
button.secondary{
  background:transparent;color:var(--vscode-foreground);
  border:1px solid var(--vscode-panel-border);
}
button.secondary:hover{background:var(--vscode-list-hoverBackground);}
#send{
  display:inline-flex;align-items:center;gap:4px;font-weight:500;
  padding:5px 12px;font-size:12px;
}
#send:disabled{opacity:.4;cursor:not-allowed;}

/* mode dropdown */
.mode-wrap{position:relative;}
.mode-btn{
  background:transparent;color:var(--vscode-foreground);
  border:1px solid var(--vscode-panel-border);
  padding:2px 8px 2px 6px;font-size:11px;border-radius:999px;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px;
  transition:border-color .15s,background .15s;
}
.mode-btn:hover{border-color:var(--hermes-accent);background:var(--vscode-list-hoverBackground);}
.mode-btn .mode-icon{font-size:12px;}
.mode-btn .mode-caret{font-size:8px;opacity:.6;}
.mode-menu{
  position:absolute;bottom:calc(100% + 4px);right:0;left:auto;
  background:var(--vscode-editor-background);
  border:1px solid var(--vscode-panel-border);border-radius:var(--hermes-radius-sm);
  box-shadow:0 4px 16px rgba(0,0,0,.25);
  width:min(280px, calc(100vw - 24px));display:none;z-index:100;
  padding:4px;
}
.mode-menu.show{display:block;animation:fadeIn .12s;}
.mode-item{
  padding:8px 10px;border-radius:4px;cursor:pointer;display:flex;gap:8px;align-items:flex-start;
  transition:background .12s;
}
.mode-item:hover{background:var(--vscode-list-hoverBackground);}
.mode-item.active{background:color-mix(in srgb, var(--hermes-accent) 12%, transparent);}
.mode-item .mi-icon{font-size:14px;flex-shrink:0;}
.mode-item .mi-body{flex:1;min-width:0;}
.mode-item .mi-name{font-weight:500;font-size:12px;}
.mode-item .mi-desc{font-size:11px;opacity:.6;margin-top:1px;line-height:1.4;}
.mode-item .mi-check{opacity:0;}
.mode-item.active .mi-check{opacity:1;color:var(--hermes-accent);}

.spinner{display:inline-block;width:10px;height:10px;border:2px solid transparent;
  border-top-color:currentColor;border-radius:50%;animation:spin 1s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}

/* empty state */
#empty{
  display:none;flex-direction:column;align-items:center;justify-content:center;
  padding:32px 20px;text-align:center;gap:14px;flex:1;
  animation:fadeIn .3s;
}
#empty .big-logo{
  width:56px;height:56px;border-radius:50%;
  background:linear-gradient(135deg,var(--hermes-accent),#8a2be2);
  display:grid;place-items:center;color:#fff;font-size:28px;
  box-shadow:0 4px 12px rgba(0,0,0,.12);
}
#empty h3{margin:0;font-size:14px;font-weight:600;}
#empty p{margin:0;opacity:.65;font-size:12px;max-width:320px;line-height:1.5;}
#empty .examples{display:flex;flex-direction:column;gap:6px;width:100%;max-width:320px;margin-top:8px;}
.ex-card{
  padding:10px 12px;background:var(--vscode-input-background);
  border:1px solid var(--vscode-panel-border);border-radius:var(--hermes-radius-sm);
  cursor:pointer;font-size:12px;text-align:left;transition:border-color .15s,background .15s;
}
.ex-card:hover{border-color:var(--hermes-accent);background:var(--vscode-list-hoverBackground);}
.ex-card .ex-icon{margin-right:6px;}

/* scrollbar polish */
#log::-webkit-scrollbar{width:10px;}
#log::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:5px;}
#log::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground);}
</style></head>
<body>
<header>
  <div class="logo">⌘</div>
  <span class="title">Hermes</span>
  <span class="right">
    <span class="pill" id="statusPill"><span class="dot" id="statusDot"></span><span id="statusText">connecting…</span></span>
    <button id="stopBtn" title="Stop generation">■ Stop</button>
  </span>
</header>

<div id="pair">
  <div class="big-logo">⌘</div>
  <h2 id="pairTitle">Pair this VS Code with Hermes</h2>
  <p id="pairBody">A one-time code will be sent to your Telegram. Tap <b>Approve</b> there once — and this device is paired forever.</p>
  <div class="row">
    <button id="btnPair">Start pairing</button>
    <button id="btnSettings" class="secondary">Settings</button>
  </div>
  <div id="codeBlock" style="display:none;">
    <p style="margin-bottom:8px;">Open Telegram and tap <b>Approve</b>:</p>
    <div class="code" id="codeText">--------</div>
    <p style="opacity:.6;font-size:12px;"><span class="spinner"></span>&nbsp;waiting for approval…</p>
    <button id="btnCancelPair" class="secondary">Cancel</button>
  </div>
</div>

<div id="chat">
  <div id="log">
    <div id="empty">
      <div class="big-logo">⌘</div>
      <h3>Ready when you are</h3>
      <p>Ask Hermes anything, paste a screenshot, or attach the active file. Proposed file edits show up as cards you can review.</p>
      <div class="examples"></div>
    </div>
  </div>
  <div id="attachments"></div>
  <div id="composer">
    <div class="input-shell">
      <textarea id="input" placeholder="Ask Hermes…   (Enter to send, Shift+Enter newline)"></textarea>
      <div class="input-actions">
        <div class="left">
          <button id="btnAttachFile" class="icon-btn" title="Attach the currently open editor file to your next message">
            📄<span class="lbl">File</span>
          </button>
          <button id="btnAttachSel"  class="icon-btn" title="Attach the currently selected text from the editor">
            ✂️<span class="lbl">Selection</span>
          </button>
          <button id="clear" class="icon-btn" title="Clear conversation history">
            ⟲
          </button>
        </div>
        <div class="right">
          <div class="mode-wrap">
            <button id="modeBtn" class="mode-btn" title="Edit mode">
              <span class="mode-icon" id="modeIcon">🛡</span>
              <span id="modeLabel">Default</span>
              <span class="mode-caret">▾</span>
            </button>
            <div class="mode-menu" id="modeMenu">
              <div class="mode-item" data-mode="default">
                <span class="mi-icon">🛡</span>
                <div class="mi-body">
                  <div class="mi-name">Default</div>
                  <div class="mi-desc">Review every proposed file edit before applying.</div>
                </div>
                <span class="mi-check">✓</span>
              </div>
              <div class="mode-item" data-mode="auto">
                <span class="mi-icon">⚡</span>
                <div class="mi-body">
                  <div class="mi-name">Auto-edit</div>
                  <div class="mi-desc">Apply edits instantly without confirmation. Cursor-style.</div>
                </div>
                <span class="mi-check">✓</span>
              </div>
              <div class="mode-item" data-mode="plan">
                <span class="mi-icon">📋</span>
                <div class="mi-body">
                  <div class="mi-name">Plan</div>
                  <div class="mi-desc">Hermes writes a plan first, waits for your "go" before editing.</div>
                </div>
                <span class="mi-check">✓</span>
              </div>
            </div>
          </div>
          <button id="send">Send <span style="opacity:.7;">↵</span></button>
        </div>
      </div>
    </div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

// Robust theme detection — reads the actual background colour and tags <body>
// so our CSS selectors match no matter which class scheme VS Code uses.
function detectTheme(){
  const bg = getComputedStyle(document.body).backgroundColor || '';
  // Parse "rgb(r, g, b)" / "rgba(r, g, b, a)"
  const m = bg.match(/rgba?\\(([^)]+)\\)/);
  if (!m) return;
  const parts = m[1].split(',').map(s => parseFloat(s.trim()));
  const [r, g, b] = parts;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return;
  // Perceived luminance (Rec. 709)
  const lum = 0.2126*r + 0.7152*g + 0.0722*b;
  document.body.classList.remove('hermes-light-detected','hermes-dark-detected');
  document.body.classList.add(lum > 140 ? 'hermes-light-detected' : 'hermes-dark-detected');
}
detectTheme();
// Re-run on theme change — VS Code mutates body classes when user toggles theme
new MutationObserver(detectTheme).observe(document.body, { attributes: true, attributeFilter: ['class','data-vscode-theme-kind'] });
const statusText=document.getElementById('statusText');
const statusPill=document.getElementById('statusPill');
const statusDot=document.getElementById('statusDot');
const stopBtn=document.getElementById('stopBtn');
const pair=document.getElementById('pair');
const chat=document.getElementById('chat');
const log=document.getElementById('log');
const empty=document.getElementById('empty');
const input=document.getElementById('input');
const codeBlock=document.getElementById('codeBlock');
const codeText=document.getElementById('codeText');
const pairBody=document.getElementById('pairBody');
const pairTitle=document.getElementById('pairTitle');
const attachmentsBar=document.getElementById('attachments');

let lastAssistant=null;
let typingEl=null;
const editEls=new Map();
const clusterEls=new Map();

const EXAMPLES = [
  { icon: '📝', text: 'Объясни функцию в активном файле' },
  { icon: '🐛', text: 'Найди баг в этом коде' },
  { icon: '✨', text: 'Создай README для этого проекта' },
  { icon: '🖼', text: 'Опиши скриншот, который я вставлю' }
];
function renderExamples(){
  const c = empty.querySelector('.examples');
  c.innerHTML = '';
  for (const ex of EXAMPLES) {
    const b = document.createElement('button');
    b.className = 'ex-card';
    b.innerHTML = '<span class="ex-icon">'+ex.icon+'</span>'+escapeHtml(ex.text);
    b.addEventListener('click', () => {
      input.value = ex.text;
      input.focus();
    });
    c.appendChild(b);
  }
}
renderExamples();

function show(view){
  pair.style.display = view==='pair' ? 'flex':'none';
  chat.style.display = view==='chat' ? 'flex':'none';
  updateEmpty();
}
function updateEmpty(){
  const hasMessages = log.children.length > 1 || (log.children.length === 1 && log.children[0].id !== 'empty');
  empty.style.display = hasMessages ? 'none' : 'flex';
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

function renderMarkdown(src){
  const lines = src.split('\\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\\s*\`\`\`([a-zA-Z0-9_+-]*)\\s*$/);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^\\s*\`\`\`\\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const code = buf.join('\\n');
      out.push('<pre><button class="copy-btn" data-code="'+escapeHtml(code).replace(/"/g,'&quot;')+'">Copy</button><code>'+highlight(code, lang)+'</code></pre>');
      continue;
    }
    const h = line.match(/^(#{1,3})\\s+(.+)$/);
    if (h) { out.push('<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>'); i++; continue; }
    if (/^---+\\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.startsWith('> ')) { out.push('<blockquote>'+inline(line.slice(2))+'</blockquote>'); i++; continue; }
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
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|>|---|\\s*[-*]|\\s*\\d+\\.|\\s*\`\`\`)/.test(lines[i])) {
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
  let langKey = lang;
  if (lang === 'tsx' || lang === 'jsx') langKey = 'ts';
  if (lang === 'python') langKey = 'py';
  if (lang === 'bash' || lang === 'zsh' || lang === 'shell') langKey = 'sh';
  if (lang === 'rust') langKey = 'rs';
  if (lang === 'javascript') langKey = 'js';
  if (lang === 'typescript') langKey = 'ts';
  const kws = KW[langKey];
  if (!kws) return escapeHtml(code);
  let s = escapeHtml(code);
  if (langKey === 'py' || langKey === 'sh') {
    s = s.replace(/(^|\\n)([^\\n]*#[^\\n]*)/g, (m,a,b) => a + '<span class="tk-com">'+b+'</span>');
  } else {
    s = s.replace(/(\\/\\/[^\\n]*)/g, '<span class="tk-com">$1</span>');
    s = s.replace(/(\\/\\*[\\s\\S]*?\\*\\/)/g, '<span class="tk-com">$1</span>');
  }
  s = s.replace(/(&quot;[^&\\n]*?&quot;|&#39;[^&\\n]*?&#39;|\`[^\`\\n]*\`)/g, '<span class="tk-str">$1</span>');
  s = s.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g, '<span class="tk-num">$1</span>');
  const kwre = new RegExp('\\\\b('+kws.join('|')+')\\\\b','g');
  s = s.replace(kwre, '<span class="tk-kw">$1</span>');
  s = s.replace(/([A-Za-z_][A-Za-z0-9_]*)\\(/g, '<span class="tk-fn">$1</span>(');
  return s;
}

function avatarFor(role){
  if (role === 'user') return '<div class="avatar user">У</div>';
  if (role === 'assistant') return '<div class="avatar assistant">⌘</div>';
  return '<div class="avatar system">i</div>';
}

function newBubble(role, kind, markdown){
  const wrap = document.createElement('div');
  const cls = ['msg', kind || role];
  wrap.className = cls.join(' ');
  if (kind === 'system' || kind === 'usage' || kind === 'thinking' || role === 'system') {
    const b = document.createElement('div');
    b.className = 'bubble';
    wrap.appendChild(b);
    log.appendChild(wrap);
    return { root: wrap, body: b };
  }
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = avatarFor(role);
  const body = document.createElement('div');
  body.className = 'msg-body';
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (markdown ? ' md' : '');
  body.appendChild(bubble);
  row.appendChild(body);
  wrap.appendChild(row);
  log.appendChild(wrap);
  return { root: wrap, body: bubble };
}

function removeTyping(){
  if (typingEl) { typingEl.remove(); typingEl = null; }
}
function showTyping(){
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'msg thinking';
  typingEl.innerHTML = '<div class="msg-row">'+avatarFor('assistant')+'<div class="msg-body"><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div></div></div>';
  log.appendChild(typingEl);
  log.scrollTop = log.scrollHeight;
}

function append(role, text, kind, opts){
  opts = opts || {};
  if(role==='assistant' && !kind){
    removeTyping();
    if(!lastAssistant){
      lastAssistant = newBubble(role, undefined, true);
      lastAssistant.raw = '';
    }
    lastAssistant.raw += text;
    lastAssistant.body.innerHTML = renderMarkdown(lastAssistant.raw);
    bindCopyButtons(lastAssistant.body);
  } else {
    const b = newBubble(role, kind, false);
    b.body.textContent = text;
    if (opts.retryable) {
      const btn = document.createElement('button');
      btn.className = 'retry-btn';
      btn.innerHTML = '↻ Retry';
      btn.addEventListener('click', () => vscode.postMessage({type:'retry'}));
      b.root.appendChild(btn);
    }
    if(role==='user') lastAssistant=null;
  }
  updateEmpty();
  log.scrollTop=log.scrollHeight;
}

function bindCopyButtons(scope){
  scope.querySelectorAll('.copy-btn:not(.bound)').forEach(btn => {
    btn.classList.add('bound');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const code = btn.getAttribute('data-code') || '';
      const decoded = code.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
      navigator.clipboard.writeText(decoded).then(() => {
        btn.textContent = '✓ Copied';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent='Copy'; btn.classList.remove('done'); }, 1500);
      });
    });
  });
}

function send(){
  const v=input.value.trim();
  if(!v) return;
  append('user',v);
  showTyping();
  vscode.postMessage({type:'prompt',text:v});
  input.value='';
  autoResize();
}

function autoResize(){
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

function renderAttachments(items){
  attachmentsBar.innerHTML='';
  attachmentsBar.classList.toggle('has-items', items.length > 0);
  for(const it of items){
    const el=document.createElement('span');
    el.className='attach';
    el.title='Will be sent with your next message';
    if (it.thumbnail) {
      const img=document.createElement('img');
      img.src=it.thumbnail; img.alt='';
      el.appendChild(img);
    } else {
      const ic=document.createElement('span');
      ic.textContent = it.type==='image' ? '🖼' : '📄';
      ic.style.fontSize='15px';ic.style.padding='0 2px';
      el.appendChild(ic);
    }
    const meta=document.createElement('span');
    meta.className='attach-meta';
    const typeSpan=document.createElement('span');
    typeSpan.className='attach-type';
    typeSpan.textContent = it.type === 'image' ? 'image' : 'attached file';
    const lblSpan=document.createElement('span');
    lblSpan.textContent=it.label;
    meta.appendChild(typeSpan);meta.appendChild(lblSpan);
    el.appendChild(meta);
    const btn=document.createElement('button');btn.textContent='✕';btn.title='Remove this attachment';
    btn.addEventListener('click',()=>vscode.postMessage({type:'removeAttachment',id:it.id}));
    el.appendChild(btn);
    attachmentsBar.appendChild(el);
  }
}

function editIconFor(mode){
  return mode === 'create' ? '✨' : mode === 'delete' ? '🗑' : '✏️';
}

function renderEdit(e){
  let wrap=editEls.get(e.id);
  if(!wrap){
    wrap=document.createElement('div');
    wrap.className='edit';
    wrap.innerHTML = ''
      + '<div class="head">'
      +   '<div class="left">'
      +     '<span class="icon">'+editIconFor(e.mode)+'</span>'
      +     '<div class="meta">'
      +       '<div class="path">'+escapeHtml(e.path)+'</div>'
      +       '<span class="mode">'+e.mode+'</span>'
      +     '</div>'
      +   '</div>'
      +   '<div class="actions"><button data-action="review">Review</button></div>'
      + '</div>'
      + '<div class="status">'+e.status+'</div>';
    wrap.querySelector('[data-action="review"]').addEventListener('click',()=>vscode.postMessage({type:'reviewEdit',id:e.id}));
    log.appendChild(wrap);
    editEls.set(e.id, wrap);
    updateEmpty();
  }
  wrap.classList.remove('applied','rejected');
  if(e.status==='applied') wrap.classList.add('applied');
  if(e.status==='rejected') wrap.classList.add('rejected');
  wrap.querySelector('.status').textContent=e.status;
  log.scrollTop=log.scrollHeight;
}

function renderClusterBar(clusterId, count){
  if (clusterEls.has(clusterId)) return;
  const bar=document.createElement('div');
  bar.className='cluster-bar';
  bar.innerHTML = '<span><b>'+count+'</b> file edits proposed</span>'
    + '<div class="actions">'
    +   '<button data-act="apply">Apply All</button>'
    +   '<button data-act="reject" class="secondary">Reject All</button>'
    + '</div>';
  bar.querySelector('[data-act="apply"]').addEventListener('click',()=>vscode.postMessage({type:'applyCluster',clusterId}));
  bar.querySelector('[data-act="reject"]').addEventListener('click',()=>vscode.postMessage({type:'rejectCluster',clusterId}));
  log.appendChild(bar);
  clusterEls.set(clusterId, bar);
  log.scrollTop=log.scrollHeight;
}

document.getElementById('btnPair').addEventListener('click',()=>vscode.postMessage({type:'pair'}));
document.getElementById('btnSettings').addEventListener('click',()=>vscode.postMessage({type:'settings'}));
document.getElementById('btnCancelPair').addEventListener('click',()=>vscode.postMessage({type:'cancelPair'}));
document.getElementById('send').addEventListener('click',send);
document.getElementById('btnAttachFile').addEventListener('click',()=>vscode.postMessage({type:'attachFile'}));
document.getElementById('btnAttachSel').addEventListener('click',()=>vscode.postMessage({type:'attachSelection'}));
document.getElementById('clear').addEventListener('click',()=>{
  // keep empty state element, remove all messages
  log.querySelectorAll('.msg, .edit, .cluster-bar').forEach(n => n.remove());
  lastAssistant=null;editEls.clear();clusterEls.clear();
  vscode.postMessage({type:'clear'});
  updateEmpty();
});
stopBtn.addEventListener('click',()=>vscode.postMessage({type:'stop'}));
input.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
input.addEventListener('input', autoResize);

// mode dropdown
const modeBtn = document.getElementById('modeBtn');
const modeMenu = document.getElementById('modeMenu');
const modeIcon = document.getElementById('modeIcon');
const modeLabel = document.getElementById('modeLabel');
const MODE_META = {
  'default': { icon: '🛡', label: 'Default' },
  'auto':    { icon: '⚡', label: 'Auto-edit' },
  'plan':    { icon: '📋', label: 'Plan' }
};
let currentMode = 'default';
function setActiveMode(m){
  currentMode = m;
  const meta = MODE_META[m] || MODE_META.default;
  modeIcon.textContent = meta.icon;
  modeLabel.textContent = meta.label;
  modeMenu.querySelectorAll('.mode-item').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === m);
  });
}
setActiveMode('default');
modeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  modeMenu.classList.toggle('show');
});
document.addEventListener('click', () => modeMenu.classList.remove('show'));
modeMenu.querySelectorAll('.mode-item').forEach(el => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = el.dataset.mode;
    setActiveMode(m);
    modeMenu.classList.remove('show');
    vscode.postMessage({ type: 'setMode', mode: m });
  });
});

input.addEventListener('paste',(e)=>{
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => vscode.postMessage({type:'pasteImage', dataUrl: reader.result});
      reader.readAsDataURL(blob);
    }
  }
});

window.addEventListener('message',(ev)=>{
  const m=ev.data;
  if(m.type==='message'){
    append(m.role, m.text, m.kind, {retryable: m.retryable});
  }
  else if(m.type==='status'){
    statusText.textContent = m.text;
    statusPill.classList.toggle('busy', !!m.busy);
    statusDot.classList.toggle('warn', !!m.busy);
    stopBtn.classList.toggle('show', !!m.busy);
    if (!m.busy) removeTyping();
  }
  else if(m.type==='busy'){
    stopBtn.classList.toggle('show', !!m.busy);
    statusPill.classList.toggle('busy', !!m.busy);
    if (!m.busy) removeTyping();
  }
  else if(m.type==='attachments'){renderAttachments(m.items);}
  else if(m.type==='edit'){renderEdit(m);}
  else if(m.type==='cluster'){renderClusterBar(m.clusterId, m.count);}
  else if(m.type==='editStatus'){
    const w=editEls.get(m.id); if(w){ w.classList.remove('applied','rejected');
      if(m.status==='applied') w.classList.add('applied');
      if(m.status==='rejected') w.classList.add('rejected');
      w.querySelector('.status').textContent=m.status; }
  }
  else if(m.type==='mode'){
    setActiveMode(m.mode || 'default');
  }
  else if(m.type==='loadHistory'){
    log.querySelectorAll('.msg, .edit, .cluster-bar').forEach(n => n.remove());
    lastAssistant=null;
    for (const it of m.items) append(it.role, it.text, it.kind);
    updateEmpty();
  }
  else if(m.type==='state'){
    const s=m.state;
    if(s.kind==='needsPair'){show('pair');codeBlock.style.display='none';
      pairTitle.textContent='Pair this VS Code with Hermes';}
    else if(s.kind==='pairing'){show('pair');codeBlock.style.display='block';
      codeText.textContent=s.code;}
    else if(s.kind==='ready'){show('chat');input.focus();}
    else if(s.kind==='error'){show('pair');codeBlock.style.display='none';
      pairTitle.textContent='Error';
      pairBody.textContent=s.message+' — check Settings (Hermes › Bridge URL) or try again.';}
  }
});
</script></body></html>`;
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
