import path from "node:path";
import { parse } from "@babel/parser";
import { languageForPath, preferredJavaScriptParser } from "./chunker.js";
import { tokenize } from "./embedding.js";
import { parseTreeSitterJavaScript } from "./tree-sitter-backend.js";

export function buildSymbolIndex({ filePath, text, chunks }) {
  const language = languageForPath(filePath);
  const lines = text.split(/\r?\n/);
  const chunkDefinitions = definitionsFromChunks({ filePath, lines, chunks });
  const parsed = parseFileSymbols({ filePath, text, language });
  const exports = new Set(parsed.exports.map((entry) => entry.name));
  const definitions = mergeDefinitions(chunkDefinitions, parsed.definitions, exports);

  return {
    definitions,
    imports: parsed.imports,
    exports: parsed.exports,
    references: linkReferences(parsed.references, definitions),
  };
}

export function simpleSymbolName(value) {
  const name = String(value || "").replace(/^[a-z]+:/i, "");
  return name.split(".").at(-1) || name;
}

export function symbolSearchNames(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const withoutKind = raw.replace(/^[a-z]+:/i, "");
  return [...new Set([raw, withoutKind, simpleSymbolName(withoutKind)].filter(Boolean))];
}

function definitionsFromChunks({ filePath, lines, chunks }) {
  return chunks
    .filter((chunk) => chunk.symbol)
    .map((chunk) => {
      const [kind, ...nameParts] = String(chunk.symbol).split(":");
      const name = nameParts.join(":");
      return {
        filePath,
        name,
        kind: kind || "symbol",
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        exported: false,
        signature: firstCodeLine(lines, chunk.startLine, chunk.endLine),
      };
    });
}

function parseFileSymbols({ filePath, text, language }) {
  if (language === "javascript" || language === "typescript") {
    return parseJavaScriptFile({ filePath, text });
  }
  return parseTextFile({ filePath, text });
}

function parseJavaScriptFile({ filePath, text }) {
  if (preferredJavaScriptParser() !== "babel") {
    const parsed = parseTreeSitterJavaScript({
      filePath,
      text,
      language: languageForPath(filePath),
    });
    if (parsed) return parsed;
  }
  return parseJavaScriptFileWithBabel({ filePath, text });
}

function parseJavaScriptFileWithBabel({ filePath, text }) {
  let ast;
  try {
    ast = parse(text, {
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
    return parseTextFile({ filePath, text });
  }
  if (ast.errors?.length) return parseTextFile({ filePath, text });

  const state = {
    filePath,
    definitions: [],
    imports: [],
    exports: [],
    references: [],
    scope: [],
  };

  for (const statement of ast.program.body || []) {
    collectTopLevelStatement(statement, state);
  }
  collectIdentifierReferences(ast.program, state);

  return {
    definitions: uniqueByDefinition(state.definitions),
    imports: uniqueByImport(state.imports),
    exports: uniqueByExport(state.exports),
    references: uniqueByReference(state.references),
  };
}

function collectTopLevelStatement(node, state) {
  if (!node) return;

  if (node.type === "ImportDeclaration") {
    for (const specifier of node.specifiers || []) {
      state.imports.push({
        filePath: state.filePath,
        source: node.source?.value || "",
        importedName: importedSpecifierName(specifier),
        localName: specifier.local?.name || importedSpecifierName(specifier),
        line: node.loc?.start?.line || 1,
      });
    }
    return;
  }

  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    collectExport(node, state);
    if (node.declaration) collectDeclaration(node.declaration, { ...state, exported: true });
    return;
  }

  collectDeclaration(node, state);
}

function collectExport(node, state) {
  if (node.declaration) {
    for (const name of declarationNames(node.declaration)) {
      state.exports.push({
        filePath: state.filePath,
        name,
        localName: name,
        line: node.loc?.start?.line || 1,
      });
    }
    if (node.type === "ExportDefaultDeclaration" && !declarationNames(node.declaration).length) {
      state.exports.push({
        filePath: state.filePath,
        name: "default",
        localName: "default",
        line: node.loc?.start?.line || 1,
      });
    }
    return;
  }

  for (const specifier of node.specifiers || []) {
    const name = specifier.exported?.name || specifier.exported?.value || specifier.local?.name;
    const localName = specifier.local?.name || name;
    if (name) {
      state.exports.push({
        filePath: state.filePath,
        name,
        localName,
        line: specifier.loc?.start?.line || node.loc?.start?.line || 1,
      });
    }
  }
}

function collectDeclaration(node, state) {
  if (!node) return;
  if (node.type === "FunctionDeclaration") {
    addDefinition(state, "function", node.id?.name || "default", node);
    collectNestedDeclarations(node.body, { ...state, scope: scoped(state.scope, node.id?.name) });
    return;
  }
  if (node.type === "ClassDeclaration") {
    const className = node.id?.name || "default";
    addDefinition(state, "class", className, node);
    for (const member of node.body?.body || []) {
      const name = keyName(member.key);
      if (!name) continue;
      if (member.type === "ClassMethod" || member.type === "ClassPrivateMethod" || isFunctionExpression(member.value)) {
        addDefinition({ ...state, scope: [className] }, "method", name, member);
        collectNestedDeclarations(member.body || member.value?.body, { ...state, scope: [className, name] });
      }
    }
    return;
  }
  if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations || []) {
      const name = patternName(declaration.id);
      if (!name) continue;
      if (isFunctionExpression(declaration.init)) {
        addDefinition(state, "function", name, declaration);
        collectNestedDeclarations(declaration.init.body, { ...state, scope: scoped(state.scope, name) });
      } else if (declaration.init?.type === "ClassExpression") {
        addDefinition(state, "class", name, declaration);
      } else if (declaration.init?.type === "ObjectExpression") {
        if (state.exported) addDefinition(state, "export", name, declaration);
        for (const property of declaration.init.properties || []) {
          const memberName = keyName(property.key);
          if (!memberName) continue;
          if (property.type === "ObjectMethod" || isFunctionExpression(property.value)) {
            addDefinition({ ...state, scope: scoped(state.scope, name) }, "method", memberName, property);
            collectNestedDeclarations(property.body || property.value?.body, { ...state, scope: scoped(state.scope, name, memberName) });
          }
        }
      } else if (state.exported) {
        addDefinition(state, "export", name, declaration);
      }
    }
    return;
  }
  if (node.type === "TSInterfaceDeclaration" || node.type === "TSTypeAliasDeclaration" || node.type === "TSEnumDeclaration") {
    addDefinition(state, node.type === "TSEnumDeclaration" ? "enum" : "type", node.id?.name || "default", node);
  }
}

