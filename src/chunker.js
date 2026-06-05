import { parse } from "@babel/parser";
import { collectTreeSitterJavaScriptSymbolBlocks } from "./tree-sitter-backend.js";

const LANGUAGE_BY_EXT = new Map([
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".py", "python"],
  [".md", "markdown"],
  [".mdx", "markdown"],
  [".json", "json"],
  [".css", "css"],
  [".html", "html"],
]);

export function languageForPath(filePath) {
  const match = filePath.match(/\.[^.]+$/);
  return match ? LANGUAGE_BY_EXT.get(match[0].toLowerCase()) || "text" : "text";
}

export function chunkFile({ filePath, text, maxLines = 80, overlapLines = 8 }) {
  const language = languageForPath(filePath);
  const lines = text.split(/\r?\n/);
  const symbolBlocks = isSymbolAwareLanguage(language) ? collectSymbolBlocks(lines, language) : [];
  const symbols = collectSymbols(lines, language, symbolBlocks);
  const chunks = [];

  if (isSymbolAwareLanguage(language)) {
    if (symbolBlocks.length) {
      const primaryBlocks = selectPrimarySymbolBlocks(symbolBlocks);
      let cursorLine = 1;
      for (const block of primaryBlocks) {
        appendLineChunks({
          chunks,
          filePath,
          language,
          lines,
          symbols,
          startLine: cursorLine,
          endLine: block.startLine - 1,
          maxLines,
          overlapLines,
        });
        appendLineChunks({
          chunks,
          filePath,
          language,
          lines,
          symbols,
          startLine: block.startLine,
          endLine: block.endLine,
          maxLines,
          overlapLines,
          symbol: `${block.kind}:${block.name}`,
        });
        appendNestedSymbolChunks({
          chunks,
          filePath,
          language,
          lines,
          symbols,
          symbolBlocks,
          parentBlock: block,
          maxLines,
          overlapLines,
        });
        cursorLine = block.endLine + 1;
      }
      appendLineChunks({
        chunks,
        filePath,
        language,
        lines,
        symbols,
        startLine: cursorLine,
        endLine: lines.length,
        maxLines,
        overlapLines,
      });
      return chunks;
    }
  }

  appendLineChunks({
    chunks,
    filePath,
    language,
    lines,
    symbols,
    startLine: 1,
    endLine: lines.length,
    maxLines,
    overlapLines,
  });

  return chunks;
}

export function collectSymbols(lines, language, symbolBlocks = null) {
  if (symbolBlocks) {
    return symbolBlocks
      .map((block) => ({
        name: block.name,
        kind: block.kind,
        line: block.startLine,
      }))
      .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  }

  const symbols = [];
  const patterns = symbolPatterns(language);

  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match) {
        symbols.push({
          name: match[pattern.group || 1] || "default",
          kind: pattern.kind,
          line: index + 1,
        });
        break;
      }
    }
  });

  return symbols;
}

