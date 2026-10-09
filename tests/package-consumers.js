import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackRecord } from "./pack-result.js";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm");
const root = process.cwd();
const npm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options);
const manifest = JSON.parse(await readFile("package.json", "utf8"));
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
      "--ignore-scripts",
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
  const fixture = (await readFile("tests/types/public-contract.ts", "utf8")).replace(
    /"\.\.\/\.\.\/dist\/([^"/]+)\.js"/gu,
    (_match, entry) => JSON.stringify(`@askrjs/server${entry === "index" ? "" : `/${entry}`}`),
  );
  await writeFile(join(directory, "contract.ts"), fixture);
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
  const entrypoints = Object.keys(manifest.exports).filter((key) => key !== "./package.json");
  await writeFile(
    join(directory, "runtime.js"),
    `
    for (const entry of ${JSON.stringify(entrypoints)})
      await import('@askrjs/server' + (entry === '.' ? '' : entry.slice(1)));
    ${await readFile("tests/packed-runtime.js", "utf8")}
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
      publicEntrypoints: entrypoints.length,
      strictTypeScript: true,
      runtime: [
        "HEAD disposal",
        "replacement disposal",
        "denial guard",
        "probe guard",
        "error handler failure",
        "aborted body",
      ],
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
