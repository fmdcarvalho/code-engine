import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildContextBundle,
  incrementalIndexRepo,
  indexRepo,
  searchReferences,
  searchIndex,
  shouldIgnoreWatchEvent,
} from "../src/indexer.js";
import { SELF_REPO_GOLDEN_QUERIES, runGoldenEval } from "../src/eval.js";
import { explainRepoScan, scanRepo } from "../src/scanner.js";
import { chunkFile } from "../src/chunker.js";
import { createEmbeddingProvider } from "../src/embedding.js";
import { ContextStore } from "../src/store.js";
import { buildSymbolIndex } from "../src/symbols.js";

const execFileAsync = promisify(execFile);

test("chunkFile returns stable line metadata and symbols", () => {
  const chunks = chunkFile({
    filePath: "src/auth.js",
    text: "export function authenticateUser(request) {\n  return request;\n}\n",
    maxLines: 80,
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].filePath, "src/auth.js");
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 3);
  assert.equal(chunks[0].symbol, "function:authenticateUser");
});

test("chunkFile keeps separate JavaScript symbols in separate chunks", () => {
  const chunks = chunkFile({
    filePath: "src/auth.js",
    text: [
      "const authHeader = \"Authorization\";",
      "",
      "export function authenticateUser(request) {",
      "  return verifyJwtToken(request.headers[authHeader]);",
      "}",
      "",
      "export function verifyJwtToken(token) {",
      "  return token.startsWith(\"Bearer \");",
      "}",
      "",
    ].join("\n"),
    maxLines: 80,
  });

  const authChunk = chunks.find((chunk) => chunk.symbol === "function:authenticateUser");
  const verifyChunk = chunks.find((chunk) => chunk.symbol === "function:verifyJwtToken");

  assert.ok(authChunk);
  assert.ok(verifyChunk);
  assert.equal(authChunk.startLine, 3);
  assert.equal(authChunk.endLine, 5);
  assert.equal(verifyChunk.startLine, 7);
  assert.equal(verifyChunk.endLine, 9);
  assert.match(authChunk.text, /authenticateUser/);
  assert.doesNotMatch(authChunk.text, /export function verifyJwtToken/);
});

test("chunkFile keeps separate Python symbols in separate chunks", () => {
  const chunks = chunkFile({
    filePath: "src/auth.py",
    text: [
      "@dataclass",
      "class TokenStore:",
      "    def save(self, token):",
      "        return token",
      "",
      "async def load_user(user_id):",
      "    return {\"id\": user_id}",
      "",
    ].join("\n"),
    maxLines: 80,
  });

  const classChunk = chunks.find((chunk) => chunk.symbol === "class:TokenStore");
  const functionChunk = chunks.find((chunk) => chunk.symbol === "function:load_user");

  assert.ok(classChunk);
  assert.ok(functionChunk);
  assert.equal(classChunk.startLine, 1);
  assert.equal(classChunk.endLine, 4);
  assert.equal(functionChunk.startLine, 6);
  assert.equal(functionChunk.endLine, 7);
  assert.doesNotMatch(classChunk.text, /async def load_user/);
});

test("chunkFile adds parser-backed TypeScript nested and exported symbols", () => {
  const chunks = chunkFile({
    filePath: "src/users.ts",
    text: [
      "type User = { id: string };",
      "",
      "export class UserService {",
      "  constructor(private readonly repo: Repo) {}",
      "",
      "  async load<T extends User>(id: string): Promise<T> {",
      "    const normalize = (value: T) => {",
      "      return value;",
      "    };",
      "    return normalize(await this.repo.find<T>(id));",
      "  }",
      "",
      "  save = async (user: User) => {",
      "    return this.repo.save(user);",
      "  };",
      "}",
      "",
      "export const buildUser = async <T extends User>(",
      "  input: T,",
      "): Promise<T> => {",
      "  return input;",
      "};",
      "",
      "export const handlers = {",
      "  async create(req: Request) {",
      "    return buildUser(req.body);",
      "  },",
      "  remove: (id: string) => {",
      "    return id;",
      "  },",
      "};",
      "",
    ].join("\n"),
    maxLines: 80,
  });

  const classChunk = chunks.find((chunk) => chunk.symbol === "class:UserService");
  const loadChunk = chunks.find((chunk) => chunk.symbol === "method:UserService.load");
  const saveChunk = chunks.find((chunk) => chunk.symbol === "method:UserService.save");
  const nestedArrowChunk = chunks.find((chunk) => chunk.symbol === "function:UserService.load.normalize");
  const buildChunk = chunks.find((chunk) => chunk.symbol === "function:buildUser");
  const handlersChunk = chunks.find((chunk) => chunk.symbol === "export:handlers");
  const createChunk = chunks.find((chunk) => chunk.symbol === "method:handlers.create");
  const removeChunk = chunks.find((chunk) => chunk.symbol === "method:handlers.remove");

  assert.ok(classChunk);
  assert.ok(loadChunk);
  assert.ok(saveChunk);
  assert.ok(nestedArrowChunk);
  assert.ok(buildChunk);
  assert.ok(handlersChunk);
  assert.ok(createChunk);
  assert.ok(removeChunk);
  assert.equal(classChunk.startLine, 3);
  assert.equal(classChunk.endLine, 16);
  assert.equal(loadChunk.startLine, 6);
  assert.equal(loadChunk.endLine, 11);
  assert.equal(saveChunk.startLine, 13);
  assert.equal(saveChunk.endLine, 15);
  assert.equal(nestedArrowChunk.startLine, 7);
  assert.equal(nestedArrowChunk.endLine, 9);
  assert.equal(buildChunk.startLine, 18);
  assert.equal(buildChunk.endLine, 22);
  assert.equal(handlersChunk.startLine, 24);
  assert.equal(handlersChunk.endLine, 31);
  assert.equal(createChunk.startLine, 25);
  assert.equal(createChunk.endLine, 27);
  assert.equal(removeChunk.startLine, 28);
  assert.equal(removeChunk.endLine, 30);
  assert.doesNotMatch(loadChunk.text, /export const buildUser/);
});

