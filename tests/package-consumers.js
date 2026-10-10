import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { readPackRecord } from "./pack-result.js";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm");
const root = process.cwd();
const npm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options);
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const contract = JSON.parse(await readFile("tests/public-contract.json", "utf8"));
const directory = await mkdtemp(join(tmpdir(), "askr-server-consumer-"));
try {
  const packed = readPackRecord(
    JSON.parse(
      npm(["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
        encoding: "utf8",
      }),
    ),
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      join(directory, packed.filename),
      `@askrjs/askr@${manifest.devDependencies["@askrjs/askr"]}`,
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const installed = JSON.parse(
    await readFile(join(directory, "node_modules/@askrjs/server/package.json"), "utf8"),
  );
  assert.deepEqual(installed.exports, manifest.exports);
  assert.deepEqual(Object.keys(installed.exports).sort(), contract.exportKeys);
  const fixture = (await readFile("tests/types/public-contract.ts", "utf8")).replace(
    /"\.\.\/\.\.\/dist\/([^"/]+)\.js"/gu,
    (_match, entry) => JSON.stringify(`@askrjs/server${entry === "index" ? "" : `/${entry}`}`),
  );
  const surfaces = Object.keys(contract.entrypoints);
  const fixturePath = join(directory, "contract.ts");
  await writeFile(
    fixturePath,
    fixture +
      "\n" +
      surfaces
        .map((name, i) => `import * as Surface${i} from ${JSON.stringify(name)}; void Surface${i};`)
        .join("\n"),
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: [],
        lib: ["ES2022", "DOM", "DOM.Iterable"],
      },
      files: ["contract.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    {
      cwd: directory,
      stdio: "pipe",
    },
  );
  const program = ts.createProgram([fixturePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => directory,
      getNewLine: () => "\n",
    }),
  );
  const checker = program.getTypeChecker();
  for (const [name, surface] of Object.entries(contract.entrypoints)) {
    const declaration = program
      .getSourceFile(fixturePath)
      .statements.find(
        (statement) => ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === name,
      );
    const names = checker
      .getExportsOfModule(checker.getSymbolAtLocation(declaration.moduleSpecifier))
      .map((symbol) => symbol.name)
      .sort();
    assert.deepEqual(names, [...surface.values, ...surface.types].sort(), name);
  }
  await writeFile(
    join(directory, "runtime.js"),
    `${await readFile("tests/packed-runtime.js", "utf8")}
    for (const [name, surface] of ${JSON.stringify(Object.entries(contract.entrypoints))}) {
      const exported = await import(name);
      assert.deepEqual(Object.keys(exported).sort(), surface.values.slice().sort(), name);
    }
    for (const path of ${JSON.stringify(contract.privateSubpaths)})
      await assert.rejects(import('@askrjs/server/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    `,
  );
  execFileSync(process.execPath, [join(directory, "runtime.js")], {
    cwd: directory,
    stdio: "pipe",
    timeout: 20_000,
  });
  console.log(
    JSON.stringify({
      normalInstall: true,
      publicEntrypoints: surfaces.length,
      declarationNames: contract.candidateNames,
      removedOrMovedImports: contract.negativeImports.length,
      privateSubpaths: contract.privateSubpaths.length,
      compilers: ["6.0.2", "7.0.2"],
      runtime: [
        "HEAD disposal",
        "replacement disposal",
        "denial guard",
        "probe guard",
        "error handler failure",
        "aborted body",
        "canonical context methods",
        "exact runtime exports",
      ],
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
