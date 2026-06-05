import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import { tokenize } from "./embedding.js";

const TREE_SITTER_LANGUAGE = {
  javascript: JavaScript,
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
};

export function parseTreeSitterJavaScript({ filePath, text, language }) {
  const tree = parseTree({ text, language });
  if (!tree) return null;

  const state = {
    filePath,
    definitions: [],
    imports: [],
    exports: [],
    references: [],
    scope: [],
  };

  for (const statement of tree.rootNode.namedChildren) {
    collectTopLevelStatement(statement, state);
  }
  collectReferences(tree.rootNode, state);

  return {
    definitions: uniqueByDefinition(state.definitions),
    imports: uniqueByImport(state.imports),
    exports: uniqueByExport(state.exports),
    references: uniqueByReference(state.references),
  };
}

export function collectTreeSitterJavaScriptSymbolBlocks({ text, language }) {
  const tree = parseTree({ text, language });
  if (!tree) return null;

  const blocks = [];
  for (const statement of tree.rootNode.namedChildren) {
    collectStatementBlocks(statement, { blocks, scope: [], fullNode: statement });
  }
  return blocks;
}

function parseTree({ text, language }) {
  const parserLanguage = TREE_SITTER_LANGUAGE[language] || TREE_SITTER_LANGUAGE.javascript;
  try {
    const parser = new Parser();
    parser.setLanguage(parserLanguage);
    const tree = parser.parse(text);
    return tree.rootNode.hasError() ? null : tree;
  } catch {
    return null;
  }
}

function collectTopLevelStatement(node, state) {
  if (!node) return;

  if (node.type === "import_statement") {
    collectImport(node, state);
    return;
  }

  if (node.type === "export_statement") {
    collectExport(node, state);
    const declaration = exportDeclaration(node);
    if (declaration) collectDeclaration(declaration, { ...state, exported: true });
    return;
  }

  collectDeclaration(node, state);
}

function collectImport(node, state) {
  const source = stringValue(node.namedChildren.find((child) => child.type === "string")) || "";
  const clause = node.namedChildren.find((child) => child.type === "import_clause");
  if (!clause) {
    state.imports.push({
      filePath: state.filePath,
      source,
      importedName: "*",
      localName: "*",
      line: lineOf(node),
    });
    return;
  }

  for (const child of clause.namedChildren) {
    if (child.type === "identifier") {
      state.imports.push({
        filePath: state.filePath,
        source,
        importedName: "default",
        localName: child.text,
        line: lineOf(child),
      });
    } else if (child.type === "namespace_import") {
      const local = child.namedChildren.find((entry) => entry.type === "identifier")?.text || "*";
      state.imports.push({
        filePath: state.filePath,
        source,
        importedName: "*",
        localName: local,
        line: lineOf(child),
      });
    } else if (child.type === "named_imports") {
      for (const specifier of child.namedChildren.filter((entry) => entry.type === "import_specifier")) {
        const names = specifier.namedChildren.filter((entry) => entry.type === "identifier");
        const importedName = names[0]?.text || "";
        const localName = names.at(-1)?.text || importedName;
        if (!importedName) continue;
        state.imports.push({
          filePath: state.filePath,
          source,
          importedName,
          localName,
          line: lineOf(specifier),
        });
      }
    }
  }
}

function collectExport(node, state) {
  const declaration = exportDeclaration(node);
  if (declaration) {
    const names = declarationNames(declaration);
    if (names.length) {
      for (const name of names) {
        state.exports.push({
          filePath: state.filePath,
          name,
          localName: name,
          line: lineOf(node),
        });
      }
    } else if (/\bdefault\b/.test(node.text)) {
      state.exports.push({
        filePath: state.filePath,
        name: "default",
        localName: "default",
        line: lineOf(node),
      });
    }
    return;
  }

  const clause = node.namedChildren.find((child) => child.type === "export_clause");
  for (const specifier of clause?.namedChildren || []) {
    if (specifier.type !== "export_specifier") continue;
    const names = specifier.namedChildren.filter((entry) => entry.type === "identifier");
    const localName = names[0]?.text;
    const name = names.at(-1)?.text || localName;
    if (!name) continue;
    state.exports.push({
      filePath: state.filePath,
      name,
      localName,
      line: lineOf(specifier),
    });
  }
}

function collectDeclaration(node, state) {
  if (!node) return;

  if (node.type === "function_declaration") {
    const name = declarationName(node) || "default";
    addDefinition(state, "function", name, node);
    collectNestedDeclarations(blockBody(node), { ...state, scope: scoped(state.scope, name) });
    return;
  }

  if (node.type === "class_declaration") {
    const className = declarationName(node) || "default";
    addDefinition(state, "class", className, node);
    collectClassMemberDeclarations(node, { ...state, scope: scoped(state.scope, className) });
    return;
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (const declaration of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
      collectVariableDeclarator(declaration, state);
    }
    return;
  }

  if (node.type === "type_alias_declaration" || node.type === "interface_declaration" || node.type === "enum_declaration") {
    addDefinition(state, node.type === "enum_declaration" ? "enum" : "type", declarationName(node) || "default", node);
  }
}