function collectNestedDeclarations(body, state) {
  for (const statement of body?.body || []) {
    collectDeclaration(statement, state);
  }
}

function collectIdentifierReferences(node, state, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type === "Identifier" && !isDefinitionIdentifier(node, parent)) {
    state.references.push({
      filePath: state.filePath,
      name: node.name,
      line: node.loc?.start?.line || 1,
      column: node.loc?.start?.column || 0,
      kind: "identifier",
      targetSymbol: null,
    });
  }

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) collectIdentifierReferences(child, state, node);
    } else if (value && typeof value === "object") {
      collectIdentifierReferences(value, state, node);
    }
  }
}

function isDefinitionIdentifier(node, parent) {
  if (!parent) return false;
  if (parent.id === node && /Declaration$/.test(parent.type)) return true;
  if (parent.key === node && !parent.computed) return true;
  if (parent.local === node && parent.type?.startsWith("Import")) return true;
  return parent.type === "VariableDeclarator" && parent.id === node;
}

function parseTextFile({ filePath, text }) {
  const references = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const token of tokenize(line)) {
      references.push({
        filePath,
        name: token,
        line: index + 1,
        column: Math.max(0, line.toLowerCase().indexOf(token)),
        kind: "token",
        targetSymbol: null,
      });
    }
  });
  return { definitions: [], imports: [], exports: [], references: uniqueByReference(references) };
}

function mergeDefinitions(primary, parsed, exports) {
  const byKey = new Map();
  for (const definition of parsed.concat(primary)) {
    const key = `${definition.filePath}:${definition.kind}:${definition.name}:${definition.startLine}`;
    byKey.set(key, {
      ...definition,
      exported: Boolean(definition.exported || exports.has(definition.name) || exports.has(simpleSymbolName(definition.name))),
    });
  }
  return [...byKey.values()].sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
}

function linkReferences(references, definitions) {
  const bySimple = new Map();
  for (const definition of definitions) {
    bySimple.set(simpleSymbolName(definition.name), `${definition.kind}:${definition.name}`);
  }
  return references.map((reference) => ({
    ...reference,
    targetSymbol: bySimple.get(reference.name) || null,
  }));
}

function addDefinition(state, kind, name, node) {
  const scopedName = scoped(state.scope, name).join(".");
  state.definitions.push({
    filePath: state.filePath,
    name: scopedName,
    kind,
    startLine: node.loc?.start?.line || 1,
    endLine: node.loc?.end?.line || node.loc?.start?.line || 1,
    exported: Boolean(state.exported),
    signature: nodeSignature(node),
  });
}

function declarationNames(node) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return [node.id?.name].filter(Boolean);
  if (node.type === "VariableDeclaration") return node.declarations.map((declaration) => patternName(declaration.id)).filter(Boolean);
  if (node.id?.name) return [node.id.name];
  return [];
}

function importedSpecifierName(specifier) {
  if (specifier.type === "ImportDefaultSpecifier") return "default";
  if (specifier.type === "ImportNamespaceSpecifier") return "*";
  return specifier.imported?.name || specifier.imported?.value || specifier.local?.name || "";
}

function nodeSignature(node) {
  if (!node?.loc) return "";
  return `${node.type}@${node.loc.start.line}`;
}

function firstCodeLine(lines, startLine, endLine) {
  for (let line = startLine; line <= endLine; line += 1) {
    const text = lines[line - 1]?.trim();
    if (text) return text.slice(0, 240);
  }
  return "";
}

function patternName(node) {
  return node?.type === "Identifier" ? node.name : null;
}

function keyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateName") return `#${node.id?.name || "private"}`;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
  return null;
}

function isFunctionExpression(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function scoped(scope, ...names) {
  return scope.concat(names.filter(Boolean));
}

function uniqueByDefinition(items) {
  return uniqueBy(items, (item) => `${item.filePath}:${item.kind}:${item.name}:${item.startLine}`);
}

function uniqueByImport(items) {
  return uniqueBy(items, (item) => `${item.filePath}:${item.source}:${item.importedName}:${item.localName}`);
}

function uniqueByExport(items) {
  return uniqueBy(items, (item) => `${item.filePath}:${item.name}:${item.localName}`);
}

function uniqueByReference(items) {
  return uniqueBy(items, (item) => `${item.filePath}:${item.name}:${item.line}:${item.column}`);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

export function resolveImportPath(importerPath, source, indexedPaths) {
  if (!source?.startsWith(".")) return null;
  const baseDir = path.posix.dirname(importerPath);
  const base = path.posix.normalize(path.posix.join(baseDir, source));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.posix.join(base, "index.js"),
    path.posix.join(base, "index.ts"),
  ];
  return candidates.find((candidate) => indexedPaths.has(candidate)) || null;
}