test("JavaScript parser backend can use tree-sitter and selectable Babel fallback", () => {
  const previousParser = process.env.CONTEXT_ENGINE_JS_PARSER;
  const text = [
    "export class ApiClient {",
    "  request = async (url: string) => {",
    "    const normalize = (value: string) => value.trim();",
    "    return normalize(url);",
    "  };",
    "}",
    "",
    "export const routes = {",
    "  health() {",
    "    return \"ok\";",
    "  },",
    "};",
  ].join("\n");

  try {
    process.env.CONTEXT_ENGINE_JS_PARSER = "tree-sitter";
    const treeSitterChunks = chunkFile({ filePath: "src/api.ts", text, maxLines: 80 });
    const treeSitterSymbols = buildSymbolIndex({ filePath: "src/api.ts", text, chunks: treeSitterChunks });

    assert.ok(treeSitterChunks.some((chunk) => chunk.symbol === "method:ApiClient.request"));
    assert.ok(treeSitterChunks.some((chunk) => chunk.symbol === "function:ApiClient.request.normalize"));
    assert.ok(treeSitterChunks.some((chunk) => chunk.symbol === "method:routes.health"));
    assert.ok(treeSitterSymbols.definitions.some((entry) => entry.kind === "method" && entry.name === "ApiClient.request"));
    assert.ok(treeSitterSymbols.exports.some((entry) => entry.name === "ApiClient"));

    process.env.CONTEXT_ENGINE_JS_PARSER = "babel";
    const babelChunks = chunkFile({ filePath: "src/api.ts", text, maxLines: 80 });
    const babelSymbols = buildSymbolIndex({ filePath: "src/api.ts", text, chunks: babelChunks });

    assert.ok(babelChunks.some((chunk) => chunk.symbol === "method:ApiClient.request"));
    assert.ok(babelChunks.some((chunk) => chunk.symbol === "function:ApiClient.request.normalize"));
    assert.ok(babelSymbols.definitions.some((entry) => entry.kind === "method" && entry.name === "ApiClient.request"));
    assert.ok(babelSymbols.exports.some((entry) => entry.name === "ApiClient"));
  } finally {
    if (previousParser === undefined) delete process.env.CONTEXT_ENGINE_JS_PARSER;
    else process.env.CONTEXT_ENGINE_JS_PARSER = previousParser;
  }
});

test("chunkFile adds Python class method symbols while keeping module chunks", () => {
  const chunks = chunkFile({
    filePath: "src/tokens.py",
    text: [
      "class TokenStore:",
      "    @classmethod",
      "    def from_env(cls):",
      "        return cls()",
      "",
      "    async def load(self, key):",
      "        def decode(value):",
      "            return value",
      "        return decode(key)",
      "",
      "def make_store():",
      "    return TokenStore()",
      "",
    ].join("\n"),
    maxLines: 80,
  });

  const classChunk = chunks.find((chunk) => chunk.symbol === "class:TokenStore");
  const factoryChunk = chunks.find((chunk) => chunk.symbol === "function:TokenStore.from_env");
  const loadChunk = chunks.find((chunk) => chunk.symbol === "function:TokenStore.load");
  const moduleChunk = chunks.find((chunk) => chunk.symbol === "function:make_store");

  assert.ok(classChunk);
  assert.ok(factoryChunk);
  assert.ok(loadChunk);
  assert.ok(moduleChunk);
  assert.equal(classChunk.startLine, 1);
  assert.equal(classChunk.endLine, 9);
  assert.equal(factoryChunk.startLine, 2);
  assert.equal(factoryChunk.endLine, 4);
  assert.equal(loadChunk.startLine, 6);
  assert.equal(loadChunk.endLine, 9);
  assert.equal(moduleChunk.startLine, 11);
  assert.equal(moduleChunk.endLine, 12);
  assert.doesNotMatch(loadChunk.text, /def make_store/);
});

