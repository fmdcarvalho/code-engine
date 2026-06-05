import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".parcel-cache",
  ".svelte-kit",
  ".nuxt",
  ".venv",
  "__pycache__",
  "vendor",
  ".openclaw",
  ".context-engine",
]);

const DEFAULT_IGNORE_FILES = new Set([
  ".DS_Store",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export async function scanRepo(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const state = createScanState(options, { diagnostics: false });
  await walk(absoluteRoot, absoluteRoot, [], state);
  return state.files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function explainRepoScan(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const state = createScanState(options, { diagnostics: true });
  await walk(absoluteRoot, absoluteRoot, [], state);
  state.files.sort((a, b) => a.path.localeCompare(b.path));

  const included = state.included.sort((a, b) => a.path.localeCompare(b.path));
  const excluded = state.excluded.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: absoluteRoot,
    options: {
      include: state.options.includePatterns,
      exclude: state.options.excludePatterns,
    },
    counts: {
      includedFiles: included.length,
      excludedFiles: excluded.filter((entry) => entry.type === "file").length,
      excludedDirectories: excluded.filter((entry) => entry.type === "directory").length,
      activeRules: state.rules.length,
    },
    rules: state.rules,
    included,
    excluded,
  };
}

export async function readCodeFile(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`) && absolutePath !== absoluteRoot) {
    throw new Error(`Path escapes repo root: ${relativePath}`);
  }
  const buffer = await fs.readFile(absolutePath);
  if (looksBinary(buffer)) {
    throw new Error(`Refusing binary file: ${relativePath}`);
  }
  return buffer.toString("utf8");
}

export function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function walk(root, current, ignoreRules, state) {
  const localRules = await loadGitIgnore(root, current);
  recordRules(state, localRules);
  const rules = ignoreRules.concat(localRules);
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      const decision = directoryDecision(entry.name, relativePath, rules, state.options);
      if (decision.excluded) {
        recordExcluded(state, relativePath, "directory", decision);
        continue;
      }
      await walk(root, absolutePath, rules, state);
      continue;
    }

    if (!entry.isFile()) continue;
    const decision = fileDecision(entry.name, relativePath, rules, state.options);
    if (decision.excluded) {
      recordExcluded(state, relativePath, "file", decision);
      continue;
    }

    const stat = await fs.stat(absolutePath);
    if (stat.size > 1024 * 1024) {
      recordExcluded(state, relativePath, "file", { reason: "too-large", details: "File is larger than 1 MiB." });
      continue;
    }
    const buffer = await fs.readFile(absolutePath);
    if (looksBinary(buffer)) {
      recordExcluded(state, relativePath, "file", { reason: "binary", details: "File appears to be binary." });
      continue;
    }
    const file = {
      path: relativePath,
      absolutePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      text: buffer.toString("utf8"),
    };
    state.files.push(file);
    recordIncluded(state, file, decision);
  }
}

async function loadGitIgnore(root, current) {
  try {
    const content = await fs.readFile(path.join(current, ".gitignore"), "utf8");
    const basePath = path.relative(root, current).split(path.sep).join("/");
    const normalizedBase = basePath === "." ? "" : basePath;
    const sourcePath = normalizedBase ? `${normalizedBase}/.gitignore` : ".gitignore";
    return parseGitIgnore(content, normalizedBase, sourcePath);
  } catch {
    return [];
  }
}

function createScanState(options, { diagnostics }) {
  const normalizedOptions = normalizeScanOptions(options);
  return {
    diagnostics,
    options: normalizedOptions,
    files: [],
    included: [],
    excluded: [],
    rules: defaultRuleDescriptions().concat(
      normalizedOptions.includeRules.map(ruleDescription),
      normalizedOptions.excludeRules.map(ruleDescription),
    ),
    recordedRuleIds: new Set(),
  };
}

function normalizeScanOptions(options) {
  const includePatterns = normalizePatternList(options.include);
  const excludePatterns = normalizePatternList(options.exclude);
  return {
    includePatterns,
    excludePatterns,
    includeRules: parseOverridePatterns(includePatterns, "include"),
    excludeRules: parseOverridePatterns(excludePatterns, "exclude"),
  };
}

function normalizePatternList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function parseOverridePatterns(patterns, action) {
  return patterns.map((pattern, index) => {
    const rule = parseGitIgnoreLine(pattern, "", {
      id: `cli:${action}:${index + 1}`,
      source: "cli",
      sourcePath: `--${action}`,
      line: index + 1,
      action,
    });
    if (!rule) throw new Error(`Invalid --${action} pattern: ${pattern}`);
    if (rule.negated) throw new Error(`Negated --${action} patterns are not supported: ${pattern}`);
    return rule;
  });
}

function defaultRuleDescriptions() {
  const dirs = [...DEFAULT_IGNORE_DIRS].sort().map((name) => ({
    id: `default:dir:${name}`,
    source: "default",
    action: "exclude",
    pattern: `${name}/`,
    type: "directory",
  }));
  const files = [...DEFAULT_IGNORE_FILES].sort().map((name) => ({
    id: `default:file:${name}`,
    source: "default",
    action: "exclude",
    pattern: name,
    type: "file",
  }));
  files.push({
    id: "default:file:.env*",
    source: "default",
    action: "exclude",
    pattern: ".env*",
    type: "file",
  });
  return dirs.concat(files);
}

function directoryDecision(name, relativePath, gitIgnoreRules, options) {
  if (DEFAULT_IGNORE_DIRS.has(name)) {
    return {
      excluded: true,
      reason: "default-ignore-dir",
      matchedRules: [defaultDirectoryRule(name)],
    };
  }

  const gitIgnore = evaluateGitIgnore(relativePath, gitIgnoreRules, true);
  if (gitIgnore.ignored) {
    return { excluded: true, reason: "gitignore", matchedRules: gitIgnore.matches };
  }

  const cliExclude = evaluateOverride(relativePath, options.excludeRules, true);
  if (cliExclude.matched) {
    return { excluded: true, reason: "cli-exclude", matchedRules: cliExclude.matches };
  }

  return { excluded: false };
}

function fileDecision(name, relativePath, gitIgnoreRules, options) {
  if (DEFAULT_IGNORE_FILES.has(name)) {
    return {
      excluded: true,
      reason: "default-ignore-file",
      matchedRules: [defaultFileRule(name)],
    };
  }

  if (isEnvFile(name)) {
    return {
      excluded: true,
      reason: "default-env-file",
      matchedRules: [defaultFileRule(".env*")],
    };
  }

  const gitIgnore = evaluateGitIgnore(relativePath, gitIgnoreRules, false);
  if (gitIgnore.ignored) {
    return { excluded: true, reason: "gitignore", matchedRules: gitIgnore.matches };
  }

  const cliExclude = evaluateOverride(relativePath, options.excludeRules, false);
  if (cliExclude.matched) {
    return { excluded: true, reason: "cli-exclude", matchedRules: cliExclude.matches };
  }

  const cliInclude = evaluateOverride(relativePath, options.includeRules, false);
  if (options.includeRules.length > 0 && !cliInclude.matched) {
    return { excluded: true, reason: "cli-include-filter" };
  }

  const matchedRules = gitIgnore.matches.concat(cliInclude.matches);
  return {
    excluded: false,
    reason: cliInclude.matched
      ? "included-by-include"
      : gitIgnore.matches.length
        ? "included-by-gitignore-negation"
        : "included",
    matchedRules,
  };
}

function evaluateGitIgnore(relativePath, rules, isDirectory) {
  let ignoredByRule = false;
  const matches = [];
  for (const rule of rules) {
    if (matchesRule(relativePath, rule, isDirectory)) {
      ignoredByRule = !rule.negated;
      matches.push(ruleDescription(rule));
    }
  }
  return { ignored: ignoredByRule, matches };
}

function evaluateOverride(relativePath, rules, isDirectory) {
  const matches = rules
    .filter((rule) => matchesRule(relativePath, rule, isDirectory))
    .map(ruleDescription);
  return { matched: matches.length > 0, matches };
}

function recordRules(state, rules) {
  if (!state.diagnostics) return;
  for (const rule of rules) {
    if (state.recordedRuleIds.has(rule.id)) continue;
    state.recordedRuleIds.add(rule.id);
    state.rules.push(ruleDescription(rule));
  }
}

function recordIncluded(state, file, decision) {
  if (!state.diagnostics) return;
  state.included.push({
    path: file.path,
    type: "file",
    size: file.size,
    reason: decision.reason || "included",
    matchedRules: decision.matchedRules || [],
  });
}

function recordExcluded(state, relativePath, type, decision) {
  if (!state.diagnostics) return;
  state.excluded.push({
    path: relativePath,
    type,
    reason: decision.reason,
    details: decision.details,
    matchedRules: decision.matchedRules || [],
  });
}

function parseGitIgnore(content, basePath, sourcePath) {
  return content
    .split(/\r?\n/)
    .map((line, index) => parseGitIgnoreLine(line, basePath, {
      id: `gitignore:${sourcePath}:${index + 1}`,
      source: "gitignore",
      sourcePath,
      line: index + 1,
    }))
    .filter(Boolean);
}

function parseGitIgnoreLine(rawLine, basePath, metadata = {}) {
  let line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;
  line = line.replace(/^\\([#!])/, "$1");
  const rawPattern = line;

  const negated = line.startsWith("!");
  if (negated) line = line.slice(1).trim();
  if (!line) return null;

  const directoryOnly = line.endsWith("/");
  const anchored = line.startsWith("/");
  const pattern = normalizeSlash(line).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!pattern) return null;

  return {
    id: metadata.id,
    source: metadata.source,
    sourcePath: metadata.sourcePath,
    line: metadata.line,
    action: metadata.action || (negated ? "include" : "exclude"),
    basePath,
    pattern,
    rawPattern,
    negated,
    directoryOnly,
    anchored,
    hasSlash: pattern.includes("/"),
  };
}

function matchesRule(relativePath, rule, isDirectory) {
  const pathFromBase = relativeToRuleBase(relativePath, rule.basePath);
  if (pathFromBase === null) return false;

  if (rule.directoryOnly && matchesDirectoryRule(pathFromBase, rule)) return true;
  if (rule.directoryOnly && !isDirectory) return false;

  if (!rule.hasSlash && !rule.anchored) {
    return pathFromBase.split("/").some((part) => globMatches(rule.pattern, part));
  }

  return globMatches(rule.pattern, pathFromBase);
}

function ruleDescription(rule) {
  return {
    id: rule.id,
    source: rule.source,
    sourcePath: rule.sourcePath,
    line: rule.line,
    action: rule.action,
    basePath: rule.basePath,
    pattern: rule.rawPattern || rule.pattern,
    negated: rule.negated,
    directoryOnly: rule.directoryOnly,
    anchored: rule.anchored,
  };
}

function defaultDirectoryRule(name) {
  return {
    id: `default:dir:${name}`,
    source: "default",
    action: "exclude",
    pattern: `${name}/`,
    type: "directory",
  };
}

function defaultFileRule(name) {
  return {
    id: `default:file:${name}`,
    source: "default",
    action: "exclude",
    pattern: name,
    type: "file",
  };
}

function matchesDirectoryRule(pathFromBase, rule) {
  if (!rule.hasSlash && !rule.anchored) {
    return pathFromBase.split("/").some((part) => globMatches(rule.pattern, part));
  }
  return pathFromBase === rule.pattern || pathFromBase.startsWith(`${rule.pattern}/`);
}

function relativeToRuleBase(relativePath, basePath) {
  if (!basePath) return relativePath;
  if (relativePath === basePath) return "";
  if (!relativePath.startsWith(`${basePath}/`)) return null;
  return relativePath.slice(basePath.length + 1);
}

function globMatches(pattern, value) {
  return new RegExp(`^${globToRegex(pattern)}$`).test(value);
}

function globToRegex(pattern) {
  let regex = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(char);
    }
  }
  return regex;
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

function isEnvFile(name) {
  return name.startsWith(".env");
}

function normalizeSlash(value) {
  return value.split(path.sep).join("/");
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
