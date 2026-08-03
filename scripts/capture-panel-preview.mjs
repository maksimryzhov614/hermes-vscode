import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const outputArguments = process.argv.slice(2);
if (outputArguments.length !== 1) {
  throw new Error(
    "Usage: node scripts/capture-panel-preview.mjs <output.png>",
  );
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(outputArguments[0]);
const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), "hermes-panel-preview-"),
);
const htmlPath = resolve(temporaryRoot, "panel.html");
let browser;

try {
  await execFileAsync(process.execPath, [
    resolve(repositoryRoot, "scripts/render-panel-preview.mjs"),
    htmlPath,
  ]);
  await mkdir(dirname(outputPath), { recursive: true });

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 960, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  await page.locator(".edit .path").waitFor();
  if ((await page.locator(".edit .path").textContent()) !== "src/cart.ts") {
    throw new Error("Preview did not render the synthetic edit card");
  }
  if (browserErrors.length > 0) {
    throw new Error(`Preview browser errors: ${browserErrors.join(" | ")}`);
  }
  await page.screenshot({
    path: outputPath,
    type: "png",
    animations: "disabled",
  });
} finally {
  await browser?.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