test("chunkFile falls back to line windows for oversized symbols", () => {
  const chunks = chunkFile({
    filePath: "src/tasks.ts",
    text: [
      "export function rebuildTaskIndex(tasks) {",
      "  const indexed = [];",
      "  for (const task of tasks) {",
      "    indexed.push(task.id);",
      "  }",
      "  return indexed;",
      "}",
    ].join("\n"),
    maxLines: 4,
    overlapLines: 1,
  });

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.symbol), [
    "function:rebuildTaskIndex",
    "function:rebuildTaskIndex",
  ]);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 4);
  assert.equal(chunks[1].startLine, 4);
  assert.equal(chunks[1].endLine, 7);
});

test("indexRepo skips unchanged files and search retrieves expected auth code", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;

  const first = await indexRepo({ repoPath: fixture, dbPath });
  assert.equal(first.indexed, 5);
  assert.ok(first.status.chunks >= 3);
  assert.ok(first.status.symbols >= 6);
  assert.ok(first.status.references >= 6);
  assert.ok(first.status.graphEdges >= first.status.symbols);

  const second = await indexRepo({ repoPath: fixture, dbPath });
  assert.equal(second.indexed, 0);
  assert.equal(second.skipped, 5);

  const result = await searchIndex({
    dbPath,
    query: "where is auth handled",
    limit: 3,
  });

  assert.equal(result.results[0].path, "src/auth.js");
  assert.match(result.results[0].snippet, /authenticateUser|verifyJwtToken/);
});

test("indexRepo persists first-class graph edges for definitions, exports, and references", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-graph-edge-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  await indexRepo({ repoPath: fixture, dbPath });

  const store = new ContextStore(dbPath);
  try {
    const edgeTypes = store.db.prepare(`
      SELECT edge_type AS edgeType, COUNT(*) AS count
      FROM graph_edges
      GROUP BY edge_type
    `).all();
    const counts = new Map(edgeTypes.map((row) => [row.edgeType, row.count]));

    assert.ok(counts.get("file_defines_symbol") >= 6);
    assert.ok(counts.get("file_exports_symbol") >= 5);
    assert.ok(counts.get("symbol_references_symbol") >= 2);
    assert.ok(counts.get("symbol_referenced_in_file") >= 2);

    const sessionUse = store.db.prepare(`
      SELECT *
      FROM graph_edges
      WHERE edge_type = 'symbol_referenced_in_file'
        AND source_symbol IN ('function:authenticateUser', 'authenticateUser')
        AND target_file_path = 'src/session.js'
    `).get();
    assert.equal(sessionUse.evidence_line, 5);
  } finally {
    store.close();
  }
});

test("reference search returns definitions and cross-file references", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-reference-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  await indexRepo({ repoPath: fixture, dbPath });

  const result = searchReferences({
    dbPath,
    symbol: "authenticateUser",
    limit: 10,
  });

  assert.ok(result.definitions.some((entry) => entry.filePath === "src/auth.js" && entry.name === "authenticateUser"));
  assert.ok(result.references.some((entry) => entry.filePath === "src/session.js" && entry.line >= 4));
  assert.ok(result.references.every((entry) => entry.chunk));
});

test("expanded search includes reference callers and import targets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-expanded-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  await indexRepo({ repoPath: fixture, dbPath });

  const result = await searchIndex({
    dbPath,
    query: "where is auth handled",
    limit: 3,
    expandRelated: true,
  });

  assert.ok(result.expandRelated);
  assert.ok(result.results.some((entry) => entry.path === "src/auth.js"));
  assert.ok(result.results.some((entry) => (
    entry.path === "src/session.js" &&
    entry.relatedTo &&
    ["call-usage", "definition"].includes(entry.role)
  )));
});

