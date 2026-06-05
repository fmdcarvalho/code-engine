#!/usr/bin/env node
import { runMcpServer } from "../src/mcp.js";

runMcpServer().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
