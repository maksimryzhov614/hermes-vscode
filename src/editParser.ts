import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";

export interface ProposedEdit {
  path: string;
  mode: "replace" | "create" | "delete";
  content: string;
  range: { start: number; end: number };
}

const FENCE = /~~~hermes-edit\s+([^\n]*)\n([\s\S]*?)~~~/g;
const EDIT_MODES = new Set<ProposedEdit["mode"]>([
  "replace",
  "create",
  "delete",
]);

export function validateEditPath(editPath: string): string {
  if (editPath.includes("\0")) {
    throw new Error("Edit path contains a NUL byte");
  }

  const normalizedSeparators = editPath.replace(/\\/g, "/");
  if (normalizedSeparators.trim() === "") {
    throw new Error("Edit path is empty");
  }
  if (
    normalizedSeparators.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalizedSeparators) ||
    normalizedSeparators.startsWith("//")
  ) {
    throw new Error("Edit path must not be absolute");
  }
  if (/^[A-Za-z]:/u.test(normalizedSeparators)) {
    throw new Error("Edit path must not use a drive prefix");
  }

  const normalized = path.posix.normalize(normalizedSeparators);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("Edit path resolves outside workspace");
  }
  return normalized;
}

export function resolveWorkspaceEditPath(
  workspaceRoot: string,
  editPath: string,
): string {
  const normalizedEditPath = validateEditPath(editPath);
  const resolvedRoot = path.resolve(workspaceRoot);
  const target = path.resolve(resolvedRoot, normalizedEditPath);
  assertInsideWorkspace(resolvedRoot, target);

  const canonicalRoot = realpathSync(resolvedRoot);
  let existingAncestor = target;
  const missingSegments: string[] = [];
  while (true) {
    try {
      lstatSync(existingAncestor);
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error("Edit path resolves outside workspace");
      }
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync(existingAncestor);
  } catch {
    throw new Error("Edit path contains an unresolvable symlink");
  }
  const canonicalTarget = path.resolve(canonicalAncestor, ...missingSegments);
  assertInsideWorkspace(canonicalRoot, canonicalTarget);
  return canonicalTarget;
}

function assertInsideWorkspace(workspaceRoot: string, target: string): void {
  const relativeTarget = path.relative(workspaceRoot, target);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error("Edit path resolves outside workspace");
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function parseEdits(text: string): ProposedEdit[] {
  const edits: ProposedEdit[] = [];
  for (const match of text.matchAll(FENCE)) {
    const header = parseHeader((match[1] ?? "").trim());
    const mode = header.mode ?? "replace";
    if (!header.path || !EDIT_MODES.has(mode as ProposedEdit["mode"])) {
      continue;
    }

    let editPath: string;
    try {
      editPath = validateEditPath(header.path);
    } catch {
      continue;
    }

    const start = match.index ?? 0;
    edits.push({
      path: editPath,
      mode: mode as ProposedEdit["mode"],
      content: (match[2] ?? "").replace(/\n$/u, ""),
      range: { start, end: start + match[0].length },
    });
  }
  return edits;
}

function parseHeader(value: string): Record<string, string> {
  const header: Record<string, string> = {};
  for (const part of value.split(/\s+/u)) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex > 0) {
      header[part.slice(0, equalsIndex)] = part.slice(equalsIndex + 1);
    }
  }
  return header;
}