function collectVariableDeclarator(node, state) {
  const name = declarationName(node);
  if (!name) return;
  const value = node.childForFieldName("value");

  if (isFunctionExpression(value)) {
    addDefinition(state, "function", name, node);
    collectNestedDeclarations(blockBody(value), { ...state, scope: scoped(state.scope, name) });
    return;
  }

  if (value?.type === "class") {
    addDefinition(state, "class", name, node);
    collectClassMemberDeclarations(value, { ...state, scope: scoped(state.scope, name) });
    return;
  }

  if (value?.type === "object") {
    if (state.exported) addDefinition(state, "export", name, node);
    collectObjectMemberDeclarations(value, { ...state, scope: scoped(state.scope, name) });
    return;
  }

  if (state.exported) addDefinition(state, "export", name, node);
}

function collectClassMemberDeclarations(node, state) {
  const body = node.namedChildren.find((child) => child.type === "class_body");
  for (const member of body?.namedChildren || []) {
    const name = declarationName(member);
    if (!name) continue;
    if (member.type === "method_definition") {
      addDefinition(state, "method", name, member);
      collectNestedDeclarations(blockBody(member), { ...state, scope: scoped(state.scope, name) });
      continue;
    }
    if (member.type === "public_field_definition" && isFunctionExpression(member.childForFieldName("value"))) {
      addDefinition(state, "method", name, member);
      collectNestedDeclarations(blockBody(member.childForFieldName("value")), { ...state, scope: scoped(state.scope, name) });
    }
  }
}

function collectObjectMemberDeclarations(node, state) {
  for (const property of node.namedChildren) {
    const name = declarationName(property);
    if (!name) continue;
    if (property.type === "method_definition") {
      addDefinition(state, "method", name, property);
      collectNestedDeclarations(blockBody(property), { ...state, scope: scoped(state.scope, name) });
      continue;
    }
    if (property.type === "pair" && isFunctionExpression(property.childForFieldName("value"))) {
      addDefinition(state, "method", name, property);
      collectNestedDeclarations(blockBody(property.childForFieldName("value")), { ...state, scope: scoped(state.scope, name) });
    }
  }
}

function collectNestedDeclarations(body, state) {
  for (const statement of body?.namedChildren || []) {
    collectDeclaration(statement, state);
  }
}

function collectStatementBlocks(node, context) {
  if (!node) return;

  if (node.type === "export_statement") {
    const declaration = exportDeclaration(node);
    if (declaration) collectStatementBlocks(declaration, { ...context, fullNode: node });
    else collectExportSpecifierBlocks(node, context);
    return;
  }

  if (node.type === "function_declaration") {
    const name = declarationName(node) || "default";
    addBlock(context.blocks, { kind: "function", name: scopedName(context.scope, name), node: context.fullNode || node });
    collectNestedBlocks(node, { ...context, scope: scoped(context.scope, name) });
    return;
  }

  if (node.type === "class_declaration") {
    const name = declarationName(node) || "default";
    addBlock(context.blocks, { kind: "class", name: scopedName(context.scope, name), node: context.fullNode || node });
    collectClassMemberBlocks(node, { ...context, scope: scoped(context.scope, name) });
    return;
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (const declaration of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
      collectVariableBlocks(declaration, context, node);
    }
    return;
  }

  if (node.type === "type_alias_declaration" || node.type === "interface_declaration" || node.type === "enum_declaration") {
    addBlock(context.blocks, {
      kind: node.type === "enum_declaration" ? "enum" : "type",
      name: declarationName(node) || "default",
      node: context.fullNode || node,
    });
  }
}

function collectExportSpecifierBlocks(node, context) {
  const clause = node.namedChildren.find((child) => child.type === "export_clause");
  for (const specifier of clause?.namedChildren || []) {
    const names = specifier.namedChildren.filter((entry) => entry.type === "identifier");
    const name = names.at(-1)?.text || names[0]?.text;
    if (name) addBlock(context.blocks, { kind: "export", name, node });
  }
}

function collectVariableBlocks(declaration, context, declarationNode) {
  const name = declarationName(declaration);
  if (!name) return;
  const value = declaration.childForFieldName("value");
  const fullNode = context.fullNode || declarationNode || declaration;

  if (isFunctionExpression(value)) {
    addBlock(context.blocks, { kind: "function", name: scopedName(context.scope, name), node: fullNode });
    collectNestedBlocks(value, { ...context, scope: scoped(context.scope, name) });
    return;
  }

  if (value?.type === "class") {
    addBlock(context.blocks, { kind: "class", name: scopedName(context.scope, name), node: fullNode });
    collectClassMemberBlocks(value, { ...context, scope: scoped(context.scope, name) });
    return;
  }

  if (context.fullNode?.type === "export_statement") {
    addBlock(context.blocks, { kind: "export", name, node: fullNode });
  }

  if (value?.type === "object") {
    collectObjectMemberBlocks(value, { ...context, scope: scoped(context.scope, name) });
  }
}