test("incrementalIndexRepo updates changed files, removes missing files, and keeps filters conservative", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-incremental-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "docs"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "src", "live.js"), "export const live = 'oldToken';\n");
  await fs.writeFile(path.join(tempDir, "src", "remove.js"), "export const removed = 'removeMe';\n");
  await fs.writeFile(path.join(tempDir, "src", "skip.test.js"), "export const skip = 'ignoredTest';\n");
  await fs.writeFile(path.join(tempDir, "docs", "readme.md"), "# ignored docs\n");

  const first = await incrementalIndexRepo({
    repoPath: tempDir,
    dbPath,
    include: ["src/**"],
    exclude: ["*.test.js"],
  });
  assert.equal(first.indexed, 2);
  assert.equal(first.status.files, 2);

  await fs.writeFile(path.join(tempDir, "src", "live.js"), "export const live = 'newToken';\n");
  await fs.unlink(path.join(tempDir, "src", "remove.js"));
  await fs.writeFile(path.join(tempDir, "src", "skip.test.js"), "export const skip = 'changedButIgnored';\n");
  await fs.writeFile(path.join(tempDir, "docs", "readme.md"), "# still ignored\n");

  const second = await incrementalIndexRepo({
    repoPath: tempDir,
    dbPath,
    include: ["src/**"],
    exclude: ["*.test.js"],
  });
  assert.equal(second.indexed, 1);
  assert.equal(second.skipped, 0);
  assert.equal(second.removed, 1);
  assert.equal(second.status.files, 1);

  const store = new ContextStore(dbPath);
  try {
    assert.ok(store.getFile("src/live.js"));
    assert.equal(store.getFile("src/remove.js"), undefined);
    assert.equal(store.getFile("src/skip.test.js"), undefined);
    assert.equal(store.getFile("docs/readme.md"), undefined);
  } finally {
    store.close();
  }

  const result = await searchIndex({
    dbPath,
    query: "newToken",
    limit: 1,
  });
  assert.equal(result.results[0].path, "src/live.js");
  assert.match(result.results[0].snippet, /newToken/);

  const third = await incrementalIndexRepo({
    repoPath: tempDir,
    dbPath,
    include: ["src/**"],
    exclude: ["*.test.js"],
  });
  assert.equal(third.indexed, 0);
  assert.equal(third.skipped, 1);
  assert.equal(third.removed, 0);
});

test("watch helper ignores context-engine database churn and common noise", () => {
  const root = path.join(os.tmpdir(), "context-engine-watch-root");
  const dbPath = path.join(root, ".context-engine", "index.sqlite");

  assert.equal(shouldIgnoreWatchEvent(".context-engine/index.sqlite", { root, dbPath }), true);
  assert.equal(shouldIgnoreWatchEvent(".context-engine/index.sqlite-wal", { root, dbPath }), true);
  assert.equal(shouldIgnoreWatchEvent("node_modules/pkg/index.js", { root, dbPath }), true);
  assert.equal(shouldIgnoreWatchEvent("src/live.js", { root, dbPath }), false);
});

test("scanRepo respects nested gitignore patterns and default noise skips", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-ignore-test-"));
  await fs.mkdir(path.join(tempDir, "src", "generated"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "packages", "app", "dist"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "packages", "app", "src"), { recursive: true });
  await fs.mkdir(path.join(tempDir, ".context-engine"), { recursive: true });
  await fs.mkdir(path.join(tempDir, ".venv"), { recursive: true });

  await fs.writeFile(path.join(tempDir, ".gitignore"), [
    "*.log",
    "dist/",
    "/root-only.js",
    "src/generated/",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(tempDir, "packages", "app", ".gitignore"), "*.tmp\n!keep.tmp\n");
  await fs.writeFile(path.join(tempDir, "src", "keep.js"), "export const keep = true;\n");
  await fs.writeFile(path.join(tempDir, "src", "debug.log"), "noisy log\n");
  await fs.writeFile(path.join(tempDir, "src", "generated", "client.js"), "generated\n");
  await fs.writeFile(path.join(tempDir, "root-only.js"), "ignored at root\n");
  await fs.writeFile(path.join(tempDir, "packages", "app", "root-only.js"), "not ignored below root\n");
  await fs.writeFile(path.join(tempDir, "packages", "app", "dist", "bundle.js"), "generated bundle\n");
  await fs.writeFile(path.join(tempDir, "packages", "app", "cache.tmp"), "ignored tmp\n");
  await fs.writeFile(path.join(tempDir, "packages", "app", "keep.tmp"), "unignored tmp\n");
  await fs.writeFile(path.join(tempDir, ".context-engine", "index.sqlite"), "internal db\n");
  await fs.writeFile(path.join(tempDir, ".venv", "activate"), "virtualenv\n");
  await fs.writeFile(path.join(tempDir, ".env.local"), "SECRET=value\n");
  await fs.writeFile(path.join(tempDir, ".envrc"), "export SECRET=value\n");

  const paths = (await scanRepo(tempDir)).map((file) => file.path);

  assert.ok(paths.includes("src/keep.js"));
  assert.ok(paths.includes("packages/app/root-only.js"));
  assert.ok(paths.includes("packages/app/keep.tmp"));
  assert.ok(!paths.includes("src/debug.log"));
  assert.ok(!paths.includes("src/generated/client.js"));
  assert.ok(!paths.includes("root-only.js"));
  assert.ok(!paths.includes("packages/app/dist/bundle.js"));
  assert.ok(!paths.includes("packages/app/cache.tmp"));
  assert.ok(!paths.includes(".context-engine/index.sqlite"));
  assert.ok(!paths.includes(".venv/activate"));
  assert.ok(!paths.includes(".env.local"));
  assert.ok(!paths.includes(".envrc"));
});

