import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseEdits, resolveWorkspaceEditPath } from "../src/editParser";

describe("parseEdits", () => {
  it("parses valid create, replace, delete, default, and multiple blocks", () => {
    expect(
      parseEdits(
        [
          "~~~hermes-edit path=src/a.ts mode=create",
          "export {};",
          "~~~",
          "~~~hermes-edit path=src/b.ts",
          "const value = 1;",
          "~~~",
          "~~~hermes-edit path=src/c.ts mode=delete",
          "~~~",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        mode: "create",
        content: "export {};",
      }),
      expect.objectContaining({
        path: "src/b.ts",
        mode: "replace",
        content: "const value = 1;",
      }),
      expect.objectContaining({
        path: "src/c.ts",
        mode: "delete",
        content: "",
      }),
    ]);
  });

  it.each([
    ["missing path", "mode=replace"],
    ["unsupported mode", "path=src/a.ts mode=patch"],
    ["empty path", "path= mode=replace"],
    ["POSIX absolute path", "path=/tmp/x mode=replace"],
    ["Windows drive path", "path=C:\\secret mode=replace"],
    ["Windows drive-relative path", "path=C:secret mode=replace"],
    ["UNC path", "path=\\\\server\\share mode=replace"],
    ["parent traversal", "path=../secret mode=replace"],
    ["backslash traversal", "path=..\\secret mode=replace"],
    ["NUL byte", "path=safe\0name mode=replace"],
  ])("rejects %s", (_label, header) => {
    expect(parseEdits(`~~~hermes-edit ${header}\nx\n~~~`)).toEqual([]);
  });
});

describe("resolveWorkspaceEditPath", () => {
  const workspaceRoot = resolve(".");

  it("resolves a nested relative path inside the workspace", () => {
    expect(resolveWorkspaceEditPath(workspaceRoot, "src/a.ts")).toBe(
      join(workspaceRoot, "src/a.ts"),
    );
  });

  it.each([
    ["parent traversal", "../secret", /outside workspace/u],
    ["backslash traversal", "..\\secret", /outside workspace/u],
    ["sibling prefix escape", "../workspace-evil/file", /outside workspace/u],
    ["POSIX absolute path", "/tmp/x", /absolute/u],
    ["Windows drive path", "C:\\secret", /absolute/u],
    ["Windows drive-relative path", "C:secret", /drive/u],
    ["UNC path", "\\\\server\\share", /absolute/u],
    ["empty path", "", /empty/u],
    ["NUL byte", "safe\0name", /NUL/u],
  ])("rejects %s at the application boundary", (_label, editPath, error) => {
    expect(() => resolveWorkspaceEditPath(workspaceRoot, editPath)).toThrow(
      error,
    );
  });

  it("rejects a path whose workspace segment is a symlink outside", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "hermes-edit-path-"));
    const workspace = join(temporaryRoot, "workspace");
    const outside = join(temporaryRoot, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await symlink(outside, join(workspace, "linked-outside"), "dir");

    try {
      expect(() =>
        resolveWorkspaceEditPath(workspace, "linked-outside/file.ts"),
      ).toThrow(/outside workspace/u);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
