import path from "node:path";
import {
  buildContextBundle,
  incrementalIndexRepo,
  indexRepo,
  indexStatus,
  searchReferences,
  searchIndex,
  defaultDbPath,
  watchIndexRepo,
} from "./indexer.js";
import { runGoldenEval } from "./eval.js";
import { explainRepoScan } from "./scanner.js";

export async function main(args) {
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "index") {
    const { repoPath, optionArgs } = parseRepoAndOptionArgs(args.slice(1));
    const options = parseOptions(optionArgs);
    const result = await indexRepo({
      repoPath,
      dbPath: options.db || defaultDbPath(repoPath),
      embeddingProvider: embeddingOptions(options),
      ...scanOptions(options),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "scan") {
    const { repoPath, optionArgs } = parseRepoAndOptionArgs(args.slice(1));
    const options = parseOptions(optionArgs);
    const result = await explainRepoScan(repoPath, scanOptions(options));
    console.log(JSON.stringify(options.explain ? result : compactScanResult(result), null, 2));
    return;
  }

  if (command === "watch") {
    const { repoPath, optionArgs } = parseRepoAndOptionArgs(args.slice(1));
    const options = parseOptions(optionArgs);
    const dbPath = options.db || defaultDbPath(repoPath);
    const debounceMs = positiveIntegerOption(options.debounceMs, 500, "--debounce-ms");

    if (options.once) {
      const result = await incrementalIndexRepo({
        repoPath,
        dbPath,
        embeddingProvider: embeddingOptions(options),
        ...scanOptions(options),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const watcher = await watchIndexRepo({
      repoPath,
      dbPath,
      debounceMs,
      embeddingProvider: embeddingOptions(options),
      ...scanOptions(options),
      onResult: ({ reason, result }) => {
        console.log(JSON.stringify({
          event: "indexed",
          at: new Date().toISOString(),
          reason,
          result,
        }));
      },
      onError: (error) => {
        console.error(error?.stack || String(error));
      },
    });
    console.error(`Watching ${watcher.root}; press Ctrl+C to stop.`);
    await waitForShutdown(watcher);
    return;
  }

  if (command === "search") {
    const query = args[1];
    if (!query) throw new Error("Missing search query.");
    const options = parseOptions(args.slice(2));
    const dbPath = options.db || defaultDbPath(process.cwd());
    const limit = Number(options.limit || 8);
    const result = await searchIndex({
      dbPath,
      query,
      limit,
      mode: searchModeOption(options),
      expandRelated: Boolean(options.expandRelated),
      embeddingProvider: embeddingOptions(options),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "bundle") {
    const query = args[1];
    if (!query) throw new Error("Missing bundle query.");
    const options = parseOptions(args.slice(2));
    const dbPath = options.db || defaultDbPath(process.cwd());
    const limit = Number(options.limit || 8);
    const maxChars = Number(options.maxChars || options["max-chars"] || 12000);
    const result = await buildContextBundle({
      dbPath,
      query,
      limit,
      maxChars,
      expandRelated: options.noExpandRelated ? false : true,
      embeddingProvider: embeddingOptions(options),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "references") {
    const symbol = args[1];
    if (!symbol) throw new Error("Missing symbol name.");
    const options = parseOptions(args.slice(2));
    const dbPath = options.db || defaultDbPath(process.cwd());
    const limit = Number(options.limit || 25);
    const result = searchReferences({ dbPath, symbol, limit, embeddingProvider: embeddingOptions(options) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "eval") {
    const { repoPath, optionArgs } = parseRepoAndOptionArgs(args.slice(1));
    const options = parseOptions(optionArgs);
    const result = await runGoldenEval({
      repoPath,
      dbPath: options.db,
      limit: Number(options.limit || 3),
      suite: options.suite || "sample",
      embeddingProvider: embeddingOptions(options),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    const options = parseOptions(args.slice(1));
    const dbPath = options.db || defaultDbPath(process.cwd());
    console.log(JSON.stringify(indexStatus({ dbPath, embeddingProvider: embeddingOptions(options) }), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--db") options.db = path.resolve(args[++index]);
    else if (arg === "--limit") options.limit = args[++index];
    else if (arg === "--max-chars") options.maxChars = args[++index];
    else if (arg === "--embedding-provider") options.embeddingProvider = args[++index];
    else if (arg === "--embedding-model") options.embeddingModel = args[++index];
    else if (arg === "--embedding-url") options.embeddingUrl = args[++index];
    else if (arg === "--embedding-dims") options.embeddingDims = args[++index];
    else if (arg === "--mode") options.mode = args[++index];
    else if (arg === "--suite") options.suite = args[++index];
    else if (arg === "--expand-related") options.expandRelated = true;
    else if (arg === "--no-expand-related") options.noExpandRelated = true;
    else if (arg === "--include") appendOption(options, "include", args[++index]);
    else if (arg === "--exclude") appendOption(options, "exclude", args[++index]);
    else if (arg === "--debounce-ms") options.debounceMs = args[++index];
    else if (arg === "--once") options.once = true;
    else if (arg === "--explain") options.explain = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function searchModeOption(options) {
  if (!options.mode) return "hybrid";
  if (!["lexical", "vector", "hybrid"].includes(options.mode)) {
    throw new Error("--mode must be lexical, vector, or hybrid.");
  }
  return options.mode;
}

function parseRepoAndOptionArgs(args) {
  if (!args[0] || args[0].startsWith("--")) {
    return { repoPath: process.cwd(), optionArgs: args };
  }
  return { repoPath: args[0], optionArgs: args.slice(1) };
}

function appendOption(options, key, value) {
  if (!value) throw new Error(`Missing value for --${key}`);
  if (!options[key]) options[key] = [];
  options[key].push(value);
}

function embeddingOptions(options) {
  if (!options.embeddingProvider && !options.embeddingDims && !options.embeddingModel && !options.embeddingUrl) {
    return undefined;
  }
  return {
    provider: options.embeddingProvider,
    model: options.embeddingModel,
    baseUrl: options.embeddingUrl,
    dims: options.embeddingDims ? Number(options.embeddingDims) : undefined,
  };
}

function scanOptions(options) {
  return {
    include: options.include || [],
    exclude: options.exclude || [],
  };
}

function positiveIntegerOption(value, defaultValue, name) {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

async function waitForShutdown(watcher) {
  await new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      watcher.close().then(resolve, resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function compactScanResult(result) {
  return {
    root: result.root,
    options: result.options,
    counts: result.counts,
    included: result.included.map((entry) => entry.path),
  };
}

function printHelp() {
  console.log(`context-engine

Usage:
  context-engine index [repo] [--db path] [--include glob] [--exclude glob]
  context-engine scan [repo] [--include glob] [--exclude glob] [--explain]
  context-engine watch [repo] [--db path] [--include glob] [--exclude glob] [--debounce-ms n] [--once]
  context-engine search "query" [--db path] [--limit n] [--mode lexical|vector|hybrid] [--expand-related]
  context-engine bundle "query" [--db path] [--limit n] [--max-chars n] [--no-expand-related]
  context-engine references "symbol" [--db path] [--limit n]
  context-engine eval [repo] [--db path] [--limit n] [--suite sample|self]
  context-engine status [--db path]

The default DB path is <repo>/.context-engine/index.sqlite.
Embedding options: --embedding-provider local-hash-v1 --embedding-dims 384.
Semantic adapters: --embedding-provider ollama --embedding-model nomic-embed-text --embedding-dims 768.
OpenAI-compatible adapters require --embedding-provider openai-compatible plus --embedding-url, --embedding-model, and --embedding-dims.
Ollama uses CONTEXT_ENGINE_OLLAMA_URL or OLLAMA_HOST, CONTEXT_ENGINE_OLLAMA_MODEL or OLLAMA_EMBEDDING_MODEL.
Scan filters are conservative: --include narrows eligible files and --exclude removes matches.
watch runs an initial incremental index, then debounces filesystem changes into repeat indexing passes.
--once runs the same incremental pass without staying resident.
bundle expands related context by default; search only does so with --expand-related.
`);
}
