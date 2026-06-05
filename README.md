# Context Engine

Local-first code context retrieval for coding agents.

The first MVP indexes a repository into a SQLite-backed vector store, then exposes ranked code retrieval through both a CLI and MCP server.

## What It Does

- Scans a repo while skipping common generated/vendor folders and `.gitignore` matches.
- Provides opt-in scan diagnostics so callers can inspect active ignore rules and inclusion/exclusion decisions.
- Chunks UTF-8 source files with path, line range, language, and best-effort symbol metadata, preferring complete JS/TS and Python symbols when they fit.
- Uses native tree-sitter grammars by default for JS/TS parser-backed chunk boundaries and symbol graph extraction, including definitions, imports, exports, and conservative identifier references. Babel remains the fallback parser and can be forced with `CONTEXT_ENGINE_JS_PARSER=babel`.
- Stores file metadata and chunks in SQLite.
- Stores symbol, import/export, and reference metadata next to chunks.
- Reuses file hashes for conservative incremental indexing: changed files are refreshed, missing files are removed, and unchanged files are skipped.
- Builds deterministic local hashed embeddings by default, so no code leaves the machine.
- Records embedding provider metadata in the index so callers cannot accidentally query with incompatible vectors.
- Combines vector similarity with lexical/FTS search.
- Can expand top results with bounded related code: same-file neighbors, import/export edges, symbol references, and nearby test files.
- Provides local golden retrieval evals with lexical-only, vector-only, hybrid, and expanded hybrid baselines.
- Exposes read-only MCP tools for model integration.

## Integration Walkthrough

Start from the `context-engine/` directory:

```bash
npm install
npm test
```

Index a repository into the default database at `<repo>/.context-engine/index.sqlite`:

```bash
node ./bin/context-engine.js index /path/to/repo
node ./bin/context-engine.js status --db /path/to/repo/.context-engine/index.sqlite
```

Before indexing a large or unfamiliar repo, inspect what will be included:

```bash
node ./bin/context-engine.js scan /path/to/repo --explain
node ./bin/context-engine.js scan /path/to/repo \
  --include 'src/**' \
  --exclude '*.test.js' \
  --explain
```

`scan --explain` prints JSON with the active default, CLI, and `.gitignore` rules, plus per-path include/exclude reasons. Use this when expected files are missing from search results or noisy generated files appear eligible.

Run searches against the index:

```bash
node ./bin/context-engine.js search "where is auth handled" \
  --db /path/to/repo/.context-engine/index.sqlite \
  --limit 5
```

Compare ranking modes or opt into related code expansion:

```bash
node ./bin/context-engine.js search "where is auth handled" \
  --db /path/to/repo/.context-engine/index.sqlite \
  --mode lexical

node ./bin/context-engine.js search "where is auth handled" \
  --db /path/to/repo/.context-engine/index.sqlite \
  --expand-related
```

Find definitions and conservative references for a symbol:

```bash
node ./bin/context-engine.js references authenticateUser \
  --db /path/to/repo/.context-engine/index.sqlite
```

Build a prompt-ready context bundle when a coding agent needs snippets packed under a budget:

```bash
node ./bin/context-engine.js bundle "where is auth handled" \
  --db /path/to/repo/.context-engine/index.sqlite \
  --max-chars 8000 \
  --limit 8
```

`bundle` expands related context by default. Use `--no-expand-related` when callers need only directly ranked chunks.

Run the built-in local golden eval against the sample fixture:

```bash
npm run eval
npm run eval:self
```

The eval reports Recall@K and MRR for lexical-only, vector-only, hybrid, and expanded hybrid baselines.

For ongoing local development, keep the index warm with watch mode:

```bash
node ./bin/context-engine.js watch /path/to/repo \
  --include 'src/**' \
  --exclude '*.test.js' \
  --debounce-ms 500
```

