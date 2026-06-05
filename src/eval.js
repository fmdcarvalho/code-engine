import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { indexRepo, searchIndex } from "./indexer.js";

export const GOLDEN_QUERIES = [
  {
    id: "auth-flow",
    query: "where is auth handled",
    expectedFiles: ["src/auth.js"],
    expectedSymbols: ["function:authenticateUser", "function:verifyJwtToken"],
  },
  {
    id: "task-persistence",
    query: "task persistence save load",
    expectedFiles: ["src/tasks.js"],
    expectedSymbols: ["function:saveTask", "function:loadTask"],
  },
  {
    id: "payment-settlement",
    query: "settle invoice lifecycle",
    expectedFiles: ["src/payments.js"],
    expectedSymbols: ["method:PaymentWorkflow.settleInvoice"],
  },
  {
    id: "payment-capture-handler",
    query: "capture handler object",
    expectedFiles: ["src/payments.js"],
    expectedSymbols: ["method:paymentHandlers.capture"],
  },
];

export const SELF_REPO_GOLDEN_QUERIES = [
  {
    id: "index-watch-flow",
    query: "incremental index watch debounce unchanged files removed missing files",
    expectedFiles: ["src/indexer.js"],
    expectedSymbols: ["function:incrementalIndexRepo"],
  },
  {
    id: "embedding-metadata-mismatch",
    query: "embedding provider mismatch metadata reindex fresh DB compatible vectors",
    expectedFiles: ["src/store.js"],
    expectedSymbols: ["method:ContextStore.assertEmbeddingCompatible"],
  },
  {
    id: "symbol-graph-extraction",
    query: "parser backed symbol graph definitions imports exports references Babel JavaScript",
    expectedFiles: ["src/symbols.js"],
    expectedSymbols: ["function:buildSymbolIndex"],
  },
  {
    id: "related-expansion",
    query: "expand related chunks same file import target symbol reference nearby test",
    expectedFiles: ["src/store.js"],
    expectedSymbols: ["method:ContextStore.expandRelatedResults"],
  },
  {
    id: "ollama-adapter",
    query: "Ollama embedding adapter model dims base URL api embed response validation",
    expectedFiles: ["src/embedding.js"],
    expectedSymbols: ["function:createOllamaEmbeddingProvider"],
  },
  {
    id: "mcp-tool-exposure",
    query: "MCP registerTool reference_search context_bundle index_repo zod inputSchema",
    expectedFiles: ["src/mcp.js"],
    expectedSymbols: ["function:runMcpServer"],
  },
  {
    id: "scan-diagnostics",
    query: "scan diagnostics gitignore include exclude active rules included excluded reasons",
    expectedFiles: ["src/scanner.js"],
    expectedSymbols: ["function:explainRepoScan"],
  },
  {
    id: "golden-eval-baselines",
    query: "golden eval baselines lexical vector hybrid enhanced Recall MRR aggregate metrics",
    expectedFiles: ["src/eval.js"],
    expectedSymbols: ["function:runGoldenEval"],
  },
];

export const GOLDEN_SUITES = {
  sample: GOLDEN_QUERIES,
  self: SELF_REPO_GOLDEN_QUERIES,
};

const BASELINES = [
  { name: "lexical-only", mode: "lexical", expandRelated: false },
  { name: "vector-only", mode: "vector", expandRelated: false },
  { name: "hybrid", mode: "hybrid", expandRelated: false },
  { name: "enhanced-hybrid", mode: "hybrid", expandRelated: true },
];

export async function runGoldenEval({ repoPath, dbPath, limit = 3, embeddingProvider, suite = "sample", queries } = {}) {
  const root = path.resolve(repoPath || defaultFixturePath());
  const tempDir = dbPath ? null : await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-eval-"));
  const resolvedDbPath = dbPath || path.join(tempDir, "golden.sqlite");
  const goldenQueries = queries || goldenQueriesForSuite(suite);
  const indexStarted = performance.now();
  const indexed = await indexRepo({ repoPath: root, dbPath: resolvedDbPath, embeddingProvider });
  const indexLatencyMs = elapsedMs(indexStarted);
  const baselines = [];

  for (const baseline of BASELINES) {
    const baselineStarted = performance.now();
    const cases = [];
    for (const golden of goldenQueries) {
      const caseStarted = performance.now();
      const result = await searchIndex({
        dbPath: resolvedDbPath,
        query: golden.query,
        limit,
        mode: baseline.mode,
        expandRelated: baseline.expandRelated,
        embeddingProvider,
      });
      cases.push(evaluateCase(golden, result.results, limit, elapsedMs(caseStarted)));
    }
    baselines.push({
      name: baseline.name,
      mode: baseline.mode,
      expandRelated: baseline.expandRelated,
      metrics: aggregateMetrics(cases),
      latencyMs: elapsedMs(baselineStarted),
      cases,
    });
  }

  return {
    repoPath: root,
    dbPath: resolvedDbPath,
    suite,
    queryCount: goldenQueries.length,
    limit,
    indexLatencyMs,
    indexed: indexed.status,
    baselines,
  };
}

function evaluateCase(golden, results, limit, latencyMs) {
  const top = results.slice(0, Math.max(limit, results.length));
  const files = top.map((result) => result.path);
  const symbols = top.map((result) => result.symbol).filter(Boolean);
  const firstFileRank = firstRank(files, golden.expectedFiles);
  const firstSymbolRank = firstRank(symbols, golden.expectedSymbols);
  return {
    id: golden.id,
    query: golden.query,
    expectedFiles: golden.expectedFiles,
    expectedSymbols: golden.expectedSymbols,
    topFiles: files.slice(0, limit),
    topSymbols: symbols.slice(0, limit),
    fileRecallAtK: recall(files.slice(0, limit), golden.expectedFiles),
    symbolRecallAtK: recall(symbols.slice(0, limit), golden.expectedSymbols),
    fileMrr: firstFileRank ? 1 / firstFileRank : 0,
    symbolMrr: firstSymbolRank ? 1 / firstSymbolRank : 0,
    latencyMs,
  };
}

function aggregateMetrics(cases) {
  return {
    fileRecallAtK: average(cases.map((item) => item.fileRecallAtK)),
    symbolRecallAtK: average(cases.map((item) => item.symbolRecallAtK)),
    fileMrr: average(cases.map((item) => item.fileMrr)),
    symbolMrr: average(cases.map((item) => item.symbolMrr)),
  };
}

function recall(actual, expected) {
  if (!expected.length) return 1;
  const actualSet = new Set(actual);
  const hits = expected.filter((item) => actualSet.has(item)).length;
  return Number((hits / expected.length).toFixed(4));
}

function firstRank(actual, expected) {
  const expectedSet = new Set(expected);
  const index = actual.findIndex((item) => expectedSet.has(item));
  return index >= 0 ? index + 1 : 0;
}

function average(values) {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function goldenQueriesForSuite(suite) {
  const selected = GOLDEN_SUITES[suite];
  if (!selected) {
    throw new Error(`Unknown eval suite: ${suite}. Available suites: ${Object.keys(GOLDEN_SUITES).join(", ")}.`);
  }
  return selected;
}

function elapsedMs(started) {
  return Number((performance.now() - started).toFixed(2));
}

function defaultFixturePath() {
  return path.resolve(new URL("../tests/fixtures/sample-repo", import.meta.url).pathname);
}
