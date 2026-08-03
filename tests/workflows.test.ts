import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Data = Record<string, unknown>;

function object(value: unknown): Data {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Data;
}

async function yamlFile(path: string): Promise<Data> {
  return object(parse(await readFile(resolve(path), "utf8")));
}

function steps(workflow: Data, jobName: string): Data[] {
  const jobs = object(workflow.jobs);
  const job = object(jobs[jobName]);
  if (!Array.isArray(job.steps)) throw new Error("Expected job steps");
  return job.steps.map(object);
}

describe("GitHub Actions contracts", () => {
  it("verifies every push to main and pull request on Node 24", async () => {
    const workflow = await yamlFile(".github/workflows/ci.yml");

    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    const verify = object(object(workflow.jobs).verify);
    expect(verify["runs-on"]).toBe("ubuntu-latest");
    expect(steps(workflow, "verify")).toEqual([
      { uses: "actions/checkout@v6" },
      {
        uses: "actions/setup-node@v6",
        with: { "node-version": "24", cache: "npm" },
      },
      { run: "npm ci" },
      { run: "npm test" },
      { run: "npx tsc --noEmit" },
      { run: "npm run build" },
      {
        run: "npx vsce package --no-dependencies --out hermes-vscode.vsix",
      },
    ]);
  });

  it("releases only exact package-version tags on Node 24", async () => {
    const workflow = await yamlFile(".github/workflows/release.yml");

    expect(workflow.on).toEqual({ push: { tags: ["v*.*.*"] } });
    expect(object(workflow.on)).not.toHaveProperty("workflow_dispatch");
    const releaseSteps = steps(workflow, "release");
    expect(releaseSteps[0]).toEqual({ uses: "actions/checkout@v6" });
    expect(releaseSteps[1]).toEqual({
      uses: "actions/setup-node@v6",
      with: { "node-version": "24", cache: "npm" },
    });

    const scripts = releaseSteps
      .map((step) => step.run)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    expect(scripts).toContain("GITHUB_REF_NAME");
    expect(scripts).toContain("package.json");
    expect(scripts).toContain('"v$PACKAGE_VERSION"');
    expect(scripts).toMatch(/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
    expect(scripts).toContain("npm test");
    expect(scripts).toContain("npx tsc --noEmit");
    expect(scripts).toContain("npm run build");
    expect(scripts).toContain(
      "npx vsce package --no-dependencies --out hermes-vscode.vsix",
    );
  });
});

describe("Dependabot contract", () => {
  it("checks npm and Actions weekly with bounded pull requests", async () => {
    const dependabot = await yamlFile(".github/dependabot.yml");
    expect(dependabot.version).toBe(2);
    expect(dependabot.updates).toEqual([
      {
        "package-ecosystem": "npm",
        directory: "/",
        schedule: { interval: "weekly" },
        "open-pull-requests-limit": 5,
      },
      {
        "package-ecosystem": "github-actions",
        directory: "/",
        schedule: { interval: "weekly" },
        "open-pull-requests-limit": 5,
      },
    ]);
  });
});
