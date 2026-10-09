/**
 * Local operator-installed capability adapters, never uploaded by a phone.
 * One process per typed invocation, fixed executable/argv, no shell and a
 * minimal environment. Adapters supply their own real hardware/evidence
 * contract; this layer cannot claim robot or vehicle mission completion.
 */
import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import type { Flyto2CapabilityTransport } from "./capability-transport.js";
import { runtimeManifest } from "./manifest.js";
import {
  flyto2CapabilitySchema,
  flyto2CapabilityResultSchema,
  type Flyto2CapabilityInvocation,
  type Flyto2CapabilityResult,
} from "./protocol.js";

const installedAdapterSchema = z.object({
  capability: flyto2CapabilitySchema,
  executable: z.string().trim().min(1).max(1024),
  argv: z.array(z.string().max(4096)).max(16).default([]),
  timeout_ms: z.number().int().min(1000).max(60_000).default(15_000),
}).strict();
const installedManifestSchema = z.object({
  schema: z.literal("flyto2.local-adapters.v1"),
  adapters: z.array(installedAdapterSchema).min(1).max(32),
}).strict();

export type InstalledAdapter = z.infer<typeof installedAdapterSchema>;

export function readInstalledAdapterManifest(file: string): InstalledAdapter[] {
  if (!isAbsolute(file)) throw new Error("Adapter manifest must be an absolute local path");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Adapter manifest must be a regular local file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error("Adapter manifest must not be group/world writable");
  }
  const data = readFileSync(file, "utf8");
  if (data.length > 64_000) throw new Error("Adapter manifest too large");
  return installedManifestSchema.parse(JSON.parse(data)).adapters;
}

/** Resolve only operator-configured binaries, never strings supplied by app. */
export function createInstalledAdapterTransport(
  config: ServerConfig,
  definitions: readonly InstalledAdapter[],
): Flyto2CapabilityTransport {
  const adapters = new Map<string, InstalledAdapter>();
  for (const raw of definitions) {
    const adapter = installedAdapterSchema.parse(raw);
    if (!isAbsolute(adapter.executable) ||
        adapter.executable.includes("\n") ||
        adapter.argv.some(arg => arg.includes("\0"))) {
      throw new Error("Adapter executable and arguments must be explicit");
    }
    const stat = lstatSync(adapter.executable);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Adapter executable must be a regular file");
    }
    const key = adapter.capability.id + "@" + adapter.capability.revision;
    if (adapters.has(key)) throw new Error("Duplicate adapter: " + key);
    adapters.set(key, adapter);
  }
  return {
    manifest: () => runtimeManifest(config, definitions.map(d => d.capability)),
    invoke: (input, signal) => {
      const key = input.capability + "@" + input.revision;
      const adapter = adapters.get(key);
      if (!adapter) throw new Error("Uninstalled adapter");
      return runInstalledAdapter(adapter, input, signal);
    },
  };
}

export function joinRuntimeAndInstalledTransports(
  runtime: Flyto2CapabilityTransport,
  installed: Flyto2CapabilityTransport,
): Flyto2CapabilityTransport {
  const original = runtime.manifest();
  const extension = installed.manifest();
  const seen = new Set(original.capabilities.map(c => c.id + "@" + c.revision));
  for (const item of extension.capabilities) {
    const key = item.id + "@" + item.revision;
    if (seen.has(key)) throw new Error("Duplicate Runtime/installed capability: " + key);
    seen.add(key);
  }
  const extra = new Set(extension.capabilities.map(c => c.id + "@" + c.revision));
  return {
    manifest: () => ({
      ...runtime.manifest(),
      capabilities: [...runtime.manifest().capabilities, ...installed.manifest().capabilities],
    }),
    invoke: (invocation, signal) => (
      extra.has(invocation.capability + "@" + invocation.revision)
        ? installed.invoke(invocation, signal)
        : runtime.invoke(invocation, signal)
    ),
  };
}

async function runInstalledAdapter(
  adapter: InstalledAdapter,
  request: Flyto2CapabilityInvocation,
  signal?: AbortSignal,
): Promise<Flyto2CapabilityResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.executable, adapter.argv, {
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      windowsHide: true,
      signal,
    });
    let output = "";
    let finished = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), adapter.timeout_ms);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      output += text;
      if (output.length > 64_000) child.kill("SIGKILL");
    });
    child.once("error", error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", code => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (code !== 0 || output.length > 64_000) {
        reject(new Error("Installed capability provider did not complete"));
        return;
      }
      try {
        const result = flyto2CapabilityResultSchema.parse(JSON.parse(output));
        if (result.invocation_id !== request.invocation_id ||
            result.capability !== request.capability ||
            result.revision !== request.revision) {
          throw new Error("Capability provider identity mismatch");
        }
        resolve(result);
      } catch {
        reject(new Error("Installed provider returned invalid result/evidence"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}
