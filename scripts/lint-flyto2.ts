import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const flyto2Dir = join(rootPath, "src", "flyto2");

const forbiddenImports = [
  "flyto-cloud",
  "../flyto-cloud",
  "@flyto/cloud",
  "firebase-admin",
];

const failures: string[] = [];

for (const file of walk(flyto2Dir)) {
  if (!file.endsWith(".ts")) continue;
  const content = readFileSync(file, "utf8");
  for (const specifier of importSpecifiers(content)) {
    for (const forbidden of forbiddenImports) {
      if (specifier.includes(forbidden)) {
        failures.push(`${relative(rootPath, file)} imports forbidden Cloud implementation module: ${specifier}`);
      }
    }
  }
  if (/dist\/(?:server|cli)\.js/.test(content) || /patch.*compiled javascript/i.test(content)) {
    failures.push(`${relative(rootPath, file)} appears to patch compiled JavaScript; Flyto2 Runtime behavior must be source-native TypeScript.`);
  }
}

const packageJson = JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8")) as {
  name?: string;
  license?: string;
  bin?: Record<string, string>;
};
if (packageJson.name !== "flyto2-runtime") failures.push("package name must be flyto2-runtime");
if (packageJson.license !== "MIT") failures.push("fork must preserve MIT license");
if (packageJson.bin?.["flyto2-runtime"] !== "bin/devspace.js") {
  failures.push("flyto2-runtime binary must be present");
}
if (packageJson.bin?.devspace !== "bin/devspace.js") {
  failures.push("devspace compatibility alias must remain present");
}

const license = readFileSync(join(rootPath, "LICENSE"), "utf8");
if (!license.includes("Copyright (c) 2026 Waishnav")) {
  failures.push("upstream MIT copyright notice must remain intact");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Flyto2 Runtime architecture lint: PASS");
}

function walk(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

function importSpecifiers(content: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}
