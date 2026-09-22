import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import semver from "semver";
import { flyto2NativeRuntimeHome } from "./macos-tunnel.js";

const DEFAULT_RELEASE_API =
  "https://api.github.com/repos/flytohub/flyto-runtime/releases/latest";

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  assets?: unknown;
}

export interface Flyto2ReleaseArtifact {
  version: string;
  tag: string;
  tarball_name: string;
  tarball_url: string;
  checksum_name: string;
  checksum_url: string;
}

export interface InstalledFlyto2Release extends Flyto2ReleaseArtifact {
  package_root: string;
  release_root: string;
  sha256: string;
  installed: boolean;
}

export interface InstallLatestReleaseOptions {
  fetchImpl?: typeof fetch;
  homeDirectory?: string;
  releaseApi?: string;
  npmCommand?: string;
}

export async function latestFlyto2ReleaseArtifact(
  options: Pick<InstallLatestReleaseOptions, "fetchImpl" | "releaseApi"> = {},
): Promise<Flyto2ReleaseArtifact> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.releaseApi ?? DEFAULT_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Flyto2-Runtime",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub Release lookup failed (${response.status} ${response.statusText}).`,
    );
  }

  const release = await response.json() as GitHubRelease;
  const tag = requiredString(release.tag_name, "release tag");
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!semver.valid(version)) {
    throw new Error(`Latest GitHub Release tag is not a valid Runtime version: ${tag}`);
  }

  const assets = Array.isArray(release.assets)
    ? release.assets as GitHubReleaseAsset[]
    : [];
  const tarballName = `flyto2-runtime-${version}.tgz`;
  const checksumName = `${tarballName}.sha256`;
  const tarballUrl = releaseAssetUrl(assets, tarballName);
  const checksumUrl = releaseAssetUrl(assets, checksumName);

  return {
    version,
    tag,
    tarball_name: tarballName,
    tarball_url: tarballUrl,
    checksum_name: checksumName,
    checksum_url: checksumUrl,
  };
}

export async function installLatestFlyto2Release(
  options: InstallLatestReleaseOptions = {},
): Promise<InstalledFlyto2Release> {
  const artifact = await latestFlyto2ReleaseArtifact(options);
  const homeDirectory = options.homeDirectory ?? homedir();
  const releaseRoot = join(
    flyto2NativeRuntimeHome(homeDirectory),
    "releases",
    artifact.tag,
  );
  const packageRoot = join(
    releaseRoot,
    "node_modules",
    "flyto2-runtime",
  );

  if (isInstalledPackageVersion(packageRoot, artifact.version)) {
    return {
      ...artifact,
      package_root: packageRoot,
      release_root: releaseRoot,
      sha256: "",
      installed: false,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const tempRoot = mkdtempSync(join(tmpdir(), "flyto2-runtime-update-"));
  try {
    const tarball = join(tempRoot, artifact.tarball_name);
    const checksumFile = join(tempRoot, artifact.checksum_name);
    await Promise.all([
      download(fetchImpl, artifact.tarball_url, tarball),
      download(fetchImpl, artifact.checksum_url, checksumFile),
    ]);

    const expectedSha = parseSha256(
      readFileSync(checksumFile, "utf8"),
      artifact.tarball_name,
    );
    const actualSha = createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex");
    if (actualSha !== expectedSha) {
      throw new Error(
        `GitHub Release checksum mismatch for ${artifact.tarball_name}.`,
      );
    }

    mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
    const npmCommand = options.npmCommand ?? "npm";
    const install = spawnSync(
      npmCommand,
      [
        "install",
        "--prefix",
        releaseRoot,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { encoding: "utf8" },
    );
    if (install.status !== 0) {
      throw new Error(
        `Flyto2 Runtime release install failed: ${(install.stderr || install.stdout || "").trim()}`,
      );
    }
    if (!isInstalledPackageVersion(packageRoot, artifact.version)) {
      throw new Error(
        `Installed GitHub Release did not produce flyto2-runtime@${artifact.version}.`,
      );
    }
    if (!existsSync(join(packageRoot, "dist", "cli.js"))) {
      throw new Error("Installed GitHub Release is missing its compiled CLI entrypoint.");
    }

    return {
      ...artifact,
      package_root: packageRoot,
      release_root: releaseRoot,
      sha256: actualSha,
      installed: true,
    };
  } catch (error) {
    if (!isInstalledPackageVersion(packageRoot, artifact.version)) {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function parseSha256(content: string, expectedFilename: string): string {
  const line = content.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = /^([0-9a-f]{64})(?:\s+\*?(.+))?$/i.exec(line.trim());
  if (!match?.[1]) throw new Error("GitHub Release checksum file is invalid.");
  const filename = match[2]?.trim();
  if (filename && basename(filename) !== expectedFilename) {
    throw new Error(
      `GitHub Release checksum names ${filename} instead of ${expectedFilename}.`,
    );
  }
  return match[1].toLowerCase();
}

async function download(
  fetchImpl: typeof fetch,
  url: string,
  destination: string,
): Promise<void> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "Flyto2-Runtime",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub Release asset download failed (${response.status} ${response.statusText}).`,
    );
  }
  const data = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, data, { mode: 0o600 });
}

function releaseAssetUrl(
  assets: GitHubReleaseAsset[],
  expectedName: string,
): string {
  const asset = assets.find((candidate) => candidate.name === expectedName);
  return requiredString(
    asset?.browser_download_url,
    `GitHub Release asset ${expectedName}`,
  );
}

function isInstalledPackageVersion(
  packageRoot: string,
  version: string,
): boolean {
  const packageJson = join(packageRoot, "package.json");
  if (!existsSync(packageJson)) return false;
  try {
    const value = JSON.parse(readFileSync(packageJson, "utf8")) as {
      version?: unknown;
    };
    return value.version === version;
  } catch {
    return false;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is missing.`);
  }
  return value.trim();
}