function collectClassMemberBlocks(node, context) {
  const body = node.namedChildren.find((child) => child.type === "class_body");
  for (const member of body?.namedChildren || []) {
    const name = declarationName(member);
    if (!name) continue;
    if (member.type === "method_definition") {
      addBlock(context.blocks, { kind: "method", name: scopedName(context.scope, name), node: member });
      collectNestedBlocks(member, { ...context, scope: scoped(context.scope, name) });
      continue;
    }
    if (member.type === "public_field_definition" && isFunctionExpression(member.childForFieldName("value"))) {
      addBlock(context.blocks, { kind: "method", name: scopedName(context.scope, name), node: member });
      collectNestedBlocks(member.childForFieldName("value"), { ...context, scope: scoped(context.scope, name) });
    }
  }
}

function collectObjectMemberBlocks(node, context) {
  for (const property of node.namedChildren) {
    const name = declarationName(property);
    if (!name) continue;
    if (property.type === "method_definition") {
      addBlock(context.blocks, { kind: "method", name: scopedName(context.scope, name), node: property });
      collectNestedBlocks(property, { ...context, scope: scoped(context.scope, name) });
      continue;
    }
    if (property.type === "pair" && isFunctionExpression(property.childForFieldName("value"))) {
      addBlock(context.blocks, { kind: "method", name: scopedName(context.scope, name), node: property });
      collectNestedBlocks(property.childForFieldName("value"), { ...context, scope: scoped(context.scope, name) });
    }
  }
}

function collectNestedBlocks(node, context) {
  for (const statement of blockBody(node)?.namedChildren || []) {
    collectStatementBlocks(statement, { ...context, fullNode: statement });
  }
}

function collectReferences(node, state, parent = null) {
  if (!node) return;
  if ((node.type === "identifier" || node.type === "type_identifier") && !isDefinitionIdentifier(node, parent)) {
    state.references.push({
      filePath: state.filePath,
      name: node.text,
      line: lineOf(node),
      column: node.startPosition.column,
      kind: "identifier",
      targetSymbol: null,
    });
  }

  for (const child of node.namedChildren) {
    collectReferences(child, state, node);
  }
}

function isDefinitionIdentifier(node, parent) {
  if (!parent) return false;
  if (parent.childForFieldName("name") === node) return true;
  if (parent.childForFieldName("property") === node && !["member_expression", "subscript_expression"].includes(parent.type)) return true;
  if (parent.type === "import_clause" || parent.type === "import_specifier" || parent.type === "namespace_import") return true;
  if (parent.type === "export_specifier") return true;
  return parent.type === "required_parameter" && parent.namedChildren[0] === node;
}

function exportDeclaration(node) {
  return node.namedChildren.find((child) => child.type !== "export_clause" && child.type !== "string") || null;
}

function declarationNames(node) {
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    return node.namedChildren
      .filter((child) => child.type === "variable_declarator")
      .map((child) => declarationName(child))
      .filter(Boolean);
  }
  const name = declarationName(node);
  return name ? [name] : [];
}

function declarationName(node) {
  if (!node) return null;
  const named = node.childForFieldName("name") || node.childForFieldName("property");
  if (named) return nodeName(named);
  if (node.type === "pair") return nodeName(node.childForFieldName("key"));
  return null;
}

function nodeName(node) {
  if (!node) return null;
  if (node.type === "private_property_identifier") return `#${node.text.replace(/^#/, "") || "private"}`;
  return node.text || null;
}

function blockBody(node) {
  return node?.namedChildren.find((child) => child.type === "statement_block");
}

function isFunctionExpression(node) {
  return node?.type === "arrow_function" || node?.type === "function";
}

function addDefinition(state, kind, name, node) {
  const scoped = scopedName(state.scope, name);
  state.definitions.push({
    filePath: state.filePath,
    name: scoped,
    kind,
    startLine: lineOf(node),
    endLine: endLineOf(node),
    exported: Boolean(state.exported),
    signature: nodeSignature(node),
  });
}

function addBlock(blocks, { kind, name, node }) {
  blocks.push({
    kind,
    name,
    startLine: lineOf(node),
    endLine: endLineOf(node),
  });
}

function lineOf(node) {
  return node.startPosition.row + 1;
}

function endLineOf(node) {
  return node.endPosition.row + 1;
}

function nodeSignature(node) {
  return `${node.type}@${lineOf(node)}`;
}

function scoped(scope, ...names) {
  return scope.concat(names.filter(Boolean));
}

function scopedName(scope, name) {
  return scoped(scope, name).join(".");
}

function stringValue(node) {
  if (!node) return "";
  const fragment = node.namedChildren.find((child) => child.type === "string_fragment");
  return fragment?.text || node.text.replace(/^['"]|['"]$/g, "");
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

export function parseTreeSitterTextFile({ filePath, text }) {
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