test("scanRepo explains ignore decisions and applies conservative filters", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-scan-diagnostics-test-"));
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "docs"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });

  await fs.writeFile(path.join(tempDir, ".gitignore"), "*.log\n*.tmp\n!keep.tmp\n");
  await fs.writeFile(path.join(tempDir, "src", "keep.js"), "export const keep = true;\n");
  await fs.writeFile(path.join(tempDir, "src", "skip.test.js"), "export const skip = true;\n");
  await fs.writeFile(path.join(tempDir, "docs", "readme.md"), "# docs\n");
  await fs.writeFile(path.join(tempDir, "debug.log"), "debug\n");
  await fs.writeFile(path.join(tempDir, "keep.tmp"), "unignored\n");
  await fs.writeFile(path.join(tempDir, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

  const paths = (await scanRepo(tempDir, {
    include: ["src/**"],
    exclude: ["*.test.js"],
  })).map((file) => file.path);
  assert.deepEqual(paths, ["src/keep.js"]);

  const forcedDefaultSkip = await scanRepo(tempDir, { include: ["node_modules/**"] });
  assert.deepEqual(forcedDefaultSkip.map((file) => file.path), []);

  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-filtered-index-test-"));
  const indexed = await indexRepo({
    repoPath: tempDir,
    dbPath: path.join(dbDir, "index.sqlite"),
    include: ["src/**"],
    exclude: ["*.test.js"],
  });
  assert.equal(indexed.status.files, 1);

  const diagnostics = await explainRepoScan(tempDir, {
    include: ["src/**"],
    exclude: ["*.test.js"],
  });

  const included = diagnostics.included.find((entry) => entry.path === "src/keep.js");
  const gitignored = diagnostics.excluded.find((entry) => entry.path === "debug.log");
  const defaultSkipped = diagnostics.excluded.find((entry) => entry.path === "node_modules");
  const cliExcluded = diagnostics.excluded.find((entry) => entry.path === "src/skip.test.js");
  const includeFiltered = diagnostics.excluded.find((entry) => entry.path === "docs/readme.md");

  assert.equal(included.reason, "included-by-include");
  assert.equal(included.matchedRules[0].source, "cli");
  assert.equal(gitignored.reason, "gitignore");
  assert.equal(gitignored.matchedRules[0].sourcePath, ".gitignore");
  assert.equal(defaultSkipped.reason, "default-ignore-dir");
  assert.equal(cliExcluded.reason, "cli-exclude");
  assert.equal(includeFiltered.reason, "cli-include-filter");
  assert.ok(diagnostics.rules.some((rule) => rule.source === "gitignore" && rule.pattern === "*.log"));
  assert.ok(diagnostics.rules.some((rule) => rule.source === "cli" && rule.action === "include"));
  assert.equal(diagnostics.counts.includedFiles, 1);

  const negationDiagnostics = await explainRepoScan(tempDir);
  const unignored = negationDiagnostics.included.find((entry) => entry.path === "keep.tmp");
  assert.equal(unignored.reason, "included-by-gitignore-negation");
  assert.equal(unignored.matchedRules.at(-1).pattern, "!keep.tmp");
});

test("CLI scan --explain reports ignore diagnostics as JSON", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-cli-scan-test-"));
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tempDir, ".gitignore"), "*.log\n");
  await fs.writeFile(path.join(tempDir, "src", "keep.js"), "export const keep = true;\n");
  await fs.writeFile(path.join(tempDir, "src", "skip.test.js"), "export const skip = true;\n");
  await fs.writeFile(path.join(tempDir, "debug.log"), "debug\n");

  const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const { stdout } = await execFileAsync(process.execPath, [
    "./bin/context-engine.js",
    "scan",
    tempDir,
    "--include",
    "src/**",
    "--exclude",
    "*.test.js",
    "--explain",
  ], { cwd: projectRoot });
  const payload = JSON.parse(stdout);

  assert.deepEqual(payload.options.include, ["src/**"]);
  assert.deepEqual(payload.options.exclude, ["*.test.js"]);
  assert.equal(payload.included[0].path, "src/keep.js");
  assert.ok(payload.excluded.some((entry) => entry.path === "debug.log" && entry.reason === "gitignore"));
  assert.ok(payload.excluded.some((entry) => entry.path === "src/skip.test.js" && entry.reason === "cli-exclude"));
});

test("CLI references returns symbol definitions and references", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-cli-references-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  await indexRepo({ repoPath: fixture, dbPath });

  const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const { stdout } = await execFileAsync(process.execPath, [
    "./bin/context-engine.js",
    "references",
    "authenticateUser",
    "--db",
    dbPath,
  ], { cwd: projectRoot });
  const payload = JSON.parse(stdout);

  assert.ok(payload.definitions.some((entry) => entry.filePath === "src/auth.js"));
  assert.ok(payload.references.some((entry) => entry.filePath === "src/session.js"));
});