`watch` runs one incremental pass on startup, then re-runs after filesystem changes. It skips unchanged files by hash, prunes deleted files from SQLite, and ignores its own `.context-engine` database writes. Use `watch --once` in scripts or CI jobs that need a single incremental pass without a resident process.

## CLI

```bash
npm install
node ./bin/context-engine.js index /path/to/repo
node ./bin/context-engine.js scan /path/to/repo --explain
node ./bin/context-engine.js watch /path/to/repo
node ./bin/context-engine.js search "where is auth handled" --db /path/to/repo/.context-engine/index.sqlite --expand-related
node ./bin/context-engine.js bundle "where is auth handled" --db /path/to/repo/.context-engine/index.sqlite --max-chars 8000
node ./bin/context-engine.js references authenticateUser --db /path/to/repo/.context-engine/index.sqlite
node ./bin/context-engine.js eval ./tests/fixtures/sample-repo
node ./bin/context-engine.js status --db /path/to/repo/.context-engine/index.sqlite
```

`index` and `scan` accept repeatable conservative filters:

```bash
node ./bin/context-engine.js index /path/to/repo \
  --include 'src/**' \
  --exclude '*.test.js'
```

`--include` narrows the set of otherwise eligible files. It does not force default skips, `.env*`, binary files, oversized files, or `.gitignore`-excluded paths back into the index. `--exclude` removes matching files or directories after default and `.gitignore` rules have been applied.

`watch` runs an initial incremental indexing pass and then uses a debounced recursive filesystem watcher to re-run the same conservative pass after changes:

```bash
node ./bin/context-engine.js watch /path/to/repo \
  --include 'src/**' \
  --exclude '*.test.js' \
  --debounce-ms 500
```

Each pass respects the same scan filters as `index`. Changed files are re-chunked, deleted files are removed from SQLite, and unchanged files are skipped by hash. The watcher ignores its own default `.context-engine` database writes plus common VCS/dependency noise to avoid self-trigger loops. For scripts or tests, `watch --once` runs one incremental pass and exits.

Optional embedding flags are supported by `index`, `search`, `bundle`, `eval`, and `status`:

```bash
node ./bin/context-engine.js index /path/to/repo \
  --embedding-provider local-hash-v1 \
  --embedding-dims 384
```

`local-hash-v1` is the default provider and never sends code outside the machine. The built-in external adapter is opt-in Ollama-compatible local HTTP embeddings:

```bash
CONTEXT_ENGINE_OLLAMA_MODEL=nomic-embed-text \
node ./bin/context-engine.js index /path/to/repo \
  --embedding-provider ollama \
  --embedding-model nomic-embed-text \
  --embedding-dims 768
```

Ollama settings come from environment variables only:

- `CONTEXT_ENGINE_OLLAMA_URL` or `OLLAMA_HOST` for the base URL, defaulting to `http://127.0.0.1:11434`.
- `CONTEXT_ENGINE_OLLAMA_MODEL` or `OLLAMA_EMBEDDING_MODEL` for the model, defaulting to `nomic-embed-text`.
- `CONTEXT_ENGINE_OLLAMA_DIMS` or `OLLAMA_EMBEDDING_DIMS` for dimensions when `--embedding-dims` is omitted, defaulting to `768`.

You can also pin the model in the provider name, for example `--embedding-provider ollama:nomic-embed-text`. Index metadata records the concrete provider/model and dimensions, so search and bundle calls must use compatible embedding settings. The internal store and indexer also accept an injected provider object (`{ name, dims, embed(text) }`) for tests or custom local adapters.

Use the self-repo eval with a real local embedding model when Ollama is installed and the model is pulled:

```bash
ollama pull nomic-embed-text
npm run eval:self:ollama
```

The script writes to `./.tmp/self-golden-eval.ollama.ctx.db` and runs the same `self` golden suite as `npm run eval:self`, using `CONTEXT_ENGINE_OLLAMA_MODEL` and `CONTEXT_ENGINE_OLLAMA_DIMS` when set. For another local Ollama model, pass the options directly:

```bash
node ./bin/context-engine.js eval . \
  --db ./.tmp/self-golden-eval.ollama.ctx.db \
  --suite self \
  --limit 8 \
  --embedding-provider ollama \
  --embedding-model nomic-embed-text \
  --embedding-dims 768
```

An OpenAI-compatible embeddings endpoint is also available for explicitly configured local gateways or remote providers. It never runs by default and requires a base URL plus model:

```bash
node ./bin/context-engine.js index /path/to/repo \
  --embedding-provider openai-compatible \
  --embedding-url http://127.0.0.1:8080/v1 \
  --embedding-model text-embedding-model \
  --embedding-dims 1536
```

Equivalent environment variables are `CONTEXT_ENGINE_OPENAI_COMPAT_URL`, `CONTEXT_ENGINE_OPENAI_COMPAT_MODEL`, `CONTEXT_ENGINE_OPENAI_COMPAT_DIMS`, and optional `CONTEXT_ENGINE_OPENAI_COMPAT_API_KEY`. The API key is only sent as an authorization header when explicitly provided.

## Ignore Handling

Indexing skips common dependency, build, cache, virtualenv, lockfile, local database, and `.env*` noise by default. It also applies `.gitignore` files found at the repo root or in nested directories, including basename globs like `*.log`, directory patterns like `dist/`, root-anchored patterns like `/generated.js`, and later negation rules like `!keep.tmp`.

Use `scan --explain` to inspect decisions without indexing:

```bash
node ./bin/context-engine.js scan /path/to/repo --include 'src/**' --exclude '*.test.js' --explain
```

The JSON output includes active default, CLI, and `.gitignore` rules plus included and excluded entries with reasons such as `included-by-include`, `included-by-gitignore-negation`, `default-ignore-dir`, `gitignore`, `cli-exclude`, `cli-include-filter`, `too-large`, and `binary`. Without `--explain`, `scan` returns a compact included-path summary.

## Chunking

JS/TS files use a lightweight parser-backed pass for syntax-aware symbol ranges. The index keeps outer class/function/export chunks for surrounding context and adds focused nested chunks for class methods, object methods, and inner named function or arrow declarations. If parsing fails, indexing falls back to the previous line-scanner behavior instead of dropping the file.

Python chunking remains dependency-free and indentation-aware. It keeps class/module chunks and adds focused class method chunks, including decorators. Full parser-backed Python support is still future work.

## Symbols, References, And Expansion

Indexing persists a lightweight symbol graph in SQLite:

- `symbols`: parser/chunk-derived definitions with kind, name, line range, export flag, and signature hint.
- `imports` and `exports`: JS/TS import/export edges where the parser can recover them.
- `symbol_references`: conservative identifier/token references, linked to same-file definitions when possible.

`references` and MCP `reference_search` return matching definitions plus reference locations and containing chunks. Reference matching is intentionally conservative: parser-backed JS/TS identifiers are strongest, while non-parser languages use lexical token fallback.

Related expansion is bounded and additive. Base search results stay ranked by the selected mode; expansion can append same-file neighbor chunks, local import targets, cross-file reference callers, and nearby `*.test.*`, `*.spec.*`, or `__tests__` chunks. `search` requires `--expand-related`; `bundle` enables expansion by default because prompt bundles benefit from surrounding context.

The current parser abstraction prefers native tree-sitter for JS/TS because the pinned grammar packages install cleanly in this project. Babel remains available as a fallback path when tree-sitter cannot parse a file, and for explicit comparisons or troubleshooting:

```bash
CONTEXT_ENGINE_JS_PARSER=babel npm run eval:self
CONTEXT_ENGINE_JS_PARSER=tree-sitter npm run eval:self
```

## MCP

OpenClaw registration used by this workspace:

```bash
openclaw mcp add code-context \
  --command node \
  --arg /home/admin/.openclaw/workspace/context-engine/bin/context-engine-mcp.js \
  --include 'codebase_search,context_bundle,index_repo,index_status,read_file,reference_search' \
  --timeout 30
```

Probe the registration after adding or changing it:

```bash
openclaw mcp probe code-context --json
```

Typical MCP flow:

1. Call `index_repo` with `{ "repoPath": "/path/to/repo" }`. Pass `dbPath` when the index should live outside the default `<repo>/.context-engine/index.sqlite`.
2. Call `index_status` with the same `dbPath` to confirm file/chunk counts and embedding metadata.
3. Call `codebase_search` with a natural-language query and `dbPath` to retrieve ranked snippets.
4. Call `context_bundle` with `query`, `dbPath`, and `maxChars` when the result should be pasted directly into a model prompt.
5. Call `reference_search` with `symbol` and `dbPath` when you need definition/reference locations for a symbol.
6. Call `read_file` with `repoPath` and a relative `filePath` when a result needs the complete source file.

Tools:

- `index_repo`: index a local repository into a SQLite DB.
- `codebase_search`: retrieve ranked snippets for a query; accepts `mode` and `expandRelated`.
- `context_bundle`: retrieve prompt-ready snippets under a character budget; expands related context by default.
- `reference_search`: retrieve definitions and references for a symbol.
- `index_status`: report indexed file/chunk counts.
- `read_file`: read a UTF-8 file under an explicit repo root.

`index_repo`, `codebase_search`, `context_bundle`, and `index_status` accept optional `embeddingProvider` and `embeddingDims` arguments. `index_repo` also accepts optional `include` and `exclude` arrays with the same conservative semantics as the CLI. Search and bundle calls must use embedding settings compatible with the index metadata.

MCP does not currently expose `scan` or `watch` as tools. Use the CLI commands above for diagnostics and long-running indexing, then point MCP calls at the resulting SQLite database.

## Ollama Embeddings

The default `local-hash-v1` embeddings are deterministic, dependency-light, and do not send code outside the machine. To use a local Ollama-compatible embedding server instead, start Ollama separately and index with the Ollama provider:

```bash
ollama pull nomic-embed-text
export CONTEXT_ENGINE_OLLAMA_MODEL=nomic-embed-text
node ./bin/context-engine.js index /path/to/repo \
  --embedding-provider ollama \
  --embedding-model nomic-embed-text \
  --embedding-dims 768
```

Use matching embedding settings for every later search, bundle, status, and MCP call against that database:

```bash
node ./bin/context-engine.js bundle "where is auth handled" \
  --db /path/to/repo/.context-engine/index.sqlite \
  --embedding-provider ollama \
  --embedding-model nomic-embed-text \
  --embedding-dims 768
```

For MCP, pass the same settings as tool arguments, for example `{ "dbPath": "/path/to/repo/.context-engine/index.sqlite", "query": "where is auth handled", "embeddingProvider": "ollama", "embeddingModel": "nomic-embed-text", "embeddingDims": 768 }`. If the model is pinned in the provider name, use the same concrete name everywhere, such as `ollama:nomic-embed-text`.

Run a direct semantic benchmark against this repo with:

```bash
npm run eval:self:ollama
```

If Ollama is not installed or no embedding model is available locally, this command is expected to fail before metrics are produced. Install Ollama, pull a model such as `nomic-embed-text`, then rerun it.

## Validation

```bash
npm test
npm run smoke
npm run eval
openclaw mcp probe code-context --json
openclaw mcp doctor
```

## Next Improvements

- Tree-sitter grammar coverage beyond JS/TS, starting with parser-backed Python if dependency weight is justified.
- Stronger retrieval ranking evaluation across larger real-world fixtures.
- Stronger vector backend adapter: sqlite-vec, LanceDB, or Qdrant.
- Watch diagnostics and fallback strategies for unusual filesystems.
