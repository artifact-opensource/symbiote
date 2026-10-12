import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const outputDir = path.join(root, '.index');
const outputFile = path.join(outputDir, 'codebase-index.json');
const trackedAndUntracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
});
const files = [...new Set(trackedAndUntracked.split('\0').filter(Boolean))]
  .filter(file => file !== '.index' && !file.startsWith('.index/'))
  .sort((a, b) => a.localeCompare(b));

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

function languageFor(file) {
  const extension = path.extname(file).toLowerCase();
  const languages = {
    '.cjs': 'javascript',
    '.css': 'css',
    '.html': 'html',
    '.js': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.mjs': 'javascript',
    '.ps1': 'powershell',
    '.py': 'python',
    '.sh': 'shell',
    '.sql': 'sql',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.yml': 'yaml',
    '.yaml': 'yaml',
  };
  return languages[extension] ?? (extension ? extension.slice(1) : 'text');
}

function categoryFor(file) {
  const [topLevel = 'root'] = file.split('/');
  if (topLevel === 'tests' || file.includes('/test/')) return 'tests';
  if (topLevel === 'src') return 'application-source';
  if (topLevel === 'docs') return 'documentation';
  if (topLevel === 'webapp' || topLevel === 'web') return 'web-interface';
  if (topLevel === 'scripts') return 'developer-scripts';
  if (topLevel === 'examples') return 'examples';
  if (topLevel === 'assets') return 'assets';
  if (topLevel === 'systemd' || topLevel === 'launcher' || topLevel === 'launchers') return 'deployment';
  if (topLevel === 'xmcp') return 'mcp-bridge';
  if (topLevel === 'subagents') return 'subagents';
  return 'project-metadata';
}

function declarationName(node) {
  if (!node.name) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return undefined;
}

function isExported(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function sourceIndex(file, text) {
  const extension = path.extname(file).toLowerCase();
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX
    : extension === '.jsx' ? ts.ScriptKind.JSX
      : extension === '.js' || extension === '.mjs' || extension === '.cjs' ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  const symbols = [];
  const references = [];

  const addSymbol = (node, kind, exported) => {
    const name = declarationName(node);
    if (name) symbols.push({ name, kind, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, exported });
  };

  for (const statement of source.statements) {
    const exported = isExported(statement);
    if (ts.isFunctionDeclaration(statement)) addSymbol(statement, 'function', exported);
    else if (ts.isClassDeclaration(statement)) {
      addSymbol(statement, 'class', exported);
      for (const member of statement.members) {
        if (ts.isConstructorDeclaration(member)) continue;
        const kind = ts.isMethodDeclaration(member) ? 'method'
          : ts.isPropertyDeclaration(member) ? 'property'
            : ts.isGetAccessorDeclaration(member) ? 'getter'
              : ts.isSetAccessorDeclaration(member) ? 'setter'
                : undefined;
        if (kind) addSymbol(member, kind, exported);
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      addSymbol(statement, 'interface', exported);
      for (const member of statement.members) {
        if (ts.isMethodSignature(member)) addSymbol(member, 'method-signature', exported);
        else if (ts.isPropertySignature(member)) addSymbol(member, 'property-signature', exported);
      }
    } else if (ts.isTypeAliasDeclaration(statement)) addSymbol(statement, 'type', exported);
    else if (ts.isEnumDeclaration(statement)) addSymbol(statement, 'enum', exported);
    else if (ts.isModuleDeclaration(statement)) addSymbol(statement, 'namespace', exported);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addSymbol(declaration, 'variable', exported);
    }

    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        references.push({
          kind: ts.isImportDeclaration(statement) ? 'import' : 're-export',
          module: statement.moduleSpecifier.text,
          line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
        });
      }
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        references.push({
          kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require',
          module: node.arguments[0].text,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  return {
    symbols: symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    references: references.sort((a, b) => a.line - b.line || a.module.localeCompare(b.module)),
  };
}

function markdownHeadings(text) {
  return [...text.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map(match => ({
    depth: match[1].length,
    heading: match[2],
    line: text.slice(0, match.index).split('\n').length,
  }));
}

function nonTsSymbols(language, text) {
  const patterns = {
    python: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)|^\s*class\s+([A-Za-z_]\w*)/gm,
    powershell: /^\s*function\s+([A-Za-z][\w-]*)/gim,
    shell: /^\s*(?:function\s+)?([A-Za-z_][\w.-]*)\s*\(\s*\)/gm,
  };
  const pattern = patterns[language];
  if (!pattern) return [];

  return [...text.matchAll(pattern)].map(match => {
    const name = match[1] ?? match[2];
    return {
      name,
      kind: language === 'python' ? (match[2] ? 'class' : 'function') : 'function',
      line: text.slice(0, match.index).split('\n').length,
      exported: !name.startsWith('_'),
    };
  });
}

const indexedFiles = [];
for (const relativePath of files) {
  const absolutePath = path.join(root, relativePath);
  let content;
  try {
    content = await readFile(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }

  const text = content.toString('utf8');
  const entry = {
    path: relativePath.replaceAll(path.sep, '/'),
    category: categoryFor(relativePath),
    language: languageFor(relativePath),
    bytes: content.byteLength,
    lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };

  if (['typescript', 'typescriptreact', 'javascript'].includes(entry.language)) {
    Object.assign(entry, sourceIndex(relativePath, text));
  } else if (['python', 'powershell', 'shell'].includes(entry.language)) {
    entry.symbols = nonTsSymbols(entry.language, text);
  } else if (entry.language === 'markdown') {
    entry.headings = markdownHeadings(text);
  }
  indexedFiles.push(entry);
}

const directories = {};
for (const file of indexedFiles) {
  const parts = file.path.split('/');
  const directory = parts.length > 1 ? parts[0] : '.';
  directories[directory] = (directories[directory] ?? 0) + 1;
}

const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  project: {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    repository: packageJson.repository?.url,
    entryPoint: packageJson.main,
    cli: packageJson.bin,
    node: packageJson.engines?.node,
    gitCommit,
  },
  coverage: {
    fileSource: 'git ls-files --cached --others --exclude-standard',
    includesIgnoredFiles: false,
    files: indexedFiles.length,
    directories,
    languages: indexedFiles.reduce((counts, file) => {
      counts[file.language] = (counts[file.language] ?? 0) + 1;
      return counts;
    }, {}),
    symbols: indexedFiles.reduce((total, file) => total + (file.symbols?.length ?? 0), 0),
    references: indexedFiles.reduce((total, file) => total + (file.references?.length ?? 0), 0),
    markdownHeadings: indexedFiles.reduce((total, file) => total + (file.headings?.length ?? 0), 0),
  },
  package: {
    scripts: packageJson.scripts ?? {},
    dependencies: packageJson.dependencies ?? {},
    devDependencies: packageJson.devDependencies ?? {},
  },
  files: indexedFiles,
};

await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`Indexed ${indexedFiles.length} files, ${index.coverage.symbols} symbols, ${index.coverage.references} references, and ${index.coverage.markdownHeadings} Markdown headings.`);
console.log(`Wrote ${path.relative(root, outputFile)}.`);