test("CLI watch --once runs one incremental pass with scan filters", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-cli-watch-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "src", "keep.js"), "export const keep = true;\n");
  await fs.writeFile(path.join(tempDir, "src", "skip.test.js"), "export const skip = true;\n");

  const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const { stdout } = await execFileAsync(process.execPath, [
    "./bin/context-engine.js",
    "watch",
    tempDir,
    "--once",
    "--db",
    dbPath,
    "--include",
    "src/**",
    "--exclude",
    "*.test.js",
    "--debounce-ms",
    "25",
  ], { cwd: projectRoot });
  const payload = JSON.parse(stdout);

  assert.equal(payload.indexed, 1);
  assert.equal(payload.status.files, 1);
});

test("createEmbeddingProvider builds an Ollama adapter without calling fetch until embed", async () => {
  const requests = [];
  const provider = createEmbeddingProvider({
    provider: "ollama",
    model: "test-embed",
    dims: 3,
    baseUrl: "http://ollama.test/",
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
      };
    },
  });

  assert.equal(provider.name, "ollama:test-embed");
  assert.equal(provider.dims, 3);
  assert.equal(requests.length, 0);

  const vector = await provider.embed("hello auth");
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://ollama.test/api/embed");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(requests[0].options.headers, { "content-type": "application/json" });
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "test-embed",
    input: "hello auth",
  });
});

test("Ollama adapter validates response dimensions", async () => {
  const provider = createEmbeddingProvider({
    provider: "ollama:tiny-embed",
    dims: 3,
    baseUrl: "127.0.0.1:11434",
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [[1, 2]] }),
    }),
  });

  await assert.rejects(
    () => provider.embed("dimension mismatch"),
    /returned 2 dims, expected 3/,
  );
});

test("createEmbeddingProvider builds an OpenAI-compatible adapter without calling fetch until embed", async () => {
  const requests = [];
  const provider = createEmbeddingProvider({
    provider: "openai-compatible",
    model: "text-embedding-test",
    dims: 3,
    baseUrl: "http://embed.test/v1/",
    apiKey: "test-key",
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.3, 0.2, 0.1] }] }),
      };
    },
  });

  assert.equal(provider.name, "openai-compatible:text-embedding-test");
  assert.equal(provider.dims, 3);
  assert.equal(requests.length, 0);

  const vector = await provider.embed("semantic auth flow");
  assert.deepEqual(vector, [0.3, 0.2, 0.1]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://embed.test/v1/embeddings");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "text-embedding-test",
    input: "semantic auth flow",
  });
});

test("OpenAI-compatible adapter requires an explicit base URL", () => {
  assert.throws(
    () => createEmbeddingProvider({
      provider: "openai-compatible:text-embedding-test",
      dims: 3,
      fetch: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 0, 0] }] }) }),
    }),
    /requires a base URL/,
  );
});

test("CLI status accepts Ollama model and URL flags without calling the server", async () => {
  const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-cli-ollama-status-test-"));
  const { stdout } = await execFileAsync(process.execPath, [
    "./bin/context-engine.js",
    "status",
    "--db",
    path.join(tempDir, "index.sqlite"),
    "--embedding-provider",
    "ollama",
    "--embedding-model",
    "flag-model",
    "--embedding-url",
    "http://127.0.0.1:1",
    "--embedding-dims",
    "3",
  ], { cwd: projectRoot });
  const payload = JSON.parse(stdout);

  assert.equal(payload.embeddingProvider, "ollama:flag-model");
  assert.equal(payload.embeddingDims, 3);
});

test("indexRepo records and reuses a pluggable embedding provider", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  let embedCalls = 0;
  const provider = {
    name: "test-keyword-v1",
    dims: 3,
    embed(text) {
      embedCalls += 1;
      const lower = String(text).toLowerCase();
      return [
        lower.includes("auth") || lower.includes("jwt") ? 1 : 0,
        lower.includes("task") ? 1 : 0,
        lower.includes("sample") ? 1 : 0,
      ];
    },
  };

  const first = await indexRepo({ repoPath: fixture, dbPath, embeddingProvider: provider });
  assert.equal(first.status.embeddingProvider, "test-keyword-v1");
  assert.equal(first.status.embeddingDims, 3);

  const result = await searchIndex({
    dbPath,
    query: "jwt auth",
    limit: 1,
    embeddingProvider: provider,
  });

  assert.equal(result.status.embeddingProvider, "test-keyword-v1");
  assert.equal(result.results[0].path, "src/auth.js");
  assert.ok(embedCalls > first.status.chunks);
});

test("search rejects an embedding provider mismatch", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  await indexRepo({ repoPath: fixture, dbPath });

  await assert.rejects(
    () => searchIndex({
      dbPath,
      query: "auth",
      embeddingProvider: createEmbeddingProvider({ provider: "local-hash-v1", dims: 16 }),
    }),
    /Embedding provider mismatch/,
  );
});

