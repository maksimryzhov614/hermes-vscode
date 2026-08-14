import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(".");

describe("portfolio documentation", () => {
  it("is English-first, bilingual, testable, and honest about hosting", async () => {
    const [english, russian, security, contributing, changelog] =
      await Promise.all([
        readFile(resolve(root, "README.md"), "utf8"),
        readFile(resolve(root, "README.ru.md"), "utf8"),
        readFile(resolve(root, "SECURITY.md"), "utf8"),
        readFile(resolve(root, "CONTRIBUTING.md"), "utf8"),
        readFile(resolve(root, "CHANGELOG.md"), "utf8"),
      ]);

    expect(english).toMatch(/^# Hermes Agent — VS Code Extension$/mu);
    expect(english).toContain("[Русский](./README.ru.md)");
    expect(english).toContain(
      "![Hermes Agent interface preview](docs/assets/hermes-panel.png)",
    );
    expect(english).toContain("No hosted bridge is included");
    expect(english).toContain("npm test");
    expect(english).toContain("npx tsc --noEmit");
    expect(english).toContain("npm run build");
    expect(english).toContain("[Security policy](./SECURITY.md)");
    expect(english).toContain("[Contributing guide](./CONTRIBUTING.md)");
    expect(english).toContain("[Changelog](./CHANGELOG.md)");
    expect(russian).toMatch(/^# Hermes Agent — расширение для VS Code$/mu);
    expect(russian).toContain("[English](./README.md)");
    expect(russian).toContain("docs/assets/hermes-panel.png");
    expect(security).toContain("Private vulnerability reporting");
    expect(contributing).toContain("npm test");
    expect(changelog).toContain("## 0.10.2 — 2026-08-03");
    expect(changelog).toContain(
      "Reject unsafe edit paths before preview, deletion, directory creation, or write operations.",
    );
    expect(changelog).toContain(
      "Added protected push and pull-request verification, workflow contracts, and dependency updates.",
    );
    expect(changelog).toContain(
      "Added English-first documentation, project policies, and a reproducible Google Chrome interface preview.",
    );
    expect(changelog).toContain(
      "Hardened preview capture and workspace path validation after independent review.",
    );
    expect(english).toContain("git tag v0.10.2");
    expect(english).toContain("git push origin v0.10.2");
    expect(russian).toContain("git tag v0.10.2");
    expect(russian).toContain("git push origin v0.10.2");
  });

  it("uses consistent public package identity and versioning", async () => {
    const [packageSource, lockSource, license] = await Promise.all([
      readFile(resolve(root, "package.json"), "utf8"),
      readFile(resolve(root, "package-lock.json"), "utf8"),
      readFile(resolve(root, "LICENSE"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageSource) as {
      author?: unknown;
      homepage?: unknown;
      scripts?: Record<string, unknown>;
      version?: unknown;
    };
    const packageLock = JSON.parse(lockSource) as {
      packages?: { ""?: { version?: unknown } };
      version?: unknown;
    };

    expect(packageJson).toMatchObject({
      author: "Maksim Ryzhov",
      homepage: "https://github.com/maksimryzhov614/hermes-vscode",
      version: "0.10.2",
    });
    expect(packageJson.scripts?.["preview:capture"]).toBe(
      "node scripts/capture-panel-preview.mjs docs/assets/hermes-panel.png",
    );
    expect(packageLock.version).toBe("0.10.2");
    expect(packageLock.packages?.[""]?.version).toBe("0.10.2");
    expect(license).toContain("Copyright (c) 2026 Maksim Ryzhov");
  });

  it("ships a bounded 960x720 PNG generated from public-safe sample data", async () => {
    const imagePath = resolve(root, "docs/assets/hermes-panel.png");
    const [image, imageStat, renderer, capture, english, russian] =
      await Promise.all([
      readFile(imagePath),
      stat(imagePath),
      readFile(resolve(root, "scripts/render-panel-preview.mjs"), "utf8"),
      readFile(resolve(root, "scripts/capture-panel-preview.mjs"), "utf8"),
      readFile(resolve(root, "README.md"), "utf8"),
      readFile(resolve(root, "README.ru.md"), "utf8"),
      ]);

    expect(image.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(image.readUInt32BE(16)).toBe(960);
    expect(image.readUInt32BE(20)).toBe(720);
    expect(imageStat.size).toBeGreaterThan(20_000);
    expect(imageStat.size).toBeLessThan(1_000_000);
    expect(renderer).toContain("src/chatPanel.ts");
    expect(renderer).toContain('type: \'workspace\', name: \'sample-app\'');
    expect(renderer).toContain('type: \'state\', state: { kind: \'ready\' }');
    expect(renderer).toContain("Review src/cart.ts before I merge it.");
    expect(renderer).toContain("Content-Security-Policy");
    expect(renderer).toContain("acquireVsCodeApi");
    expect(capture).toContain('channel: "chrome"');
    expect(capture).toContain("width: 960");
    expect(capture).toContain("height: 720");
    expect(capture).toContain("render-panel-preview.mjs");
    expect(english).toContain("npm run preview:capture");

    const publicText = [renderer, capture, english, russian].join("\n");
    const pngStrings = image.toString("latin1");
    const formerAccount = new RegExp(["lil", "debil"].join(""), "iu");
    const credentialPrefix = new RegExp(
      `${["github", "pat"].join("_")}_|${["npm", "[A-Za-z0-9]{20,}"].join("_")}`,
      "u",
    );
    for (const content of [publicText, pngStrings]) {
      expect(content).not.toMatch(formerAccount);
      expect(content).not.toMatch(/\/(?:Users|home)\//u);
      expect(content).not.toMatch(credentialPrefix);
      expect(content).not.toMatch(/\b(?:Tunika|Mansara|Artsquare)\b/iu);
      expect(content).not.toMatch(/Documents\/|private\/|\.ssh\//iu);
    }
    expect([renderer, capture, pngStrings].join("\n")).not.toMatch(
      /https?:\/\/(?!hermes\.example\.com(?:[/:]|$))/iu,
    );
  });
});
