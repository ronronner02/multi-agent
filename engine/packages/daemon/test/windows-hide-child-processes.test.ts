import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const runtimeRoots = [
  "engine/packages/daemon/src",
  "engine/packages/cli/src",
  "desktop/src",
  "engine/packages/daemon/assets",
];
const processMethods = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name)) || entry.name.endsWith(".d.ts")) return [];
    return [absolute];
  });
}

function moduleName(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isAwaitExpression(node)) return moduleName(node.expression);
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
  }
  return undefined;
}

function isChildProcessModule(name: string | undefined): boolean {
  return name === "node:child_process" || name === "child_process";
}

function hasWindowsHide(options: ts.Expression | undefined): boolean {
  while (options && (ts.isAsExpression(options) || ts.isTypeAssertionExpression(options) || ts.isParenthesizedExpression(options))) {
    options = options.expression;
  }
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name;
    return (ts.isIdentifier(name) || ts.isStringLiteral(name))
      && name.text === "windowsHide"
      && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
}

function hasTrustedHideHelper(texts: string[]): boolean {
  return texts.some((text) => {
    const source = ts.createSourceFile("runtime-source.ts", text, ts.ScriptTarget.Latest, true);
    let trusted = false;
    const visit = (node: ts.Node): void => {
      const namedHelper = (ts.isFunctionDeclaration(node) && node.name?.text === "hiddenSpawnOptions")
        || (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "hiddenSpawnOptions");
      if (namedHelper) {
        const inspect = (candidate: ts.Node): void => {
          if (ts.isPropertyAssignment(candidate)) {
            const name = candidate.name;
            if ((ts.isIdentifier(name) || ts.isStringLiteral(name))
              && name.text === "windowsHide"
              && candidate.initializer.kind === ts.SyntaxKind.TrueKeyword) trusted = true;
          }
          ts.forEachChild(candidate, inspect);
        };
        inspect(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return trusted;
  });
}

function optionIndex(call: ts.CallExpression, method: string): number {
  if (method === "exec" || method === "execSync") return 1;
  const secondArgument = call.arguments[1];
  if (!secondArgument || ts.isObjectLiteralExpression(secondArgument)) return 1;
  if (ts.isCallExpression(secondArgument) && ts.isIdentifier(secondArgument.expression)
    && secondArgument.expression.text === "hiddenSpawnOptions") return 1;
  if (ts.isIdentifier(secondArgument) && /^(?:opts?|options|spawnOptions|execOptions)$/i.test(secondArgument.text)) return 1;
  if (ts.isPropertyAccessExpression(secondArgument) && /^(?:opts?|options|spawnOptions|execOptions)$/i.test(secondArgument.name.text)) return 1;
  if (ts.isArrayLiteralExpression(secondArgument) || ts.isStringLiteral(secondArgument)) return 2;
  if (ts.isIdentifier(secondArgument) || ts.isPropertyAccessExpression(secondArgument)) return 2;
  return 1;
}

function findMissingWindowsHide(
  file: string,
  text = readFileSync(file, "utf8"),
  helperTrusted = false,
): { missing: string[]; calls: number } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const importedMethods = new Map<string, string>();
  const childProcessNamespaces = new Set<string>();
  const hideHelperAliases = new Set<string>(helperTrusted ? ["hiddenSpawnOptions"] : []);
  const promisifyNames = new Set<string>(["promisify"]);

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "hiddenSpawnOptions") {
            hideHelperAliases.add(element.name.text);
          }
        }
      }
      if (isChildProcessModule(module) && statement.importClause?.name) childProcessNamespaces.add(statement.importClause.name.text);
      if (isChildProcessModule(module) && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (processMethods.has(element.propertyName?.text ?? element.name.text)) {
            importedMethods.set(element.name.text, element.propertyName?.text ?? element.name.text);
          }
        }
      } else if (isChildProcessModule(module) && bindings && ts.isNamespaceImport(bindings)) {
        childProcessNamespaces.add(bindings.name.text);
      } else if ((module === "node:util" || module === "util") && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "promisify") promisifyNames.add(element.name.text);
        }
      }
    }
    if (ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && isChildProcessModule(ts.isStringLiteral(statement.moduleReference.expression) ? statement.moduleReference.expression.text : undefined)) {
      childProcessNamespaces.add(statement.name.text);
    }
  }

  const visitBindings = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) {
      const module = moduleName(node.initializer);
      if (isChildProcessModule(module)) {
        if (ts.isIdentifier(node.name)) childProcessNamespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const method = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
            if (processMethods.has(method)) importedMethods.set(element.name.text, method);
          }
        }
      } else if (ts.isIdentifier(node.initializer) && ts.isIdentifier(node.name)
        && importedMethods.has(node.initializer.text)) {
        importedMethods.set(node.name.text, importedMethods.get(node.initializer.text)!);
      } else if (ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && promisifyNames.has(node.initializer.expression.text)
        && ts.isIdentifier(node.name)
        && node.initializer.arguments.some((argument) => ts.isIdentifier(argument) && importedMethods.get(argument.text) === "execFile")) {
        importedMethods.set(node.name.text, "execFile");
      }
    }
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(source);

  const missing: string[] = [];
  let calls = 0;
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let method: string | undefined;
      if (ts.isIdentifier(node.expression)) method = importedMethods.get(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const property = node.expression.name.text;
        if (ts.isIdentifier(receiver) && childProcessNamespaces.has(receiver.text) && processMethods.has(property)) method = property;
        if (ts.isIdentifier(receiver) && receiver.text === "deps" && processMethods.has(property)) method = property;
      }
      if (method) {
        calls += 1;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const options = node.arguments[optionIndex(node, method)];
        const usesTrustedHelper = helperTrusted && options && ts.isCallExpression(options)
          && ts.isIdentifier(options.expression)
          && hideHelperAliases.has(options.expression.text);
        if (!hasWindowsHide(options) && !usesTrustedHelper) {
          missing.push(`${path.relative(repositoryRoot, file)}:${line} ${method}`);
        }
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(source);
  return { missing, calls };
}