test("search rejects mismatched Ollama model metadata before calling fetch", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  let fetchCalls = 0;
  const provider = createEmbeddingProvider({
    provider: "ollama:model-a",
    dims: 3,
    baseUrl: "http://ollama.test",
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: [[1, 0, 0]] }),
      };
    },
  });

  const indexed = await indexRepo({ repoPath: fixture, dbPath, embeddingProvider: provider });
  assert.equal(indexed.status.embeddingProvider, "ollama:model-a");
  assert.ok(fetchCalls >= indexed.status.chunks);

  const mismatched = createEmbeddingProvider({
    provider: "ollama:model-b",
    dims: 3,
    baseUrl: "http://ollama.test",
    fetch: async () => {
      throw new Error("fetch should not be called for a metadata mismatch");
    },
  });

  await assert.rejects(
    () => searchIndex({
      dbPath,
      query: "auth",
      embeddingProvider: mismatched,
    }),
    /Embedding provider mismatch/,
  );
});

test("search retrieves task persistence code", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  await indexRepo({ repoPath: fixture, dbPath });

  const result = await searchIndex({
    dbPath,
    query: "task persistence save load",
    limit: 3,
  });

  assert.equal(result.results[0].path, "src/tasks.js");
  assert.match(result.results[0].snippet, /saveTask|loadTask/);
});

test("search retrieves focused nested and object method symbols", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  const provider = {
    name: "test-nested-symbols-v1",
    dims: 3,
    embed(text) {
      const lower = String(text).toLowerCase();
      return [
        lower.includes("settle invoice lifecycle") || lower.includes("method:paymentworkflow.settleinvoice") ? 1 : 0,
        lower.includes("capture handler object") || lower.includes("method:paymenthandlers.capture") ? 1 : 0,
        lower.includes("record audit nested helper") || lower.includes("function:paymentworkflow.settleinvoice.recordaudit") ? 1 : 0,
      ];
    },
  };

  await indexRepo({ repoPath: fixture, dbPath, embeddingProvider: provider });

  const classMethod = await searchIndex({
    dbPath,
    query: "settle invoice lifecycle",
    limit: 1,
    embeddingProvider: provider,
  });
  assert.equal(classMethod.results[0].path, "src/payments.js");
  assert.equal(classMethod.results[0].symbol, "method:PaymentWorkflow.settleInvoice");
  assert.match(classMethod.results[0].snippet, /async settleInvoice/);

  const objectMethod = await searchIndex({
    dbPath,
    query: "capture handler object",
    limit: 1,
    embeddingProvider: provider,
  });
  assert.equal(objectMethod.results[0].path, "src/payments.js");
  assert.equal(objectMethod.results[0].symbol, "method:paymentHandlers.capture");
  assert.match(objectMethod.results[0].snippet, /async capture/);

  const nestedHelper = await searchIndex({
    dbPath,
    query: "record audit nested helper",
    limit: 1,
    embeddingProvider: provider,
  });
  assert.equal(nestedHelper.results[0].path, "src/payments.js");
  assert.equal(nestedHelper.results[0].symbol, "function:PaymentWorkflow.settleInvoice.recordAudit");
  assert.match(nestedHelper.results[0].snippet, /function recordAudit/);
});

test("hybrid search boosts exact symbol intent ahead of broad related helpers", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-symbol-ranking-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "src", "store.js"), [
    "export class ContextStore {",
    "  search(query, options = {}) {",
    "    return options.expandRelated ? this.expandRelatedResults([], options) : [];",
    "  }",
    "",
    "  expandRelatedResults(results, { limit = 8 } = {}) {",
    "    const expanded = [];",
    "    const add = (result) => {",
    "      expanded.push(result);",
    "    };",
    "    for (const result of results) add(result);",
    "    return expanded.slice(0, limit);",
    "  }",
    "",
    "  relatedChunksForResult(result) {",
    "    return [",
    "      ...this.importTargetChunks(result.path),",
    "      ...this.referenceChunks(result),",
    "      ...this.testChunksForFile(result.path),",
    "    ];",
    "  }",
    "",
    "  importTargetChunks(filePath) {",
    "    return [];",
    "  }",
    "",
    "  referenceChunks(result) {",
    "    return [];",
    "  }",
    "",
    "  testChunksForFile(filePath) {",
    "    return [];",
    "  }",
    "}",
    "",
  ].join("\n"));

  await indexRepo({ repoPath: tempDir, dbPath });

  const result = await searchIndex({
    dbPath,
    query: "expand related chunks same file import target symbol reference nearby test",
    limit: 8,
  });
  const symbols = result.results.map((entry) => entry.symbol);

  assert.ok(symbols.includes("method:ContextStore.expandRelatedResults"));
  assert.ok(
    symbols.indexOf("method:ContextStore.expandRelatedResults")
      < symbols.indexOf("function:ContextStore.expandRelatedResults.add"),
  );
  assert.ok(result.results.find((entry) => entry.symbol === "method:ContextStore.expandRelatedResults").symbolScore > 0);
});

