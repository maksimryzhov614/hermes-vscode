import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
import { URL } from "node:url";

const REPO_API = "https://api.github.com/repos/maksimryzhov614/hermes-vscode/releases/latest";

interface GhRelease {
  tag_name: string;
  name: string;
  html_url: string;
  body: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

/**
 * Check GitHub Releases for a newer .vsix and offer to install it.
 *
 * Trigger on activate (with a small delay so it doesn't block startup) and
 * also on a manual "Hermes: Check for updates" command.
 */
export async function checkForUpdates(
  ctx: vscode.ExtensionContext,
  log: (s: string) => void,
  opts: { silent?: boolean } = {}
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("hermes");
  if (cfg.get<boolean>("checkUpdates", true) === false && opts.silent) return;

  const currentVersion = ctx.extension.packageJSON.version as string;
  let release: GhRelease;
  try {
    release = await fetchJson<GhRelease>(REPO_API);
  } catch (e: any) {
    log("update check failed: " + (e?.message ?? e));
    if (!opts.silent) vscode.window.showErrorMessage("Hermes: update check failed: " + e.message);
    return;
  }

  const latestVersion = release.tag_name.replace(/^v/i, "");
  if (compareSemver(latestVersion, currentVersion) <= 0) {
    log(`update check: already on latest (${currentVersion})`);
    if (!opts.silent) vscode.window.showInformationMessage(`Hermes is up to date (v${currentVersion}).`);
    return;
  }

  const asset = release.assets.find((a) => a.name.endsWith(".vsix"));
  if (!asset) {
    log("latest release has no .vsix asset");
    if (!opts.silent) vscode.window.showWarningMessage(`Hermes ${release.tag_name} is out but has no .vsix.`);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Hermes: new version available — v${currentVersion} → v${latestVersion}`,
    { modal: false },
    "Install & reload",
    "View release",
    "Skip"
  );

  if (choice === "View release") {
    void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    return;
  }
  if (choice !== "Install & reload") return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Updating Hermes to v${latestVersion}…`, cancellable: false },
    async (progress) => {
      const tmpPath = path.join(os.tmpdir(), `hermes-vscode-${latestVersion}-${Date.now()}.vsix`);
      progress.report({ message: "downloading…" });
      try {
        await downloadFile(asset.browser_download_url, tmpPath, asset.size);
        progress.report({ message: "installing…" });
        await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(tmpPath));
        log(`installed v${latestVersion} from ${tmpPath}`);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (e: any) {
        log("update install failed: " + (e?.message ?? e));
        vscode.window.showErrorMessage("Hermes update failed: " + (e?.message ?? e));
        return;
      }
      const reload = await vscode.window.showInformationMessage(
        `Hermes updated to v${latestVersion}. Reload window now?`,
        "Reload window", "Later"
      );
      if (reload === "Reload window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  );
}

/** "1.2.10" vs "1.2.9" → 1 ; equal → 0 ; older → -1. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function fetchJson<T>(rawUrl: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const req = https.request({
      method: "GET",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "hermes-vscode-updater"
      }
    }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url.hostname}`));
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => buf += c);
      res.on("end", () => {
        try { resolve(JSON.parse(buf) as T); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function downloadFile(rawUrl: string, dest: string, expectedSize?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fetchInner = (urlStr: string, hops: number) => {
      if (hops > 5) return reject(new Error("too many redirects"));
      const url = new URL(urlStr);
      const req = https.request({
        method: "GET",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: { "User-Agent": "hermes-vscode-updater" }
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const next = res.headers.location;
          res.resume();
          if (!next) return reject(new Error("redirect without Location"));
          return fetchInner(next.startsWith("http") ? next : new URL(next, urlStr).toString(), hops + 1);
        }
        if ((res.statusCode ?? 0) >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${urlStr}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => {
          out.close();
          if (expectedSize !== undefined && fs.statSync(dest).size !== expectedSize) {
            return reject(new Error(`size mismatch: got ${fs.statSync(dest).size}, expected ${expectedSize}`));
          }
          resolve();
        });
        out.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(60000, () => req.destroy(new Error("download timeout")));
      req.end();
    };
    fetchInner(rawUrl, 0);
  });
}