function symbolPatterns(language) {
  if (language === "python") {
    return [
      { kind: "class", regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
      { kind: "function", regex: /^\s*async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
      { kind: "function", regex: /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    ];
  }
  if (language === "markdown") {
    return [{ kind: "heading", regex: /^(#{1,6})\s+(.+)$/, group: 2 }];
  }
  return [
    { kind: "class", regex: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)?/ },
    { kind: "function", regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/ },
    { kind: "function", regex: /^\s*(?:export\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]\s*(?:async\s*)?\(/ },
    { kind: "export", regex: /^\s*export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  ];
}

function isSymbolAwareLanguage(language) {
  return language === "javascript" || language === "typescript" || language === "python";
}

function appendLineChunks({
  chunks,
  filePath,
  language,
  lines,
  symbols,
  startLine,
  endLine,
  maxLines,
  overlapLines,
  symbol,
}) {
  if (startLine > endLine) return;

  let cursor = startLine;
  while (cursor <= endLine) {
    const chunkEndLine = Math.min(endLine, cursor + maxLines - 1);
    appendChunk({
      chunks,
      filePath,
      language,
      lines,
      startLine: cursor,
      endLine: chunkEndLine,
      symbol: symbol || nearestSymbol(symbols, cursor),
    });
    if (chunkEndLine === endLine) break;
    cursor = Math.max(chunkEndLine - overlapLines + 1, cursor + 1);
  }
}

function appendChunk({ chunks, filePath, language, lines, startLine, endLine, symbol }) {
  const chunkText = lines.slice(startLine - 1, endLine).join("\n").trim();
  if (!chunkText) return;

  chunks.push({
    id: chunkId(filePath, startLine, endLine, chunkText),
    filePath,
    language,
    startLine,
    endLine,
    symbol,
    text: chunkText,
  });
}

function collectSymbolBlocks(lines, language) {
  const blocks = language === "python"
    ? collectPythonSymbolBlocks(lines)
    : collectJavaScriptSymbolBlocks(lines, language);

  return blocks
    .filter((block) => block.startLine <= block.endLine)
    .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine || a.name.localeCompare(b.name));
}

function selectPrimarySymbolBlocks(blocks) {
  const sorted = blocks
    .slice()
    .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine || a.name.localeCompare(b.name));
  const selected = [];
  let coveredUntil = 0;

  for (const block of sorted) {
    if (block.startLine <= coveredUntil) continue;
    selected.push(block);
    coveredUntil = block.endLine;
  }

  return selected;
}

function appendNestedSymbolChunks({
  chunks,
  filePath,
  language,
  lines,
  symbols,
  symbolBlocks,
  parentBlock,
  maxLines,
  overlapLines,
}) {
  const nestedBlocks = symbolBlocks.filter((block) => (
    block !== parentBlock &&
    block.startLine >= parentBlock.startLine &&
    block.endLine <= parentBlock.endLine &&
    (block.startLine !== parentBlock.startLine || block.endLine !== parentBlock.endLine)
  ));

  for (const block of nestedBlocks) {
    appendLineChunks({
      chunks,
      filePath,
      language,
      lines,
      symbols,
      startLine: block.startLine,
      endLine: block.endLine,
      maxLines,
      overlapLines,
      symbol: `${block.kind}:${block.name}`,
    });
  }
}

function collectPythonSymbolBlocks(lines) {
  const rawBlocks = [];

  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)(?:(async)\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!match) return;

    const indent = indentationWidth(match[1]);
    const startIndex = includeDecorators(lines, index, indent);
    const endIndex = findPythonBlockEnd(lines, index, indent);
    rawBlocks.push({
      kind: match[3] === "class" ? "class" : "function",
      name: match[4],
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      indent,
    });
  });

  return rawBlocks.map((block) => {
    if (block.kind !== "function") return block;
    const parent = nearestContainingPythonBlock(rawBlocks, block);
    if (parent?.kind === "class") {
      return { ...block, name: `${parent.name}.${block.name}` };
    }
    if (parent?.kind === "function") {
      return { ...block, name: `${parent.name}.${block.name}` };
    }
    return block;
  });
}

function nearestContainingPythonBlock(blocks, target) {
  return blocks
    .filter((block) => (
      block !== target &&
      block.startLine <= target.startLine &&
      block.endLine >= target.endLine &&
      block.indent < target.indent
    ))
    .sort((a, b) => b.indent - a.indent || b.startLine - a.startLine)[0] || null;
}

function collectJavaScriptSymbolBlocks(lines, language) {
  if (preferredJavaScriptParser() !== "babel") {
    const treeSitterBlocks = collectTreeSitterJavaScriptSymbolBlocks({
      text: lines.join("\n"),
      language,
    });
    if (treeSitterBlocks) return treeSitterBlocks;
  }
  const parsedBlocks = collectJavaScriptSymbolBlocksWithParser(lines);
  if (parsedBlocks) return parsedBlocks;
  return collectJavaScriptSymbolBlocksWithLineScanner(lines);
}

export function preferredJavaScriptParser() {
  const value = process.env.CONTEXT_ENGINE_JS_PARSER?.toLowerCase();
  if (value === "babel") return "babel";
  return "tree-sitter";
}

function collectJavaScriptSymbolBlocksWithLineScanner(lines) {
  const blocks = [];

  lines.forEach((line, index) => {
    const symbol = javaScriptSymbolForLine(line);
    if (!symbol) return;

    const leadingIndent = line.match(/^\s*/)?.[0] || "";
    const startIndex = includeDecorators(lines, index, leadingIndent.length);
    const endIndex = findJavaScriptBlockEnd(lines, index);
    blocks.push({
      ...symbol,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
    });
  });

  return blocks;
}

function collectJavaScriptSymbolBlocksWithParser(lines) {
  let ast;
  try {
    ast = parse(lines.join("\n"), {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: [
        "decorators-legacy",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "exportDefaultFrom",
        "importMeta",
        "jsx",
        "topLevelAwait",
        "typescript",
      ],
    });
  } catch {
    return null;
  }

  if (ast.errors?.length) return null;

  const blocks = [];
  for (const statement of ast.program.body) {
    collectJavaScriptStatementBlocks(statement, { blocks, scope: [], fullNode: statement });
  }
  return blocks;
}

function collectJavaScriptStatementBlocks(node, context) {
  if (!node) return;

  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    collectJavaScriptExportBlocks(node, context);
    return;
  }

  if (node.type === "FunctionDeclaration") {
    collectJavaScriptFunctionDeclarationBlock(node, context);
    return;
  }

  if (node.type === "ClassDeclaration") {
    collectJavaScriptClassBlock(node, context);
    return;
  }

  if (node.type === "VariableDeclaration") {
    collectJavaScriptVariableBlocks(node, context);
    return;
  }

  if (node.type === "TSInterfaceDeclaration" || node.type === "TSTypeAliasDeclaration" || node.type === "TSEnumDeclaration") {
    addJavaScriptBlock(context.blocks, {
      kind: node.type === "TSEnumDeclaration" ? "enum" : "type",
      name: node.id?.name || "default",
      node: context.fullNode || node,
    });
  }
}

function collectJavaScriptExportBlocks(node, context) {
  const declaration = node.declaration;
  if (!declaration) {
    for (const specifier of node.specifiers || []) {
      const name = specifier.exported?.name || specifier.local?.name;
      if (name) addJavaScriptBlock(context.blocks, { kind: "export", name, node });
    }
    return;
  }

  if (
    declaration.type === "FunctionDeclaration" ||
    declaration.type === "ClassDeclaration" ||
    declaration.type === "VariableDeclaration" ||
    declaration.type === "TSInterfaceDeclaration" ||
    declaration.type === "TSTypeAliasDeclaration" ||
    declaration.type === "TSEnumDeclaration"
  ) {
    collectJavaScriptStatementBlocks(declaration, { ...context, fullNode: node });
    return;
  }

  const name = declaration.id?.name || "default";
  const kind = declaration.type === "ClassExpression" ? "class" : "function";
  addJavaScriptBlock(context.blocks, { kind, name, node });
  collectJavaScriptNestedBlocks(declaration, { ...context, scope: [...context.scope, name] });
}

function collectJavaScriptFunctionDeclarationBlock(node, context) {
  const name = node.id?.name || "default";
  const scopedName = scopedJavaScriptName(context.scope, name);
  addJavaScriptBlock(context.blocks, {
    kind: "function",
    name: scopedName,
    node: context.fullNode || node,
  });
  collectJavaScriptNestedBlocks(node, { ...context, scope: [...context.scope, name] });
}

function collectJavaScriptClassBlock(node, context) {
  const name = node.id?.name || "default";
  const scopedName = scopedJavaScriptName(context.scope, name);
  addJavaScriptBlock(context.blocks, {
    kind: "class",
    name: scopedName,
    node: context.fullNode || node,
  });
  collectJavaScriptClassMemberBlocks(node, { ...context, scope: [...context.scope, name] });
}

function collectJavaScriptVariableBlocks(node, context) {
  for (const declaration of node.declarations || []) {
    const name = javaScriptPatternName(declaration.id);
    if (!name) continue;

    const fullNode = node.declarations.length === 1 ? (context.fullNode || node) : declaration;
    if (isJavaScriptFunctionExpression(declaration.init)) {
      const scopedName = scopedJavaScriptName(context.scope, name);
      addJavaScriptBlock(context.blocks, { kind: "function", name: scopedName, node: fullNode });
      collectJavaScriptNestedBlocks(declaration.init, { ...context, scope: [...context.scope, name] });
      continue;
    }

    if (declaration.init?.type === "ClassExpression") {
      const scopedName = scopedJavaScriptName(context.scope, name);
      addJavaScriptBlock(context.blocks, { kind: "class", name: scopedName, node: fullNode });
      collectJavaScriptClassMemberBlocks(declaration.init, { ...context, scope: [...context.scope, name] });
      continue;
    }

    if (context.fullNode && context.fullNode.type.startsWith("Export")) {
      addJavaScriptBlock(context.blocks, { kind: "export", name, node: fullNode });
    }

    if (declaration.init?.type === "ObjectExpression") {
      collectJavaScriptObjectMemberBlocks(declaration.init, { ...context, scope: [...context.scope, name] });
    }
  }
}

function collectJavaScriptClassMemberBlocks(node, context) {
  for (const member of node.body?.body || []) {
    const name = javaScriptKeyName(member.key);
    if (!name) continue;

    if (member.type === "ClassMethod" || member.type === "ClassPrivateMethod") {
      const scopedName = scopedJavaScriptName(context.scope, name);
      addJavaScriptBlock(context.blocks, { kind: "method", name: scopedName, node: member });
      collectJavaScriptNestedBlocks(member, { ...context, scope: [...context.scope, name] });
      continue;
    }

    if (isJavaScriptFunctionExpression(member.value)) {
      const scopedName = scopedJavaScriptName(context.scope, name);
      addJavaScriptBlock(context.blocks, { kind: "method", name: scopedName, node: member });
      collectJavaScriptNestedBlocks(member.value, { ...context, scope: [...context.scope, name] });
    }
  }
}

function collectJavaScriptObjectMemberBlocks(node, context) {
  for (const property of node.properties || []) {
    const name = javaScriptKeyName(property.key);
    if (!name) continue;

    if (property.type === "ObjectMethod") {
      const scopedName = scopedJavaScriptName(context.scope, name);
      addJavaScriptBlock(context.blocks, { kind: "method", name: scopedName, node: property });
      collectJavaScriptNestedBlocks(property, { ...context, scope: [...context.scope, name] });
      continue;
    }

    if (isJavaScriptFunctionExpression(property.value)) {
      const scopedName = scopedJavaScriptName(context.scope, name);
      addJavaScriptBlock(context.blocks, { kind: "method", name: scopedName, node: property });
      collectJavaScriptNestedBlocks(property.value, { ...context, scope: [...context.scope, name] });
    }
  }
}

function collectJavaScriptNestedBlocks(node, context) {
  for (const statement of node.body?.body || []) {
    collectJavaScriptStatementBlocks(statement, { ...context, fullNode: statement });
  }
}

function addJavaScriptBlock(blocks, { kind, name, node }) {
  if (!node?.loc) return;
  blocks.push({
    kind,
    name,
    startLine: node.loc.start.line,
    endLine: node.loc.end.line,
  });
}

function isJavaScriptFunctionExpression(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function scopedJavaScriptName(scope, name) {
  return [...scope, name].filter(Boolean).join(".");
}

function javaScriptPatternName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ObjectPattern" || node.type === "ArrayPattern") return null;
  return null;
}

function javaScriptKeyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateName") return `#${node.id?.name || "private"}`;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
  return null;
}