test("graph slice expansion ranks referenced definitions above noisier same-file neighbors", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-related-ranking-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "src", "flow.js"), [
    "export function startFlow() {",
    "  return expandRelatedResults([]);",
    "}",
    "",
    "export function expandRelatedResults(results) {",
    "  return results.map((result) => result.id);",
    "}",
    "",
    "export function importTargetChunks(filePath) {",
    "  return [];",
    "}",
    "",
  ].join("\n"));

  await indexRepo({ repoPath: tempDir, dbPath });

  const result = await searchIndex({
    dbPath,
    query: "start flow same file neighbor expand related results",
    limit: 1,
    expandRelated: true,
  });

  const related = result.results.filter((entry) => entry.relatedTo);
  const expandDefinition = related.find((entry) => entry.symbol === "function:expandRelatedResults");
  const noisyNeighbor = related.find((entry) => entry.symbol === "function:importTargetChunks");

  assert.equal(expandDefinition.role, "definition");
  assert.match(expandDefinition.reason, /function:startFlow references function:expandRelatedResults/);
  assert.equal(noisyNeighbor.role, "same-file-neighbor");
  assert.ok(
    result.results.indexOf(expandDefinition) < result.results.indexOf(noisyNeighbor),
  );
});

test("buildContextBundle returns prompt-ready context under budget", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  await indexRepo({ repoPath: fixture, dbPath });

  const bundle = await buildContextBundle({
    dbPath,
    query: "where is auth handled",
    limit: 3,
    maxChars: 700,
  });

  assert.ok(bundle.usedChars <= 700);
  assert.ok(bundle.context.includes("src/auth.js"));
  assert.ok(bundle.context.includes("authenticateUser"));
  assert.ok(bundle.itemCount >= 1);
  assert.ok(bundle.items.every((item) => item.role && item.reason && Number.isFinite(item.score)));
});

test("buildContextBundle packs graph roles before same-file neighbor filler", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-bundle-role-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "src", "flow.js"), [
    "export function startFlow() {",
    "  return expandRelatedResults([]);",
    "}",
    "",
    "export function expandRelatedResults(results) {",
    "  return results.map((result) => result.id);",
    "}",
    "",
    "export function importTargetChunks(filePath) {",
    "  return [];",
    "}",
    "",
  ].join("\n"));

  await indexRepo({ repoPath: tempDir, dbPath });

  const bundle = await buildContextBundle({
    dbPath,
    query: "start flow same file neighbor expand related results",
    limit: 1,
    maxChars: 1200,
  });
  const symbols = bundle.items.map((item) => item.symbol);

  assert.ok(bundle.context.includes("Role: definition"));
  assert.ok(symbols.indexOf("function:expandRelatedResults") < symbols.indexOf("function:importTargetChunks"));
  assert.equal(bundle.items.find((item) => item.symbol === "function:expandRelatedResults").role, "definition");
});

test("golden eval reports baseline retrieval metrics", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-eval-test-"));
  const dbPath = path.join(tempDir, "eval.sqlite");
  const fixture = new URL("./fixtures/sample-repo", import.meta.url).pathname;

  const result = await runGoldenEval({
    repoPath: fixture,
    dbPath,
    limit: 3,
  });

  assert.equal(result.baselines.length, 4);
  assert.ok(result.baselines.some((baseline) => baseline.name === "lexical-only"));
  assert.ok(result.baselines.some((baseline) => baseline.name === "enhanced-hybrid" && baseline.expandRelated));
  for (const baseline of result.baselines) {
    assert.equal(baseline.cases.length, 4);
    assert.ok(Number.isFinite(baseline.metrics.fileRecallAtK));
    assert.ok(Number.isFinite(baseline.metrics.fileMrr));
  }
});

test("self golden eval suite targets indexed context-engine files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-self-eval-test-"));
  const dbPath = path.join(tempDir, "eval.sqlite");
  const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);

  const result = await runGoldenEval({
    repoPath: projectRoot,
    dbPath,
    suite: "self",
    limit: 8,
  });

  for (const golden of SELF_REPO_GOLDEN_QUERIES) {
    for (const expectedFile of golden.expectedFiles) {
      await fs.access(path.join(projectRoot, expectedFile));
    }
  }

  assert.equal(result.suite, "self");
  assert.equal(result.queryCount, SELF_REPO_GOLDEN_QUERIES.length);
  assert.equal(result.baselines.length, 4);
  assert.deepEqual(result.baselines[0].cases.map((item) => item.id), SELF_REPO_GOLDEN_QUERIES.map((item) => item.id));
  assert.ok(result.indexLatencyMs > 0);
  assert.ok(result.baselines.every((baseline) => baseline.cases.length === SELF_REPO_GOLDEN_QUERIES.length));
  assert.ok(result.baselines.every((baseline) => Number.isFinite(baseline.latencyMs)));
});
