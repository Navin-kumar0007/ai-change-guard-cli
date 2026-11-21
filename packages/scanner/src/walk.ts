import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { FileKind } from "./detect.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "out",
  "coverage",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  ".turbo",
  ".cache",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);

const CODE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".java",
  ".kt",
  ".go",
  ".rb",
  ".php",
  ".cs",
  ".rs",
  ".swift",
  ".dart",
]);

const CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".toml", ".ini", ".properties", ".cfg"]);

export function fileKind(name: string): FileKind | null {
  const base = basename(name);
  if (base === ".env" || base.startsWith(".env.")) return "config";
  if (base.endsWith(".min.js")) return null;
  const ext = extname(base).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  return null;
}

export interface WalkedFile {
  path: string;
  rel: string;
  kind: FileKind;
}

export async function* walk(root: string): AsyncGenerator<WalkedFile> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
      const kind = fileKind(entry.name);
      if (kind) yield { path: full, rel: relative(root, full).split(sep).join("/"), kind };
    }
  }
}