function javaScriptSymbolForLine(line) {
  const trimmed = line.trimStart();
  let match = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (match) return { kind: "class", name: match[1] };

  match = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)?/);
  if (match) return { kind: "function", name: match[1] || "default" };

  match = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?function\b/);
  if (match) return { kind: "function", name: match[1] };

  match = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/);
  if (match) return { kind: "function", name: match[1] };

  match = trimmed.match(/^export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (match) return { kind: "export", name: match[1] };

  match = trimmed.match(/^export\s+default\b/);
  if (match) return { kind: "export", name: "default" };

  return null;
}

function includeDecorators(lines, symbolIndex, indentWidth) {
  let startIndex = symbolIndex;
  for (let index = symbolIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.trim() === "") break;
    if (indentationWidth(line.match(/^\s*/)?.[0] || "") !== indentWidth) break;
    if (!line.trimStart().startsWith("@")) break;
    startIndex = index;
  }
  return startIndex;
}

function findPythonBlockEnd(lines, startIndex, startIndent) {
  let endIndex = startIndex;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) continue;
    const indent = indentationWidth(line.match(/^\s*/)?.[0] || "");
    if (indent <= startIndent) return endIndex;
    endIndex = index;
  }

  return endIndex;
}

function findJavaScriptBlockEnd(lines, startIndex) {
  let braceDepth = 0;
  let sawBrace = false;
  let inBlockComment = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    if (index > startIndex && !sawBrace && javaScriptSymbolForLine(lines[index])) {
      return index - 1;
    }

    const scrubbed = scrubJavaScriptLine(lines[index], { inBlockComment });
    inBlockComment = scrubbed.inBlockComment;
    const code = scrubbed.code;

    for (const char of code) {
      if (char === "{") {
        braceDepth += 1;
        sawBrace = true;
      } else if (char === "}") {
        braceDepth -= 1;
      }
    }

    if (sawBrace && braceDepth <= 0) return index;
    if (!sawBrace && code.trim().endsWith(";")) return index;
    if (index > startIndex && !sawBrace && code.trim() === "") return index - 1;
  }

  return sawBrace ? lines.length - 1 : startIndex;
}

function scrubJavaScriptLine(line, state) {
  let code = "";
  let inString = null;
  let escaped = false;
  let inBlockComment = state.inBlockComment;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      code += " ";
      continue;
    }

    if (char === "/" && next === "/") break;
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      inString = char;
      code += " ";
      continue;
    }

    code += char;
  }

  return { code, inBlockComment };
}

function isBlankOrComment(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function indentationWidth(value) {
  let width = 0;
  for (const char of value) {
    width += char === "\t" ? 4 : 1;
  }
  return width;
}

function nearestSymbol(symbols, line) {
  let selected = null;
  for (const symbol of symbols) {
    if (symbol.line > line) break;
    selected = symbol;
  }
  return selected ? `${selected.kind}:${selected.name}` : null;
}

function chunkId(filePath, startLine, endLine, text) {
  return `${filePath}:${startLine}-${endLine}:${shortHash(text)}`;
}

function shortHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
