import fs from "node:fs";
import path from "node:path";
import { chunkFile, languageForPath } from "./chunker.js";
import { ContextStore } from "./store.js";
import { hashText, scanRepo } from "./scanner.js";
import { buildSymbolIndex } from "./symbols.js";

export async function indexRepo({ repoPath, dbPath, embeddingProvider, include, exclude }) {
  return incrementalIndexRepo({ repoPath, dbPath, embeddingProvider, include, exclude });
}

export async function incrementalIndexRepo({ repoPath, dbPath, embeddingProvider, include, exclude }) {
  const root = path.resolve(repoPath);
  const store = new ContextStore(dbPath || defaultDbPath(root), { embeddingProvider });
  try {
    store.assertEmbeddingCompatible();
    const files = await scanRepo(root, { include, exclude });
    const symbolIndexCurrent = store.isSymbolIndexCurrent();
    let indexed = 0;
    let skipped = 0;
    let chunks = 0;

    for (const file of files) {
      const hash = hashText(file.text);
      const language = languageForPath(file.path);
      const existing = store.getFile(file.path);
      if (existing?.hash === hash && symbolIndexCurrent) {
        skipped += 1;
        continue;
      }

      const fileChunks = chunkFile({ filePath: file.path, text: file.text });
      const symbolIndex = buildSymbolIndex({ filePath: file.path, text: file.text, chunks: fileChunks });
      await store.upsertFileWithChunks({
        path: file.path,
        hash,
        size: file.size,
        mtimeMs: file.mtimeMs,
        language,
      }, fileChunks, symbolIndex);
      indexed += 1;
      chunks += fileChunks.length;
    }

    const removed = store.removeMissingFiles(files.map((file) => file.path));
    store.setSymbolIndexCurrent();
    const status = store.status();
    return { root, indexed, skipped, removed, chunks, status };
  } finally {
    store.close();
  }
}

export async function watchIndexRepo({
  repoPath,
  dbPath,
  embeddingProvider,
  include,
  exclude,
  debounceMs = 500,
  onResult = () => {},
  onError = (error) => { throw error; },
}) {
  const root = path.resolve(repoPath);
  const resolvedDbPath = dbPath || defaultDbPath(root);
  let closed = false;
  let running = false;
  let pendingReason = null;
  let timer = null;
  let currentRun = Promise.resolve(null);

  const run = async (reason) => {
    if (closed) return null;
    if (running) {
      pendingReason = reason;
      return currentRun;
    }

    running = true;
    try {
      let result = null;
      let currentReason = reason;
      do {
        pendingReason = null;
        result = await incrementalIndexRepo({
          repoPath: root,
          dbPath: resolvedDbPath,
          embeddingProvider,
          include,
          exclude,
        });
        await onResult({ reason: currentReason, result });
        currentReason = pendingReason;
      } while (currentReason && !closed);
      return result;
    } catch (error) {
      if (reason === "initial") throw error;
      await onError(error);
      return null;
    } finally {
      running = false;
    }
  };

  const schedule = (reason) => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      currentRun = run(reason);
    }, debounceMs);
  };

  const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
    if (shouldIgnoreWatchEvent(filename, { root, dbPath: resolvedDbPath })) return;
    schedule(`${eventType}:${normalizeWatchPath(filename) || "."}`);
  });

  try {
    currentRun = run("initial");
    await currentRun;
  } catch (error) {
    watcher.close();
    throw error;
  }

  return {
    root,
    dbPath: resolvedDbPath,
    trigger: (reason = "manual") => schedule(reason),
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
      await currentRun;
    },
  };
}

export function shouldIgnoreWatchEvent(filename, { root, dbPath } = {}) {
  const relativePath = normalizeWatchPath(filename);
  if (!relativePath) return false;

  const dbRelativePath = root && dbPath
    ? path.relative(path.resolve(root), path.resolve(dbPath)).split(path.sep).join("/")
    : null;
  if (
    dbRelativePath &&
    !dbRelativePath.startsWith("..") &&
    (relativePath === dbRelativePath || relativePath.startsWith(`${dbRelativePath}-`))
  ) {
    return true;
  }

  const parts = relativePath.split("/");
  return parts.some((part) => WATCH_IGNORED_DIRS.has(part));
}

export async function searchIndex({ dbPath, query, limit, embeddingProvider, mode = "hybrid", expandRelated = false }) {
  const store = new ContextStore(dbPath, { embeddingProvider });
  try {
    const results = await store.search(query, { limit, mode, expandRelated });
    const status = store.status();
    return { query, mode, expandRelated, status, results };
  } finally {
    store.close();
  }
}

export async function buildContextBundle({ dbPath, query, limit = 8, maxChars = 12000, embeddingProvider, expandRelated = true }) {
  const search = await searchIndex({ dbPath, query, limit, embeddingProvider, expandRelated });
  let remaining = maxChars;
  const items = [];

  for (const result of search.results) {
    const header = `File: ${result.path}:${result.startLine}-${result.endLine}${result.symbol ? ` (${result.symbol})` : ""}\nWhy: ${result.why}; score=${result.score}\n`;
    const bodyBudget = remaining - header.length - 24;
    if (bodyBudget <= 0) break;
    const snippet = result.snippet.length > bodyBudget
      ? `${result.snippet.slice(0, Math.max(0, bodyBudget - 15))}\n...[truncated]`
      : result.snippet;
    const packed = `${header}${snippet}`;
    remaining -= packed.length + 2;
    items.push({
      path: result.path,
      startLine: result.startLine,
      endLine: result.endLine,
      symbol: result.symbol,
      score: result.score,
      why: result.why,
      text: packed,
    });
  }

  return {
    query,
    expandRelated,
    maxChars,
    usedChars: items.reduce((sum, item) => sum + item.text.length, 0),
    itemCount: items.length,
    context: items.map((item) => item.text).join("\n\n---\n\n"),
    items,
  };
}

export function searchReferences({ dbPath, symbol, limit = 25, embeddingProvider }) {
  const store = new ContextStore(dbPath, { embeddingProvider });
  try {
    return {
      symbol,
      status: store.status(),
      definitions: store.symbolDefinitions(symbol, { limit }),
      references: store.referenceSearch(symbol, { limit }),
    };
  } finally {
    store.close();
  }
}

export function indexStatus({ dbPath, embeddingProvider }) {
  const store = new ContextStore(dbPath, { embeddingProvider });
  const status = store.status();
  store.close();
  return status;
}

export function defaultDbPath(repoPath) {
  return path.join(path.resolve(repoPath), ".context-engine", "index.sqlite");
}

const WATCH_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".context-engine",
  "node_modules",
]);

function normalizeWatchPath(filename) {
  if (!filename) return "";
  return String(filename).split(path.sep).join("/");
}
