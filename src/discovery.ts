import { execFile } from "node:child_process";
import * as http from "node:http";
import { URL } from "node:url";

const BRIDGE_PORT = 8643;
const PROBE_TIMEOUT_MS = 1500;
const TS_TIMEOUT_MS = 4000;

/**
 * Auto-discovery: try in order, return the first reachable bridge URL,
 * or null if nothing is found. Pure stdlib — no extra deps.
 *
 *   1. localhost  — bridge running on the same machine (WSL, Docker)
 *   2. Tailscale  — `tailscale status --json` → probe every online peer
 *
 * Future strategies (mDNS, well-known DNS) plug in here.
 */
export async function discover(log: (s: string) => void = () => {}): Promise<string | null> {
  const local = await tryLocalhost(log);
  if (local) return local;
  const ts = await tryTailscale(log);
  if (ts) return ts;
  return null;
}

async function tryLocalhost(log: (s: string) => void): Promise<string | null> {
  for (const host of ["127.0.0.1", "localhost"]) {
    const url = `http://${host}:${BRIDGE_PORT}`;
    if (await probeBridge(url)) {
      log(`discovery: localhost hit at ${url}`);
      return url;
    }
  }
  return null;
}

async function tryTailscale(log: (s: string) => void): Promise<string | null> {
  let peers: string[];
  try {
    peers = await listTailscalePeers();
  } catch (e: any) {
    log(`discovery: tailscale unavailable (${e.message ?? e})`);
    return null;
  }
  if (peers.length === 0) {
    log("discovery: no online Tailscale peers");
    return null;
  }
  log(`discovery: probing ${peers.length} Tailscale peer(s): ${peers.join(", ")}`);
  // Probe all in parallel — first success wins.
  const probes = peers.map((ip) => {
    const url = `http://${ip}:${BRIDGE_PORT}`;
    return probeBridge(url).then((ok) => (ok ? url : null));
  });
  const results = await Promise.allSettled(probes);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      log(`discovery: Tailscale peer hit at ${r.value}`);
      return r.value;
    }
  }
  return null;
}

/** GET <baseUrl>/health and check it returns {service: "hermes-bridge"}. */
function probeBridge(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL("/health", baseUrl); } catch { return resolve(false); }
    const req = http.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        timeout: PROBE_TIMEOUT_MS
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          res.resume(); return resolve(false);
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const obj = JSON.parse(buf);
            resolve(obj?.service === "hermes-bridge");
          } catch { resolve(false); }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Parse `tailscale status --json` and return online peer Tailscale IPv4s. */
function listTailscalePeers(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const candidates = candidateTailscaleBins();
    tryNext(0);
    function tryNext(i: number): void {
      if (i >= candidates.length) {
        reject(new Error("tailscale binary not found in PATH or known locations"));
        return;
      }
      execFile(
        candidates[i], ["status", "--json"],
        { timeout: TS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) { tryNext(i + 1); return; }
          try {
            const obj = JSON.parse(stdout);
            const peers: string[] = [];
            for (const p of Object.values<any>(obj?.Peer ?? {})) {
              if (!p?.Online) continue;
              const ips: string[] = p?.TailscaleIPs ?? [];
              const v4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
              if (v4) peers.push(v4);
            }
            resolve(peers);
          } catch (e: any) { reject(new Error(`parse failed: ${e.message}`)); }
        }
      );
    }
  });
}

/** Try the binary in PATH first, then fall back to OS-specific install paths. */
function candidateTailscaleBins(): string[] {
  const xs = ["tailscale"];
  if (process.platform === "win32") {
    xs.push("C:\\Program Files\\Tailscale\\tailscale.exe");
    xs.push("C:\\Program Files (x86)\\Tailscale\\tailscale.exe");
  } else if (process.platform === "darwin") {
    xs.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    xs.push("/usr/local/bin/tailscale");
  } else {
    xs.push("/usr/bin/tailscale", "/usr/local/bin/tailscale");
  }
  return xs;
}
