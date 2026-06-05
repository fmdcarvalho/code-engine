import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildContextBundle, indexRepo, indexStatus, searchIndex, searchReferences, defaultDbPath } from "./indexer.js";
import { readCodeFile } from "./scanner.js";

export async function runMcpServer() {
  const server = new McpServer({
    name: "kestrel-context-engine",
    version: "0.1.0",
  });

  server.registerTool(
    "index_repo",
    {
      title: "Index repository",
      description: "Index a local repository into the context-engine SQLite vector store.",
      inputSchema: {
        repoPath: z.string().describe("Repository path to index."),
        dbPath: z.string().optional().describe("Optional SQLite DB path."),
        embeddingProvider: z.string().optional().describe("Embedding provider name. Defaults to local-hash-v1."),
        embeddingModel: z.string().optional().describe("Embedding model for providers that require one, such as ollama or openai-compatible."),
        embeddingBaseUrl: z.string().optional().describe("Embedding provider base URL for local or OpenAI-compatible HTTP adapters."),
        embeddingDims: z.number().int().min(1).optional().describe("Embedding vector dimensions for the selected provider."),
        include: z.array(z.string()).optional().describe("Optional conservative include globs. Narrows eligible files; does not force ignored files back in."),
        exclude: z.array(z.string()).optional().describe("Optional exclude globs applied after default and .gitignore rules."),
      },
    },
    async ({ repoPath, dbPath, embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims, include, exclude }) => {
      const result = await indexRepo({
        repoPath,
        dbPath: dbPath || defaultDbPath(repoPath),
        embeddingProvider: embeddingOptions({ embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }),
        include,
        exclude,
      });
      return jsonResult(result);
    },
  );

  server.registerTool(
    "codebase_search",
    {
      title: "Search codebase context",
      description: "Retrieve ranked code snippets for a natural-language or keyword query.",
      inputSchema: {
        query: z.string(),
        dbPath: z.string().describe("SQLite index path."),
        limit: z.number().int().min(1).max(25).optional(),
        mode: z.enum(["lexical", "vector", "hybrid"]).optional().describe("Ranking mode. Defaults to hybrid."),
        expandRelated: z.boolean().optional().describe("Expand top hits with related same-file, import, reference, and test chunks."),
        embeddingProvider: z.string().optional().describe("Embedding provider name. Defaults to local-hash-v1."),
        embeddingModel: z.string().optional().describe("Embedding model for providers that require one, such as ollama or openai-compatible."),
        embeddingBaseUrl: z.string().optional().describe("Embedding provider base URL for local or OpenAI-compatible HTTP adapters."),
        embeddingDims: z.number().int().min(1).optional().describe("Embedding vector dimensions for the selected provider."),
      },
    },
    async ({ query, dbPath, limit = 8, mode = "hybrid", expandRelated = false, embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }) => jsonResult(await searchIndex({
      dbPath,
      query,
      limit,
      mode,
      expandRelated,
      embeddingProvider: embeddingOptions({ embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }),
    })),
  );

  server.registerTool(
    "context_bundle",
    {
      title: "Build context bundle",
      description: "Return a prompt-ready bundle of ranked snippets under a character budget.",
      inputSchema: {
        query: z.string(),
        dbPath: z.string().describe("SQLite index path."),
        limit: z.number().int().min(1).max(25).optional(),
        maxChars: z.number().int().min(500).max(50000).optional(),
        expandRelated: z.boolean().optional().describe("Whether to expand top hits with related chunks. Defaults to true."),
        embeddingProvider: z.string().optional().describe("Embedding provider name. Defaults to local-hash-v1."),
        embeddingModel: z.string().optional().describe("Embedding model for providers that require one, such as ollama or openai-compatible."),
        embeddingBaseUrl: z.string().optional().describe("Embedding provider base URL for local or OpenAI-compatible HTTP adapters."),
        embeddingDims: z.number().int().min(1).optional().describe("Embedding vector dimensions for the selected provider."),
      },
    },
    async ({ query, dbPath, limit = 8, maxChars = 12000, expandRelated = true, embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }) => jsonResult(await buildContextBundle({
      dbPath,
      query,
      limit,
      maxChars,
      expandRelated,
      embeddingProvider: embeddingOptions({ embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }),
    })),
  );

  server.registerTool(
    "reference_search",
    {
      title: "Search symbol references",
      description: "Find definitions and conservative references for a symbol in an indexed repository.",
      inputSchema: {
        symbol: z.string().describe("Symbol name, such as authenticateUser or function:authenticateUser."),
        dbPath: z.string().describe("SQLite index path."),
        limit: z.number().int().min(1).max(100).optional(),
        embeddingProvider: z.string().optional().describe("Embedding provider name. Defaults to local-hash-v1."),
        embeddingModel: z.string().optional().describe("Embedding model for providers that require one, such as ollama or openai-compatible."),
        embeddingBaseUrl: z.string().optional().describe("Embedding provider base URL for local or OpenAI-compatible HTTP adapters."),
        embeddingDims: z.number().int().min(1).optional().describe("Embedding vector dimensions for the selected provider."),
      },
    },
    async ({ symbol, dbPath, limit = 25, embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }) => jsonResult(searchReferences({
      dbPath,
      symbol,
      limit,
      embeddingProvider: embeddingOptions({ embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }),
    })),
  );

  server.registerTool(
    "index_status",
    {
      title: "Index status",
      description: "Return indexed file/chunk counts for a context-engine DB.",
      inputSchema: {
        dbPath: z.string().describe("SQLite index path."),
        embeddingProvider: z.string().optional().describe("Embedding provider name. Defaults to local-hash-v1."),
        embeddingModel: z.string().optional().describe("Embedding model for providers that require one, such as ollama or openai-compatible."),
        embeddingBaseUrl: z.string().optional().describe("Embedding provider base URL for local or OpenAI-compatible HTTP adapters."),
        embeddingDims: z.number().int().min(1).optional().describe("Embedding vector dimensions for the selected provider."),
      },
    },
    async ({ dbPath, embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }) => jsonResult(indexStatus({
      dbPath,
      embeddingProvider: embeddingOptions({ embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }),
    })),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read indexed repository file",
      description: "Read a UTF-8 file under a repository root. Refuses paths outside the root.",
      inputSchema: {
        repoPath: z.string(),
        filePath: z.string(),
      },
    },
    async ({ repoPath, filePath }) => {
      const text = await readCodeFile(repoPath, filePath);
      return { content: [{ type: "text", text }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function embeddingOptions({ embeddingProvider, embeddingModel, embeddingBaseUrl, embeddingDims }) {
  if (!embeddingProvider && !embeddingModel && !embeddingBaseUrl && !embeddingDims) return undefined;
  return {
    provider: embeddingProvider,
    model: embeddingModel,
    baseUrl: embeddingBaseUrl,
    dims: embeddingDims,
  };
}
