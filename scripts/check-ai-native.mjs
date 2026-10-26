#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * AI-native architecture gate.
 *
 * The standard lives in docs/ai-native-architecture.md. This script contains
 * only the rules that can be decided deterministically from source; the
 * judgement calls stay in the review checklist.
 *
 * Usage:
 *   node scripts/check-ai-native.mjs --staged   # pre-commit
 *   node scripts/check-ai-native.mjs --all      # full audit
 *   node scripts/check-ai-native.mjs --strict   # warnings become failures
 */

const argv = new Set(process.argv.slice(2));
const mode = argv.has("--all") ? "all" : "staged";
const strict = argv.has("--strict");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

let root;
try {
  root = git(["rev-parse", "--show-toplevel"]).trim();
} catch {
  // Not a git checkout (e.g. an unpacked tarball): nothing to gate.
  process.exit(0);
}

const files =
  mode === "staged"
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]).split("\n").filter(Boolean)
    : git(["ls-files"]).split("\n").filter(Boolean);

const sourceFiles = files.filter((file) => /\.(ts|tsx|mts|cts)$/.test(file));
const testFiles = sourceFiles.filter((file) => /\.test\.(ts|tsx)$/.test(file));

const MODEL_SDK = /^(openai(\/.*)?|@anthropic-ai\/sdk(\/.*)?)$/;
const PROVIDER_ENDPOINT = /https?:\/\/api\.(openai|anthropic)\.com/;
const isTest = (file) => /\.test\.(ts|tsx)$/.test(file);
const isModelLayer = (file) => file.startsWith("packages/model/src/");
const isCoreLayer = (file) => file.startsWith("packages/core/src/");
const isToolOrAgentLayer = (file) =>
  file.startsWith("packages/tools/src/") || file.startsWith("packages/agent/src/");

const findings = [];

function add(level, rule, file, line, message) {
  findings.push({ level, rule, file, line, message });
}

function readStaged(file) {
  return git(["show", `:${file}`]);
}

function load(file) {
  return mode === "staged" ? readStaged(file) : readFileSync(join(root, file), "utf8");
}

function sourceKind(file) {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parse(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceKind(file));
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function moduleSpecifierOf(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    return ts.isStringLiteral(expression) ? expression.text : undefined;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const require = ts.isIdentifier(node.expression) && node.expression.text === "require";
    if ((dynamicImport || require) && ts.isStringLiteral(node.arguments[0])) {
      return node.arguments[0].text;
    }
  }
  return undefined;
}

function newExpressionName(node) {
  if (!ts.isNewExpression(node)) return undefined;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  return undefined;
}

function inspect(file) {
  let source;
  try {
    source = load(file);
  } catch (error) {
    add("error", "read-failed", file, 1, `could not read staged content: ${String(error)}`);
    return;
  }

  const sourceFile = parse(file, source);

  function visit(node) {
    const specifier = moduleSpecifierOf(node);
    if (specifier) {
      if (!isModelLayer(file) && MODEL_SDK.test(specifier)) {
        add(
          "error",
          "model-isolation",
          file,
          lineOf(sourceFile, node),
          `model SDK "${specifier}" must stay inside packages/model/src`,
        );
      }
      if (isCoreLayer(file) && specifier.startsWith("@nova/")) {
        add(
          "error",
          "core-leaf",
          file,
          lineOf(sourceFile, node),
          `@nova/core is a leaf; declare a port instead of importing ${specifier}`,
        );
      }
    }

    if (!isModelLayer(file) && !isTest(file)) {
      const ctor = newExpressionName(node);
      if (ctor === "OpenAI" || ctor === "Anthropic") {
        add(
          "error",
          "model-isolation",
          file,
          lineOf(sourceFile, node),
          `constructing ${ctor} outside packages/model/src bypasses the model adapter`,
        );
      }
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        PROVIDER_ENDPOINT.test(node.text)
      ) {
        add(
          "error",
          "provider-endpoint",
          file,
          lineOf(sourceFile, node),
          "direct provider endpoint outside packages/model/src",
        );
      }
    }

    if (isToolOrAgentLayer(file) && !isTest(file)) {
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "definition" &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const properties = new Set();
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            const name = propertyName(property.name);
            if (name) properties.add(name);
          }
        }
        for (const required of ["name", "description", "inputSchema"]) {
          if (!properties.has(required)) {
            add(
              "error",
              "tool-contract",
              file,
              lineOf(sourceFile, node),
              `tool definition is missing \`${required}\``,
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

for (const file of sourceFiles) inspect(file);

if (mode === "staged") {
  const surfaces = [
    /^packages\/model\/src\//,
    /^packages\/agent\/src\/(system-prompt|compactor|compact|session|subagent)\.ts$/,
    /^packages\/core\/src\/(loop|agent|types|ports)\.ts$/,
    /^packages\/tools\/src\//,
    /^packages\/base\/src\/config\/config\.ts$/,
  ];
  const touched = sourceFiles.filter(
    (file) => !isTest(file) && surfaces.some((pattern) => pattern.test(file)),
  );
  if (touched.length > 0 && testFiles.length === 0) {
    add(
      "warn",
      "ai-surface-test",
      touched[0],
      1,
      `AI-facing surface changed without a staged test: ${touched.join(", ")}`,
    );
  }
}

const errors = findings.filter((finding) => finding.level === "error");
const warnings = findings.filter((finding) => finding.level === "warn");

if (findings.length > 0) {
  console.log(
    `AI-native architecture check (${mode}${strict ? ", strict" : ""}): ${sourceFiles.length} source file(s)`,
  );
  for (const finding of findings) {
    const location = `${finding.file}:${finding.line}`;
    console.log(
      `  ${finding.level.toUpperCase().padEnd(5)} [${finding.rule}] ${location}  ${finding.message}`,
    );
  }
}

if (errors.length > 0) {
  console.error(
    `\nRefusing commit: ${errors.length} AI-native architecture violation(s). ` +
      "See docs/ai-native-architecture.md.",
  );
  process.exit(1);
}

if (warnings.length > 0 && strict) {
  console.error(
    `\nRefusing commit (--strict): ${warnings.length} warning(s) need a test or an explicit waiver.`,
  );
  process.exit(1);
}

console.log(
  `AI-native architecture check passed${warnings.length > 0 ? ` with ${warnings.length} warning(s)` : ""}.`,
);
