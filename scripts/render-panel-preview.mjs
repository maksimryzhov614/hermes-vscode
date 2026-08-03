import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputArguments = process.argv.slice(2);
if (outputArguments.length !== 1) {
  throw new Error("Usage: node scripts/render-panel-preview.mjs <output.html>");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const source = await readFile(
  resolve(repositoryRoot, "src/chatPanel.ts"),
  "utf8",
);
const templatePrefix = "return /* html */ `";
const templateStartMarker = `${templatePrefix}<!DOCTYPE html>`;
const templateStart = source.indexOf(templateStartMarker);
if (templateStart < 0) throw new Error("Webview template start was not found");

const htmlStart = templateStart + templatePrefix.length;
const templateEnd = source.indexOf("`;\n  }\n}", htmlStart);
if (templateEnd < 0) throw new Error("Webview template end was not found");

const rawHtml = source.slice(htmlStart, templateEnd);
const interpolations = [...rawHtml.matchAll(/\$\{([^}]+)\}/gu)].map(
  (match) => match[1],
);
if (
  interpolations.some((value) => value !== "csp" && value !== "nonce") ||
  !interpolations.includes("csp") ||
  !interpolations.includes("nonce")
) {
  throw new Error("Unexpected webview template interpolation");
}

const substitutedHtml = rawHtml
  .replaceAll("${csp}", "preview-csp")
  .replaceAll("${nonce}", "preview");
const cookTemplate = new Function(
  `"use strict"; return \`${substitutedHtml}\`;`,
);
let html = cookTemplate();
if (typeof html !== "string") throw new Error("Webview template is not text");

const csp =
  '<meta http-equiv="Content-Security-Policy" content="preview-csp">\n';
if (!html.includes(csp)) throw new Error("Expected webview CSP was not found");
html = html.replace(csp, "");

const scriptStart = '<script nonce="preview">\n';
if (!html.includes(scriptStart)) throw new Error("Webview script was not found");
html = html.replace(
  scriptStart,
  `${scriptStart}function acquireVsCodeApi(){return {postMessage(){},getState(){return undefined;},setState(){}};}\n`,
);

const sampleEvents = `<script>
window.addEventListener('DOMContentLoaded', () => {
  window.postMessage({ type: 'workspace', name: 'sample-app', branch: 'main' }, '*');
  window.postMessage({ type: 'state', state: { kind: 'ready' } }, '*');
  window.postMessage({ type: 'loadHistory', items: [
    { role: 'user', text: 'Review src/cart.ts before I merge it.' },
    { role: 'assistant', text: 'I found one change to review in src/cart.ts.', markdown: true },
  ] }, '*');
  window.postMessage({ type: 'edit', id: 'edit-1', path: 'src/cart.ts', mode: 'replace', status: 'pending' }, '*');
  window.postMessage({ type: 'usage', in: 1280, out: 240 }, '*');
});
</script>`;
if (!html.includes("</body>")) throw new Error("Webview body end was not found");
html = html.replace("</body>", `${sampleEvents}\n</body>`);

await writeFile(resolve(outputArguments[0]), html, "utf8");
