import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import ts from "@typescript/typescript6";
import { readPackRecord } from "./pack-result.js";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm");
const root = process.cwd();
const npm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options);
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const contract = JSON.parse(await readFile("tests/public-contract.json", "utf8"));
// Source integration can use one normally packed, unpublished Auth archive.
// The final release graph supplies its canonical registry instead.
const authTarball = process.env.ASKR_AUTH_TARBALL;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let authArtifact;
let authFiles;
if (authTarball !== undefined) {
  assert(
    isAbsolute(authTarball) && authTarball.endsWith(".tgz"),
    "ASKR_AUTH_TARBALL must be an absolute .tgz path",
  );
  assert((await lstat(authTarball)).isFile(), "ASKR_AUTH_TARBALL must be a regular file");
  const bytes = await readFile(authTarball);
  authFiles = new Map();
  const paths = execFileSync("tar", ["-tzf", authTarball], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/u);
  for (const path of paths) {
    assert(
      path.startsWith("package/") && !path.includes("\\") && !path.split("/").includes(".."),
      "Invalid Auth archive path",
    );
    if (path.endsWith("/")) continue;
    const relative = path.slice("package/".length);
    assert(!authFiles.has(relative), "Duplicate Auth archive path");
    const contents = execFileSync("tar", ["-xOzf", authTarball, path]);
    authFiles.set(relative, contents);
    assert.deepEqual(
      await readFile(join(root, "node_modules/@askrjs/auth", relative)),
      contents,
      `Root Auth differs from archive: ${relative}`,
    );
  }
  const supplied = JSON.parse(authFiles.get("package.json").toString("utf8"));
  assert.equal(supplied.name, "@askrjs/auth");
  assert(supplied.exports["./server"], "Auth archive must expose its server entry");
  authArtifact = {
    version: supplied.version,
    exports: supplied.exports,
    sha256: digest(bytes),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    files: authFiles.size,
  };
  assert.equal(
    digest(await readFile(authTarball)),
    authArtifact.sha256,
    "Auth archive changed during inspection",
  );
}
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
      ...(authTarball === undefined ? [] : [authTarball]),
    ],
    { cwd: directory, stdio: "pipe" },
  );
  if (authArtifact) {
    const authRoot = join(directory, "node_modules/@askrjs/auth");
    const installedAuth = JSON.parse(await readFile(join(authRoot, "package.json"), "utf8"));
    assert.equal(installedAuth.name, "@askrjs/auth");
    assert.equal(installedAuth.version, authArtifact.version);
    assert.deepEqual(installedAuth.exports, authArtifact.exports);
    for (const [path, bytes] of authFiles)
      assert.deepEqual(
        await readFile(join(authRoot, path)),
        bytes,
        `Installed Auth differs from archive: ${path}`,
      );
    assert.equal(
      digest(await readFile(authTarball)),
      authArtifact.sha256,
      "Auth archive changed during installation",
    );
  }
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
      ...(authArtifact ? { developmentAuth: authArtifact } : {}),
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
  if (authArtifact)
    assert.equal(
      digest(await readFile(authTarball)),
      authArtifact.sha256,
      "Auth archive changed during qualification",
    );
} finally {
  await rm(directory, { recursive: true, force: true });
}
