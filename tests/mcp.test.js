import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { indexRepo } from "../src/indexer.js";

test("MCP server exposes read-only context tools and searches an index", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-engine-mcp-test-"));
  const dbPath = path.join(tempDir, "index.sqlite");
  const repoPath = new URL("./fixtures/sample-repo", import.meta.url).pathname;
  await indexRepo({ repoPath, dbPath });

  const client = new Client({
    name: "context-engine-test-client",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["./bin/context-engine-mcp.js"],
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
  });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, ["codebase_search", "context_bundle", "index_repo", "index_status", "read_file", "reference_search"]);

    const response = await client.callTool({
      name: "codebase_search",
      arguments: {
        dbPath,
        query: "where is auth handled",
        limit: 1,
      },
    });
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.results[0].path, "src/auth.js");
    assert.equal(payload.status.embeddingProvider, "local-hash-v1");
    assert.equal(payload.status.embeddingDims, 384);

    const bundleResponse = await client.callTool({
      name: "context_bundle",
      arguments: {
        dbPath,
        query: "where is auth handled",
        maxChars: 700,
      },
    });
    const bundle = JSON.parse(bundleResponse.content[0].text);
    assert.ok(bundle.context.includes("src/auth.js"));
    assert.ok(bundle.usedChars <= 700);

    const statusResponse = await client.callTool({
      name: "index_status",
      arguments: { dbPath },
    });
    const status = JSON.parse(statusResponse.content[0].text);
    assert.equal(status.embeddingProvider, "local-hash-v1");
    assert.equal(status.embeddingDims, 384);
    assert.ok(status.symbols >= 6);

    const referencesResponse = await client.callTool({
      name: "reference_search",
      arguments: {
        dbPath,
        symbol: "authenticateUser",
      },
    });
    const references = JSON.parse(referencesResponse.content[0].text);
    assert.ok(references.definitions.some((entry) => entry.filePath === "src/auth.js"));
    assert.ok(references.references.some((entry) => entry.filePath === "src/session.js"));
  } finally {
    await client.close();
  }
});
