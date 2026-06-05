import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_VECTOR_DIMS,
  cosineSimilarity,
  normalizeEmbeddingProvider,
  parseVector,
  tokenize,
} from "./embedding.js";
import { resolveImportPath, simpleSymbolName, symbolSearchNames } from "./symbols.js";

const SYMBOL_INDEX_VERSION = "2";

export class ContextStore {
  constructor(dbPath, { embeddingProvider } = {}) {
    this.dbPath = path.resolve(dbPath);
    this.embeddingProvider = normalizeEmbeddingProvider(embeddingProvider);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.ftsEnabled = false;
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        language TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        symbol TEXT,
        language TEXT NOT NULL,
        text TEXT NOT NULL,
        vector TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        signature TEXT,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        source TEXT NOT NULL,
        imported_name TEXT NOT NULL,
        local_name TEXT NOT NULL,
        line INTEGER NOT NULL,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_imports_file_path ON imports(file_path);
      CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source);
      CREATE TABLE IF NOT EXISTS exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        local_name TEXT NOT NULL,
        line INTEGER NOT NULL,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_exports_name ON exports(name);
      CREATE TABLE IF NOT EXISTS symbol_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        target_symbol TEXT,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        kind TEXT NOT NULL,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_references_name ON symbol_references(name);
      CREATE INDEX IF NOT EXISTS idx_symbol_references_target ON symbol_references(target_symbol);
      CREATE INDEX IF NOT EXISTS idx_symbol_references_file_path ON symbol_references(file_path);
      CREATE TABLE IF NOT EXISTS graph_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        edge_type TEXT NOT NULL,
        source_file_path TEXT,
        source_symbol TEXT,
        source_line INTEGER,
        target_file_path TEXT,
        target_symbol TEXT,
        target_line INTEGER,
        evidence_file_path TEXT NOT NULL,
        evidence_line INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_type_source_symbol ON graph_edges(edge_type, source_symbol);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_type_target_symbol ON graph_edges(edge_type, target_symbol);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_evidence_file ON graph_edges(evidence_file_path);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source_file ON graph_edges(source_file_path);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target_file ON graph_edges(target_file_path);
    `);

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          id UNINDEXED,
          file_path,
          symbol,
          text
        );
      `);
      this.ftsEnabled = true;
    } catch {
      this.ftsEnabled = false;
    }
  }

  close() {
    this.db.close();
  }

  getFile(filePath) {
    return this.db.prepare("SELECT * FROM files WHERE path = ?").get(filePath);
  }

  upsertFile(file) {
    this.db.prepare(`
      INSERT INTO files(path, hash, size, mtime_ms, language, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        language = excluded.language,
        indexed_at = excluded.indexed_at
    `).run(file.path, file.hash, file.size, file.mtimeMs, file.language, new Date().toISOString());
  }

  async upsertFileWithChunks(file, chunks, symbolIndex = emptySymbolIndex()) {
    this.assertEmbeddingCompatible();
    const rows = await this.prepareChunkRows(chunks);
    const upsertFile = this.db.prepare(`
      INSERT INTO files(path, hash, size, mtime_ms, language, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        language = excluded.language,
        indexed_at = excluded.indexed_at
    `);
    const deleteChunks = this.db.prepare("DELETE FROM chunks WHERE file_path = ?");
    const deleteFts = this.ftsEnabled ? this.db.prepare("DELETE FROM chunks_fts WHERE file_path = ?") : null;
    const deleteSymbols = this.db.prepare("DELETE FROM symbols WHERE file_path = ?");
    const deleteImports = this.db.prepare("DELETE FROM imports WHERE file_path = ?");
    const deleteExports = this.db.prepare("DELETE FROM exports WHERE file_path = ?");
    const deleteReferences = this.db.prepare("DELETE FROM symbol_references WHERE file_path = ?");
    const deleteGraphEdges = this.prepareGraphEdgeDelete();
    const insertChunk = this.prepareChunkInsert();
    const insertFts = this.prepareFtsInsert();
    const insertSymbol = this.prepareSymbolInsert();
    const insertImport = this.prepareImportInsert();
    const insertExport = this.prepareExportInsert();
    const insertReference = this.prepareReferenceInsert();
    const insertGraphEdge = this.prepareGraphEdgeInsert();

    this.db.exec("BEGIN");
    try {
      upsertFile.run(file.path, file.hash, file.size, file.mtimeMs, file.language, new Date().toISOString());
      deleteChunks.run(file.path);
      deleteFts?.run(file.path);
      deleteSymbols.run(file.path);
      deleteImports.run(file.path);
      deleteExports.run(file.path);
      deleteReferences.run(file.path);
      deleteGraphEdges.run(file.path, file.path, file.path);
      this.insertChunkRows(rows, insertChunk, insertFts);
      this.insertSymbolRows(symbolIndex, { insertSymbol, insertImport, insertExport, insertReference, insertGraphEdge });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertEmbeddingCompatible() {
    const stored = this.embeddingMetadata();
    const desired = {
      provider: this.embeddingProvider.name,
      dims: this.embeddingProvider.dims,
    };

    if (!stored) {
      if (this.chunkCount() > 0 && !isDefaultEmbedding(desired)) {
        throw new Error(
          `Embedding metadata is missing for ${this.dbPath}; existing chunks are assumed to use ${DEFAULT_EMBEDDING_PROVIDER}/${DEFAULT_VECTOR_DIMS}. Reindex into a fresh DB before using ${desired.provider}/${desired.dims}.`,
        );
      }
      this.setEmbeddingMetadata(desired);
      return;
    }

    if (stored.provider === desired.provider && stored.dims === desired.dims) return;

    if (this.chunkCount() === 0) {
      this.setEmbeddingMetadata(desired);
      return;
    }

    throw new Error(
      `Embedding provider mismatch for ${this.dbPath}: indexed with ${stored.provider}/${stored.dims}, requested ${desired.provider}/${desired.dims}. Reindex into a fresh DB or use matching embedding options.`,
    );
  }

  async replaceChunks(filePath, chunks) {
    this.assertEmbeddingCompatible();
    const rows = await this.prepareChunkRows(chunks);
    const deleteChunks = this.db.prepare("DELETE FROM chunks WHERE file_path = ?");
    const deleteFts = this.ftsEnabled ? this.db.prepare("DELETE FROM chunks_fts WHERE file_path = ?") : null;
    const insertChunk = this.prepareChunkInsert();
    const insertFts = this.prepareFtsInsert();

    this.db.exec("BEGIN");
    try {
      deleteChunks.run(filePath);
      deleteFts?.run(filePath);
      this.insertChunkRows(rows, insertChunk, insertFts);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeMissingFiles(currentPaths) {
    const paths = new Set(currentPaths);
    const stored = this.db.prepare("SELECT path FROM files").all().map((row) => row.path);
    const deleteFile = this.db.prepare("DELETE FROM files WHERE path = ?");
    const deleteFts = this.ftsEnabled ? this.db.prepare("DELETE FROM chunks_fts WHERE file_path = ?") : null;
    const deleteGraphEdges = this.prepareGraphEdgeDelete();
    let removed = 0;
    for (const filePath of stored) {
      if (!paths.has(filePath)) {
        deleteFts?.run(filePath);
        deleteGraphEdges.run(filePath, filePath, filePath);
        deleteFile.run(filePath);
        removed += 1;
      }
    }
    return removed;
  }

  status() {
    const metadata = this.embeddingMetadata();
    return {
      dbPath: this.dbPath,
      files: this.fileCount(),
      chunks: this.chunkCount(),
      symbols: this.symbolCount(),
      references: this.referenceCount(),
      graphEdges: this.graphEdgeCount(),
      ftsEnabled: this.ftsEnabled,
      embeddingProvider: metadata?.provider || this.embeddingProvider.name,
      embeddingDims: metadata?.dims || this.embeddingProvider.dims,
    };
  }

  async search(query, { limit = 8, mode = "hybrid", expandRelated = false } = {}) {
    this.assertEmbeddingCompatible();
    const queryAnalysis = analyzeQuery(query);
    const vector = await this.embeddingProvider.embed(query);
    const lexical = this.lexicalSearch(query, Math.max(limit * 4, 80));
    const lexicalScores = new Map(lexical.map((row, index) => [row.id, 1 - index / Math.max(lexical.length, 1)]));
    const rows = this.db.prepare("SELECT * FROM chunks").all();
    const scored = rows.map((row) => {
      const vectorScore = cosineSimilarity(vector, parseVector(row.vector));
      const lexicalScore = lexicalScores.get(row.id) || fallbackLexicalScore(query, row);
      const symbolScore = symbolAwareScore(queryAnalysis, row);
      const relationScore = relationIntentScore(queryAnalysis, row);
      const score = combinedScore({ vectorScore, lexicalScore, symbolScore, relationScore, mode });
      return formatResult(row, score, vectorScore, lexicalScore, symbolScore, relationScore);
    });

    const results = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return expandRelated ? this.expandRelatedResults(results, { limit, query, queryAnalysis }) : results;
  }

  referenceSearch(symbol, { limit = 25 } = {}) {
    const names = symbolSearchNames(symbol);
    if (!names.length) return [];
    const placeholders = names.map(() => "?").join(", ");
    const likeClauses = names.map(() => "target_symbol LIKE ?").join(" OR ");
    const rows = this.db.prepare(`
      SELECT *
      FROM symbol_references
      WHERE name IN (${placeholders})
         OR target_symbol IN (${placeholders})
         OR ${likeClauses}
      ORDER BY file_path, line, column
      LIMIT ?
    `).all(...names, ...names, ...names.map((name) => `%:${name}`), limit);
    return rows.map((row) => this.formatReference(row));
  }

  symbolDefinitions(symbol, { limit = 25 } = {}) {
    const names = symbolSearchNames(symbol);
    if (!names.length) return [];
    const placeholders = names.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE name IN (${placeholders})
         OR kind || ':' || name IN (${placeholders})
      ORDER BY exported DESC, file_path, start_line
      LIMIT ?
    `).all(...names, ...names, limit).map(formatSymbol);
  }

  expandRelatedResults(results, { limit = 8, query = "", queryAnalysis = analyzeQuery(query) } = {}) {
    const cap = Math.max(limit, limit * 3);
    const candidates = new Map();

    const addCandidate = (candidate) => {
      if (!candidate) return;
      const existing = candidates.get(candidate.id);
      if (!existing || compareExpandedResults(candidate, existing) < 0) {
        candidates.set(candidate.id, candidate);
      }
    };

    for (const result of this.graphSliceResults(results, { query, limit: cap, queryAnalysis })) {
      addCandidate(result);
    }

    const addLegacy = (result, { relatedTo = null, why = null, relationRank = 0 } = {}) => {
      if (!result) return;
      const candidate = relatedTo
        ? scoreRelatedResult(result, { relatedTo, why, relationRank: relationRank + 20, queryAnalysis })
        : { ...result, baseResult: true, role: result.role || "seed", reason: result.reason || result.why };
      addCandidate(candidate);
    };

    for (const result of results) addLegacy(result);

    for (const result of results) {
      const relatedChunks = this.relatedChunksForResult(result);
      for (const [index, related] of relatedChunks.entries()) {
        addLegacy(related.chunk, { relatedTo: result.id, why: related.why, relationRank: index });
      }
    }

    return [...candidates.values()]
      .sort(compareExpandedResults)
      .slice(0, cap)
      .map(({ baseResult, relatedRank, ...result }) => result);
  }

  graphSliceResults(baseResults, {
    query = "",
    limit = 24,
    seedSymbols,
    maxWalkDepth = 2,
    queryAnalysis = analyzeQuery(query),
  } = {}) {
    const candidates = new Map();
    const seedResultBySymbol = new Map();

    const add = (result) => {
      if (!result) return;
      const existing = candidates.get(result.id);
      if (!existing || compareExpandedResults(result, existing) < 0) {
        candidates.set(result.id, result);
      }
    };

    for (const result of baseResults) {
      const seed = {
        ...result,
        baseResult: true,
        role: result.role || "seed",
        reason: result.reason || result.why,
      };
      add(seed);
      if (result.symbol) seedResultBySymbol.set(result.symbol, seed);
    }

    const seeds = this.seedSymbolsForGraph(baseResults, seedSymbols);
    for (const seed of seeds) {
      if (!seedResultBySymbol.has(seed)) {
        seedResultBySymbol.set(seed, baseResults.find((result) => result.symbol === seed) || null);
      }
    }

    let relationRank = 0;
    for (const seed of seeds) {
      const seedResult = seedResultBySymbol.get(seed) || null;
      const seedScore = Number(seedResult?.score) || 0;

      for (const edge of this.symbolReferenceTargetEdges(seed)) {
        const definition = this.definitionChunkForSymbol(edge.target_symbol);
        if (!definition) continue;
        add(this.graphResult(definition, {
          role: "definition",
          why: `definition reached from ${seed}`,
          reason: `${seed} references ${edge.target_symbol} at ${edge.evidence_file_path}:${edge.evidence_line}`,
          relatedTo: seedResult?.id || null,
          seedSymbol: seed,
          relationRank: relationRank++,
          score: graphScore(seedScore, "definition"),
          queryAnalysis,
        }));
      }

      if (maxWalkDepth < 2) continue;
      for (const edge of this.symbolReferencedInFileEdges(seed)) {
        const usageChunk = this.chunkContaining(edge.target_file_path, edge.target_line || edge.evidence_line);
        add(this.graphResult(usageChunk, {
          role: "call-usage",
          why: `${seed} referenced in file`,
          reason: `${seed} referenced at ${edge.evidence_file_path}:${edge.evidence_line}`,
          relatedTo: seedResult?.id || null,
          seedSymbol: seed,
          relationRank: relationRank++,
          score: graphScore(seedScore, "call-usage"),
          queryAnalysis,
        }));

        for (const exported of this.exportedSymbolsForFile(edge.target_file_path)) {
          const definition = this.definitionChunkForSymbol(`${exported.kind}:${exported.name}`);
          if (!definition) continue;
          add(this.graphResult(definition, {
            role: "definition",
            why: `exported definition in file referencing ${seed}`,
            reason: `${seed} is used in ${edge.target_file_path}; ${exported.kind}:${exported.name} is exported there`,
            relatedTo: seedResult?.id || null,
            seedSymbol: seed,
            relationRank: relationRank++,
            score: graphScore(seedScore, "export-definition"),
            queryAnalysis,
          }));
        }
      }
    }

    return [...candidates.values()]
      .sort(compareExpandedResults)
      .slice(0, limit)
      .map(({ baseResult, relatedRank, ...result }) => result);
  }

  seedSymbolsForGraph(baseResults, explicitSeeds) {
    if (explicitSeeds?.length) return [...new Set(explicitSeeds.filter(Boolean))];
    const seeds = baseResults
      .filter((result) => result.symbol && Number(result.symbolScore) >= 0.55)
      .map((result) => result.symbol);
    if (seeds.length) return [...new Set(seeds)];
    return [...new Set(baseResults.filter((result) => result.symbol).slice(0, 2).map((result) => result.symbol))];
  }

  symbolReferenceTargetEdges(symbol) {
    const names = symbolSearchNames(symbol);
    if (!names.length) return [];
    const placeholders = names.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT *
      FROM graph_edges
      WHERE edge_type = 'symbol_references_symbol'
        AND source_symbol IN (${placeholders})
        AND target_symbol IS NOT NULL
      ORDER BY evidence_file_path, evidence_line
      LIMIT 12
    `).all(...names);
  }

  symbolReferencedInFileEdges(symbol) {
    const names = symbolSearchNames(symbol);
    if (!names.length) return [];
    const placeholders = names.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT *
      FROM graph_edges
      WHERE edge_type = 'symbol_referenced_in_file'
        AND source_symbol IN (${placeholders})
        AND target_file_path IS NOT NULL
      ORDER BY evidence_file_path, evidence_line
      LIMIT 12
    `).all(...names);
  }

  exportedSymbolsForFile(filePath) {
    return this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE file_path = ? AND exported = 1
      ORDER BY start_line
      LIMIT 12
    `).all(filePath);
  }

  definitionChunkForSymbol(symbol) {
    const names = symbolSearchNames(symbol);
    if (!names.length) return null;
    const placeholders = names.map(() => "?").join(", ");
    const row = this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE kind || ':' || name IN (${placeholders})
         OR name IN (${placeholders})
      ORDER BY exported DESC, start_line
      LIMIT 1
    `).get(...names, ...names);
    return row ? this.chunkContaining(row.file_path, row.start_line) : null;
  }

  graphResult(row, { role, why, reason, relatedTo, seedSymbol, relationRank, score, queryAnalysis }) {
    if (!row) return null;
    const result = formatRelatedResult(row, why);
    const symbolScore = symbolAwareScore(queryAnalysis, resultRowFromResult(result));
    return {
      ...result,
      role,
      reason,
      relatedTo,
      seedSymbol,
      relatedRank: relationRank,
      score: Number((score + 0.08 * symbolScore).toFixed(4)),
      symbolScore: Number(symbolScore.toFixed(4)),
      relationScore: 1,
    };
  }

  relatedChunksForResult(result) {
    const related = [];
    for (const chunk of this.neighborChunks(result)) {
      related.push({ chunk: formatRelatedResult(chunk, "same-file neighbor"), why: "same-file neighbor" });
    }

    for (const chunk of this.importTargetChunks(result.path)) {
      related.push({ chunk: formatRelatedResult(chunk, "import/export relationship"), why: "import/export relationship" });
    }

    for (const chunk of this.referenceChunks(result)) {
      related.push({ chunk: formatRelatedResult(chunk, "symbol reference"), why: "symbol reference" });
    }

    for (const chunk of this.testChunksForFile(result.path)) {
      related.push({ chunk: formatRelatedResult(chunk, "nearby test file"), why: "nearby test file" });
    }

    return related;
  }

  neighborChunks(result) {
    return this.db.prepare(`
      SELECT *
      FROM chunks
      WHERE file_path = ?
        AND id != ?
        AND (end_line < ? OR start_line > ?)
      ORDER BY ABS(start_line - ?) ASC
      LIMIT 2
    `).all(result.path, result.id, result.startLine, result.endLine, result.startLine);
  }

  importTargetChunks(filePath) {
    const indexedPaths = new Set(this.db.prepare("SELECT path FROM files").all().map((row) => row.path));
    const imports = this.db.prepare("SELECT * FROM imports WHERE file_path = ? LIMIT 12").all(filePath);
    const chunks = [];
    for (const entry of imports) {
      const targetPath = resolveImportPath(filePath, entry.source, indexedPaths);
      if (!targetPath) continue;
      chunks.push(...this.db.prepare("SELECT * FROM chunks WHERE file_path = ? ORDER BY start_line LIMIT 2").all(targetPath));
    }
    return chunks;
  }

  referenceChunks(result) {
    if (!result.symbol) return [];
    const names = symbolSearchNames(result.symbol).concat(symbolSearchNames(simpleSymbolName(result.symbol)));
    const uniqueNames = [...new Set(names)];
    const placeholders = uniqueNames.map(() => "?").join(", ");
    const refs = this.db.prepare(`
      SELECT *
      FROM symbol_references
      WHERE file_path != ?
        AND (name IN (${placeholders}) OR target_symbol IN (${placeholders}))
      ORDER BY file_path, line
      LIMIT 8
    `).all(result.path, ...uniqueNames, ...uniqueNames);
    return refs.map((ref) => this.chunkContaining(ref.file_path, ref.line)).filter(Boolean);
  }

  testChunksForFile(filePath) {
    const parsed = path.parse(filePath);
    const base = parsed.name.replace(/\.(test|spec)$/i, "");
    const rows = this.db.prepare(`
      SELECT *
      FROM chunks
      WHERE file_path != ?
        AND (file_path LIKE ? OR file_path LIKE ? OR file_path LIKE ?)
      ORDER BY file_path, start_line
      LIMIT 2
    `).all(filePath, `%${base}.test.%`, `%${base}.spec.%`, `%__tests__%${base}%`);
    return rows;
  }

  chunkContaining(filePath, line) {
    return this.db.prepare(`
      SELECT *
      FROM chunks
      WHERE file_path = ? AND start_line <= ? AND end_line >= ?
      ORDER BY (end_line - start_line) ASC
      LIMIT 1
    `).get(filePath, line, line);
  }

  formatReference(row) {
    const chunk = this.chunkContaining(row.file_path, row.line);
    return {
      filePath: row.file_path,
      name: row.name,
      targetSymbol: row.target_symbol,
      line: row.line,
      column: row.column,
      kind: row.kind,
      chunk: chunk ? {
        id: chunk.id,
        path: chunk.file_path,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        symbol: chunk.symbol,
        snippet: chunk.text,
      } : null,
    };
  }

  lexicalSearch(query, limit) {
    if (this.ftsEnabled) {
      const ftsQuery = tokenize(query).map((token) => `${token}*`).join(" OR ");
      if (ftsQuery) {
        try {
          return this.db.prepare(`
            SELECT c.*
            FROM chunks_fts f
            JOIN chunks c ON c.id = f.id
            WHERE chunks_fts MATCH ?
            ORDER BY bm25(chunks_fts)
            LIMIT ?
          `).all(ftsQuery, limit);
        } catch {
          // Fall through to LIKE-based search.
        }
      }
    }

    const terms = tokenize(query).slice(0, 8);
    if (!terms.length) return [];
    const where = terms.map(() => "(LOWER(text) LIKE ? OR LOWER(file_path) LIKE ? OR LOWER(COALESCE(symbol, '')) LIKE ?)").join(" OR ");
    const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`]);
    return this.db.prepare(`SELECT * FROM chunks WHERE ${where} LIMIT ?`).all(...params, limit);
  }

  embeddingMetadata() {
    const provider = this.getMeta("embedding_provider");
    const dims = Number(this.getMeta("embedding_dims"));
    if (!provider || !Number.isInteger(dims) || dims <= 0) return null;
    return { provider, dims };
  }

  setEmbeddingMetadata({ provider, dims }) {
    const setMeta = this.db.prepare(`
      INSERT INTO meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    setMeta.run("embedding_provider", provider);
    setMeta.run("embedding_dims", String(dims));
  }

  isSymbolIndexCurrent() {
    return this.getMeta("symbol_index_version") === SYMBOL_INDEX_VERSION;
  }

  setSymbolIndexCurrent() {
    const setMeta = this.db.prepare(`
      INSERT INTO meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    setMeta.run("symbol_index_version", SYMBOL_INDEX_VERSION);
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value || null;
  }

  fileCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM files").get().count;
  }

  chunkCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM chunks").get().count;
  }

  symbolCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM symbols").get().count;
  }

  referenceCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM symbol_references").get().count;
  }

  graphEdgeCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM graph_edges").get().count;
  }

  async prepareChunkRows(chunks) {
    const rows = [];
    for (const chunk of chunks) {
      const vector = await this.embeddingProvider.embed(`${chunk.filePath}\n${chunk.symbol || ""}\n${chunk.text}`);
      rows.push({
        chunk,
        vector,
        tokenCount: tokenize(chunk.text).length,
      });
    }
    return rows;
  }

  prepareChunkInsert() {
    return this.db.prepare(`
      INSERT INTO chunks(id, file_path, start_line, end_line, symbol, language, text, vector, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  prepareFtsInsert() {
    return this.ftsEnabled
      ? this.db.prepare("INSERT INTO chunks_fts(id, file_path, symbol, text) VALUES (?, ?, ?, ?)")
      : null;
  }

  prepareSymbolInsert() {
    return this.db.prepare(`
      INSERT INTO symbols(file_path, name, kind, start_line, end_line, exported, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  prepareImportInsert() {
    return this.db.prepare(`
      INSERT INTO imports(file_path, source, imported_name, local_name, line)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  prepareExportInsert() {
    return this.db.prepare(`
      INSERT INTO exports(file_path, name, local_name, line)
      VALUES (?, ?, ?, ?)
    `);
  }

  prepareReferenceInsert() {
    return this.db.prepare(`
      INSERT INTO symbol_references(file_path, name, target_symbol, line, column, kind)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  prepareGraphEdgeInsert() {
    return this.db.prepare(`
      INSERT INTO graph_edges(
        edge_type,
        source_file_path,
        source_symbol,
        source_line,
        target_file_path,
        target_symbol,
        target_line,
        evidence_file_path,
        evidence_line
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  prepareGraphEdgeDelete() {
    return this.db.prepare(`
      DELETE FROM graph_edges
      WHERE evidence_file_path = ?
         OR source_file_path = ?
         OR target_file_path = ?
    `);
  }

  insertChunkRows(rows, insertChunk, insertFts) {
    for (const { chunk, vector, tokenCount } of rows) {
      insertChunk.run(
        chunk.id,
        chunk.filePath,
        chunk.startLine,
        chunk.endLine,
        chunk.symbol,
        chunk.language,
        chunk.text,
        JSON.stringify(vector),
        tokenCount,
      );
      insertFts?.run(chunk.id, chunk.filePath, chunk.symbol || "", chunk.text);
    }
  }

  insertSymbolRows(symbolIndex, statements) {
    const index = symbolIndex || emptySymbolIndex();
    for (const symbol of index.definitions || []) {
      statements.insertSymbol.run(
        symbol.filePath,
        symbol.name,
        symbol.kind,
        symbol.startLine,
        symbol.endLine,
        symbol.exported ? 1 : 0,
        symbol.signature || "",
      );
    }
    for (const entry of index.imports || []) {
      statements.insertImport.run(entry.filePath, entry.source, entry.importedName, entry.localName, entry.line);
    }
    for (const entry of index.exports || []) {
      statements.insertExport.run(entry.filePath, entry.name, entry.localName, entry.line);
    }
    for (const entry of index.references || []) {
      statements.insertReference.run(
        entry.filePath,
        entry.name,
        entry.targetSymbol,
        entry.line,
        entry.column,
        entry.kind,
      );
    }
    this.insertGraphEdgeRows(index, statements.insertGraphEdge);
  }

  insertGraphEdgeRows(symbolIndex, insertGraphEdge) {
    if (!insertGraphEdge) return;
    const index = symbolIndex || emptySymbolIndex();
    const definitions = index.definitions || [];
    const importsByLocalName = new Map((index.imports || []).map((entry) => [entry.localName, entry]));

    const insert = (edge) => {
      insertGraphEdge.run(
        edge.edgeType,
        edge.sourceFilePath || null,
        edge.sourceSymbol || null,
        edge.sourceLine || null,
        edge.targetFilePath || null,
        edge.targetSymbol || null,
        edge.targetLine || null,
        edge.evidenceFilePath,
        edge.evidenceLine || 1,
      );
    };

    for (const symbol of definitions) {
      const fullSymbol = `${symbol.kind}:${symbol.name}`;
      insert({
        edgeType: "file_defines_symbol",
        sourceFilePath: symbol.filePath,
        sourceLine: symbol.startLine,
        targetFilePath: symbol.filePath,
        targetSymbol: fullSymbol,
        targetLine: symbol.startLine,
        evidenceFilePath: symbol.filePath,
        evidenceLine: symbol.startLine,
      });
      if (symbol.exported) {
        insert({
          edgeType: "file_exports_symbol",
          sourceFilePath: symbol.filePath,
          sourceLine: symbol.startLine,
          targetFilePath: symbol.filePath,
          targetSymbol: fullSymbol,
          targetLine: symbol.startLine,
          evidenceFilePath: symbol.filePath,
          evidenceLine: symbol.startLine,
        });
      }
    }

    for (const reference of index.references || []) {
      const imported = importsByLocalName.get(reference.name);
      if (imported && reference.line === imported.line) continue;
      const importedTarget = imported
        ? (imported.importedName === "default" || imported.importedName === "*" ? imported.localName : imported.importedName)
        : null;
      const targetSymbol = reference.targetSymbol || importedTarget;
      if (!targetSymbol) continue;
      const containing = containingDefinition(definitions, reference);
      const sourceSymbol = containing ? `${containing.kind}:${containing.name}` : null;
      if (sourceSymbol && sourceSymbol !== targetSymbol) {
        insert({
          edgeType: "symbol_references_symbol",
          sourceFilePath: reference.filePath,
          sourceSymbol,
          sourceLine: containing.startLine,
          targetSymbol,
          evidenceFilePath: reference.filePath,
          evidenceLine: reference.line,
        });
      }
      insert({
        edgeType: "symbol_referenced_in_file",
        sourceSymbol: targetSymbol,
        targetFilePath: reference.filePath,
        targetLine: reference.line,
        evidenceFilePath: reference.filePath,
        evidenceLine: reference.line,
      });
    }
  }
}

function containingDefinition(definitions, reference) {
  return definitions
    .filter((definition) => (
      definition.filePath === reference.filePath &&
      definition.startLine <= reference.line &&
      definition.endLine >= reference.line
    ))
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0] || null;
}

function emptySymbolIndex() {
  return { definitions: [], imports: [], exports: [], references: [] };
}

function combinedScore({ vectorScore, lexicalScore, symbolScore = 0, relationScore = 0, mode }) {
  if (mode === "lexical") return Math.max(lexicalScore, 0.9 * symbolScore + 0.1 * relationScore);
  if (mode === "vector") return vectorScore;
  if (mode !== "hybrid") throw new Error(`Unknown search mode: ${mode}`);
  return 0.55 * vectorScore + 0.3 * lexicalScore + 0.13 * symbolScore + 0.02 * relationScore;
}

function fallbackLexicalScore(query, row) {
  const haystack = `${row.file_path} ${row.symbol || ""} ${row.text}`.toLowerCase();
  const terms = new Set(tokenize(query));
  if (!terms.size) return 0;
  let hits = 0;
  for (const term of terms) {
    if (haystack.includes(term)) hits += 1;
  }
  return hits / terms.size;
}

function analyzeQuery(query) {
  const raw = String(query || "");
  const terms = tokenize(raw);
  const termSet = new Set(terms);
  const normalized = normalizeSymbolText(raw);
  const symbolLiterals = raw.match(/\b(?:class|function|method|export|type|enum):[A-Za-z0-9_.$]+/g) || [];
  return {
    raw,
    terms,
    termSet,
    normalized,
    symbolLiterals: symbolLiterals.map((item) => normalizeSymbolText(item)),
    relationHints: {
      import: termSet.has("import") || termSet.has("imports") || termSet.has("export") || termSet.has("exports"),
      reference: termSet.has("reference") || termSet.has("references") || termSet.has("caller") || termSet.has("callers"),
      test: termSet.has("test") || termSet.has("tests") || termSet.has("spec"),
      neighbor: termSet.has("nearby") || (termSet.has("same") && termSet.has("file")) || termSet.has("neighbor"),
    },
  };
}

function symbolAwareScore(queryAnalysis, row) {
  if (!row.symbol || !queryAnalysis.terms.length) return 0;
  const features = symbolFeatures(row.symbol);
  if (!features.tokens.length) return 0;

  const overlap = overlapScore(queryAnalysis.termSet, features.tokens);
  const simpleOverlap = overlapScore(queryAnalysis.termSet, features.simpleTokens);
  const ordered = orderedTokenCoverage(queryAnalysis.terms, features.simpleTokens);
  const leadingIntent = leadingIntentScore(queryAnalysis.terms, features.simpleTokens);
  const exact = exactSymbolScore(queryAnalysis, features);
  const textNameCoverage = nameMentionScore(queryAnalysis.termSet, row.text);
  const exportedBoost = features.kind === "export" ? 0.08 : 0;
  const kindBoost = queryAnalysis.termSet.has(features.kind) ? 0.12 : 0;
  const depthPenalty = nestedHelperPenalty(features);

  const score = Math.max(
    exact,
    leadingIntent,
    0.4 * simpleOverlap + 0.25 * ordered + 0.2 * overlap + 0.15 * textNameCoverage + exportedBoost + kindBoost,
  );
  return clamp01(score * depthPenalty);
}

function relationIntentScore(queryAnalysis, row) {
  if (!row.symbol && !row.text) return 0;
  const haystack = `${row.symbol || ""} ${row.text}`.toLowerCase();
  let score = 0;
  if (queryAnalysis.relationHints.import && /\b(import|export|resolveimport|target)\b/.test(haystack)) score += 0.3;
  if (queryAnalysis.relationHints.reference && /\b(reference|references|target_symbol|symbol_references)\b/.test(haystack)) score += 0.3;
  if (queryAnalysis.relationHints.test && /\b(test|spec|__tests__)\b/.test(haystack)) score += 0.2;
  if (queryAnalysis.relationHints.neighbor && /\b(neighbor|same-file|file_path)\b/.test(haystack)) score += 0.2;
  return clamp01(score);
}

function scoreRelatedResult(result, { relatedTo, why, relationRank, queryAnalysis }) {
  const row = resultRowFromResult(result);
  const symbolScore = symbolAwareScore(queryAnalysis, row);
  const relationScore = relationWhyScore(queryAnalysis, why);
  const sourceScore = Number(result.score) || 0;
  const relatedRank = 1 + relationRank;
  const rankDecay = Math.max(0, 0.04 - 0.005 * relationRank);
  const score = sourceScore * 0.88 + 0.18 * symbolScore + 0.12 * relationScore + rankDecay;
  const whyText = why || result.why;
  return {
    ...result,
    relatedTo,
    relatedRank,
    role: legacyRoleForWhy(why),
    reason: why || result.reason || result.why,
    why: symbolScore > 0.66 ? `${whyText}; symbol match` : whyText,
    score: Number(score.toFixed(4)),
    symbolScore: Number(Math.max(Number(result.symbolScore) || 0, symbolScore).toFixed(4)),
    relationScore: Number(Math.max(Number(result.relationScore) || 0, relationScore).toFixed(4)),
  };
}

function compareExpandedResults(a, b) {
  if (Boolean(b.baseResult) !== Boolean(a.baseResult)) return Number(b.baseResult) - Number(a.baseResult);
  const roleDelta = rolePriority(b.role) - rolePriority(a.role);
  if (roleDelta !== 0) return roleDelta;
  if (b.score !== a.score) return b.score - a.score;
  return (a.relatedRank || 0) - (b.relatedRank || 0);
}

function graphScore(seedScore, role) {
  const base = Number(seedScore) || 0;
  const boost = role === "definition" ? 0.1 : role === "call-usage" ? 0.08 : 0.04;
  return Number(Math.min(1.25, base + boost).toFixed(4));
}

function rolePriority(role) {
  switch (role) {
    case "seed": return 50;
    case "definition": return 40;
    case "call-usage": return 35;
    case "import-export": return 20;
    case "symbol-reference": return 18;
    case "test": return 12;
    case "same-file-neighbor": return 5;
    default: return 10;
  }
}

function legacyRoleForWhy(why) {
  if (why === "same-file neighbor") return "same-file-neighbor";
  if (why === "import/export relationship") return "import-export";
  if (why === "symbol reference") return "symbol-reference";
  if (why === "nearby test file") return "test";
  return "related";
}

function relationWhyScore(queryAnalysis, why) {
  const value = String(why || "");
  let score = 0;
  if (queryAnalysis.relationHints.import && value === "import/export relationship") score += 0.9;
  if (queryAnalysis.relationHints.reference && value === "symbol reference") score += 0.9;
  if (queryAnalysis.relationHints.test && value === "nearby test file") score += 0.75;
  if (queryAnalysis.relationHints.neighbor && value === "same-file neighbor") score += 0.65;
  return clamp01(score);
}

function resultRowFromResult(result) {
  return {
    id: result.id,
    file_path: result.path,
    start_line: result.startLine,
    end_line: result.endLine,
    symbol: result.symbol,
    language: result.language,
    text: result.snippet,
  };
}

function symbolFeatures(symbol) {
  const [kind, ...nameParts] = String(symbol || "").split(":");
  const name = nameParts.join(":");
  const segments = name.split(".").filter(Boolean);
  const simpleName = segments.at(-1) || name;
  return {
    kind: kind || "symbol",
    name,
    simpleName,
    segments,
    depth: segments.length,
    normalized: normalizeSymbolText(symbol),
    normalizedName: normalizeSymbolText(name),
    normalizedSimpleName: normalizeSymbolText(simpleName),
    tokens: tokenize(`${kind} ${name}`),
    simpleTokens: tokenize(simpleName),
  };
}

function exactSymbolScore(queryAnalysis, features) {
  if (
    queryAnalysis.symbolLiterals.includes(features.normalized)
    || queryAnalysis.normalized.includes(features.normalized)
    || queryAnalysis.normalized.includes(features.normalizedName)
  ) {
    return 1;
  }
  if (features.normalizedSimpleName && queryAnalysis.normalized.includes(features.normalizedSimpleName)) return 0.92;
  return 0;
}

function overlapScore(termSet, tokens) {
  const unique = [...new Set(tokens)];
  if (!unique.length || !termSet.size) return 0;
  let hits = 0;
  for (const token of unique) {
    if (termSet.has(token) || (token.endsWith("s") && termSet.has(token.slice(0, -1)))) hits += 1;
  }
  return hits / unique.length;
}

function orderedTokenCoverage(queryTerms, symbolTokens) {
  const uniqueSymbolTokens = [...new Set(symbolTokens)];
  if (!uniqueSymbolTokens.length || !queryTerms.length) return 0;
  let bestRun = 0;
  for (let i = 0; i < queryTerms.length; i += 1) {
    let run = 0;
    for (let j = 0; j < uniqueSymbolTokens.length && i + j < queryTerms.length; j += 1) {
      if (!tokensEquivalent(queryTerms[i + j], uniqueSymbolTokens[j])) break;
      run += 1;
    }
    bestRun = Math.max(bestRun, run);
  }
  return bestRun / uniqueSymbolTokens.length;
}

function leadingIntentScore(queryTerms, symbolTokens) {
  const uniqueSymbolTokens = [...new Set(symbolTokens)];
  if (queryTerms.length < 2 || uniqueSymbolTokens.length < 2) return 0;
  let matches = 0;
  for (let i = 0; i < Math.min(queryTerms.length, uniqueSymbolTokens.length); i += 1) {
    if (!tokensEquivalent(queryTerms[i], uniqueSymbolTokens[i])) break;
    matches += 1;
  }
  if (matches < 2) return 0;
  return Math.min(0.95, 0.58 + 0.14 * matches);
}

function nameMentionScore(termSet, text) {
  const textTerms = new Set(tokenize(text).slice(0, 80));
  let hits = 0;
  for (const term of termSet) {
    if (textTerms.has(term)) hits += 1;
  }
  return termSet.size ? hits / termSet.size : 0;
}

function nestedHelperPenalty(features) {
  if (features.depth <= 2) return 1;
  if (features.kind === "method") return 0.92;
  return Math.max(0.55, 1 - 0.16 * (features.depth - 2));
}

function tokensEquivalent(left, right) {
  return left === right || `${left}s` === right || left === `${right}s`;
}

function normalizeSymbolText(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function formatResult(row, score, vectorScore, lexicalScore, symbolScore = 0, relationScore = 0) {
  const why = explain(vectorScore, lexicalScore, symbolScore, relationScore);
  return {
    id: row.id,
    path: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbol: row.symbol,
    language: row.language,
    score: Number(score.toFixed(4)),
    vectorScore: Number(vectorScore.toFixed(4)),
    lexicalScore: Number(lexicalScore.toFixed(4)),
    symbolScore: Number(symbolScore.toFixed(4)),
    relationScore: Number(relationScore.toFixed(4)),
    why,
    role: "seed",
    reason: why,
    snippet: row.text,
  };
}

function formatRelatedResult(row, why) {
  return {
    id: row.id,
    path: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbol: row.symbol,
    language: row.language,
    score: 0,
    vectorScore: 0,
    lexicalScore: 0,
    symbolScore: 0,
    relationScore: 0,
    why,
    role: legacyRoleForWhy(why),
    reason: why,
    snippet: row.text,
  };
}

function formatSymbol(row) {
  return {
    filePath: row.file_path,
    name: row.name,
    kind: row.kind,
    startLine: row.start_line,
    endLine: row.end_line,
    exported: Boolean(row.exported),
    signature: row.signature,
  };
}

function explain(vectorScore, lexicalScore, symbolScore = 0, relationScore = 0) {
  if (symbolScore > 0.8) return "exact symbol match";
  if (symbolScore > 0.55 && lexicalScore > 0.33) return "symbol and lexical match";
  if (symbolScore > 0.55) return "symbol match";
  if (relationScore > 0.5 && lexicalScore > 0.33) return "relationship and lexical match";
  if (lexicalScore > 0.66 && vectorScore > 0.2) return "lexical and vector match";
  if (lexicalScore > 0.66) return "lexical match";
  if (vectorScore > 0.2) return "vector similarity";
  return "weak combined match";
}

function isDefaultEmbedding({ provider, dims }) {
  return provider === DEFAULT_EMBEDDING_PROVIDER && dims === DEFAULT_VECTOR_DIMS;
}