describe("Windows child-process visibility", () => {
  it("passes windowsHide to every runtime child-process launcher", () => {
    const files = runtimeRoots.flatMap((root) => sourceFiles(path.join(repositoryRoot, root)));
    const texts = files.map((file) => readFileSync(file, "utf8"));
    const helperTrusted = hasTrustedHideHelper(texts);
    const scanned = files.map((file, index) => findMissingWindowsHide(file, texts[index], helperTrusted));
    const missing = scanned.flatMap((result) => result.missing).sort();
    console.log(`Checked ${scanned.reduce((count, result) => count + result.calls, 0)} runtime child-process calls across ${files.length} source files.`);
    assert.deepEqual(missing, [], `Found ${missing.length} runtime child-process call(s) without windowsHide: true:\n${missing.join("\n")}`);
  });

  it.each([
    'import { spawn as start } from "node:child_process"; start("git", []);',
    'import * as cp from "child_process"; cp.execSync("git");',
    'const { execFile } = await import("node:child_process"); execFile("git", [], () => {});',
    'import { execFile } from "node:child_process"; const run = promisify(execFile); run("git", [], {});',
    'import { execFileSync } from "node:child_process"; function check(run = execFileSync) { run("git", [], {}); }',
    'deps.spawn("node", [], { detached: true });',
  ])("rejects an unhidden launcher: %s", (text) => {
    assert.equal(findMissingWindowsHide("fixture.ts", text).missing.length, 1);
  });

  it("accepts a hidden launcher and ignores unrelated exec methods", () => {
    const scanned = findMissingWindowsHide("fixture.ts", `
      import { spawn } from "node:child_process";
      spawn("git", [], { windowsHide: true } as SpawnOptions);
      /pattern/.exec("text");
      db.exec("SELECT 1");
    `);
    assert.equal(scanned.calls, 1);
    assert.deepEqual(scanned.missing, []);
  });

  it("accepts the shared options helper when its implementation sets the flag", () => {
    const source = `
      import { spawn } from "node:child_process";
      import { hiddenSpawnOptions as hide } from "./process-options.js";
      spawn("git", [], hide({ stdio: "ignore" }));
    `;
    const helper = `export function hiddenSpawnOptions(options) { return { ...options, windowsHide: true }; }`;
    const scanned = findMissingWindowsHide("fixture.ts", source, hasTrustedHideHelper([helper]));
    assert.deepEqual(scanned.missing, []);

    const untrusted = `export function hiddenSpawnOptions(options) { return { ...options }; }`;
    assert.equal(findMissingWindowsHide("fixture.ts", source, hasTrustedHideHelper([untrusted])).missing.length, 1);
  });
});
