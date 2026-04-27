import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

export interface BridgeConfig {
  baseUrl: string;
  token?: string;
}

export interface PairInitResult {
  code: string;
  expiresIn: number;
  instructions: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** Plain string OR multimodal array (OpenAI format). */
  content: string | ContentPart[];
}

/**
 * HTTP client for hermes-bridge.
 *
 * Pairing:        /pair/init, /pair/poll
 * Chat:           /v1/chat/completions  (SSE streaming, OpenAI multimodal)
 *
 * For multimodal content (images), pass `content` as an array of ContentPart.
 */
export class BridgeClient {
  constructor(private cfg: BridgeConfig) {}

  setToken(token: string | undefined): void { this.cfg.token = token; }

  async pairInit(clientName: string): Promise<PairInitResult> {
    const r = await this.json<any>("POST", "/pair/init", { client_name: clientName });
    return { code: r.code, expiresIn: r.expires_in, instructions: r.instructions };
  }

  async pairPoll(code: string): Promise<string | null> {
    const { status, body } = await this.raw("POST", "/pair/poll", { code });
    if (status === 202) return null;
    if (status === 200) return JSON.parse(body).token;
    if (status === 410) throw new Error("pair code expired or invalid");
    throw new Error(`pair poll failed: HTTP ${status} — ${body.slice(0, 200)}`);
  }

  async chatStream(
    messages: ChatMessage[],
    onDelta: (chunk: string) => void,
    opts: { sessionId?: string; abort?: AbortSignal; onUsage?: (u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void } = {}
  ): Promise<void> {
    const url = new URL("/v1/chat/completions", this.cfg.baseUrl);
    const body = JSON.stringify({ model: "hermes-agent", stream: true, messages });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Authorization": `Bearer ${this.cfg.token ?? ""}`
    };
    if (opts.sessionId) headers["X-Hermes-Session-Id"] = opts.sessionId;

    return new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request({
        method: "POST", hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) }
      }, (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          let err = "";
          res.on("data", (d) => err += d.toString("utf8"));
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${err.slice(0, 300)}`)));
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n\n")) >= 0) {
            const event = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") return;
              try {
                const obj = JSON.parse(data);
                const delta = obj?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta) onDelta(delta);
                if (obj?.usage && opts.onUsage) opts.onUsage(obj.usage);
              } catch { /* tolerate non-JSON keepalives */ }
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", reject);
      });
      opts.abort?.addEventListener("abort", () => req.destroy(new Error("aborted")));
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, body: text } = await this.raw(method, path, body);
    if (status >= 400) throw new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  private raw(method: string, path: string, body?: unknown):
    Promise<{ status: number; body: string }>
  {
    const url = new URL(path, this.cfg.baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (this.cfg.token) headers["Authorization"] = `Bearer ${this.cfg.token}`;
    return new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request({
        method, hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search, headers
      }, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => buf += c);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}
