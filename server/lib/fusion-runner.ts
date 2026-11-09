import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const IMAGE = "node:22-bookworm-slim";
const DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
const REGISTRY = "https://registry.npmjs.org";
const MAX_OUTPUT = 24_000;
const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_TIMEOUT_MS = 240_000;

interface FusionRunResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
  ms: number;
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const registryName = /^(?:@[a-z0-9_-][a-z0-9_.-]*\/)?[a-z0-9_-][a-z0-9_.-]*$/;
const registryVersion = /^[~^<>=*xXvV\d][\w.+~^<>=*| -]*$/;
const registryTarball =
  /^https:\/\/registry\.npmjs\.org\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+\/-\/[a-zA-Z0-9_.+-]+\.tgz$/;
const sha512Integrity = /^sha512-[A-Za-z0-9+/=]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRegistryVersions(entry: Record<string, unknown>) {
  return dependencyFields.every((field) => {
    const dependencies = entry[field];
    return (
      dependencies === undefined ||
      (isObject(dependencies) &&
        Object.entries(dependencies).every(
          ([name, value]) =>
            registryName.test(name) &&
            typeof value === "string" &&
            registryVersion.test(value),
        ))
    );
  });
}

async function readManifest(dir: string, name: string): Promise<unknown> {
  const file = path.join(dir, name);
  const info = await fs.lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw new Error(
      `Fusion verification requires a regular ${name} under 2 MB.`,
    );
  }
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new Error(`Fusion verification could not read ${name} as JSON.`);
  }
}

// Only npm ci can access the container network. Validate its inputs before
// starting the container and disable install scripts and repository config.
async function validateInstall(dir: string) {
  try {
    await fs.lstat(path.join(dir, ".npmrc"));
    throw new Error("Fusion verification does not allow a project .npmrc.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifest = await readManifest(dir, "package.json");
  const lock = await readManifest(dir, "package-lock.json");
  if (
    !isObject(manifest) ||
    !hasRegistryVersions(manifest) ||
    "workspaces" in manifest ||
    "overrides" in manifest
  ) {
    throw new Error(
      "Fusion verification requires ordinary npm registry dependencies.",
    );
  }
  if (
    !isObject(lock) ||
    lock.lockfileVersion !== 3 ||
    !isObject(lock.packages) ||
    !isObject(lock.packages[""])
  ) {
    throw new Error(
      "Fusion verification requires an npm v3 package-lock.json.",
    );
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!isObject(entry) || !hasRegistryVersions(entry) || entry.link) {
      throw new Error(
        "Fusion verification does not allow linked or non-registry dependencies.",
      );
    }
    if (
      name &&
      (!name.startsWith("node_modules/") ||
        !name
          .slice("node_modules/".length)
          .split("/node_modules/")
          .every((part) => registryName.test(part)) ||
        typeof entry.resolved !== "string" ||
        !registryTarball.test(entry.resolved) ||
        typeof entry.integrity !== "string" ||
        !sha512Integrity.test(entry.integrity))
    ) {
      throw new Error(
        "Fusion verification requires integrity-checked tarballs from registry.npmjs.org.",
      );
    }
  }
}

function runDocker(
  config: string,
  args: string[],
  timeoutMs: number,
): Promise<FusionRunResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      "docker",
      ["--config", config, "--host", `unix://${DOCKER_SOCKET}`, ...args],
      {
        cwd: config,
        env: { PATH: DOCKER_PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const append = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => append(error.message));
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        output,
        timedOut,
        ms: Date.now() - start,
      });
    });
  });
}

/** Run only in a local Docker daemon. A missing daemon/image fails verification. */
export function createFusionRunner(dir: string) {
  return {
    async run(
      command: "npm" | "npx",
      args: string[],
      timeoutMs: number,
    ): Promise<FusionRunResult> {
      const start = Date.now();
      let config: string | undefined;
      try {
        if (!(await fs.stat(DOCKER_SOCKET).catch(() => null))?.isSocket()) {
          throw new Error(
            "Fusion verification requires a local Docker daemon and the node:22-bookworm-slim image.",
          );
        }
        const workDir = await fs.realpath(dir);
        const owner = await fs.stat(workDir);
        if (
          !owner.isDirectory() ||
          owner.uid === 0 ||
          /[,\r\n]/.test(workDir)
        ) {
          throw new Error(
            "Fusion verification requires an isolated build directory owned by a non-root user.",
          );
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
          throw new Error("Invalid Fusion check timeout.");
        const budget = Math.min(timeoutMs, MAX_TIMEOUT_MS);
        const installing = command === "npm" && args[0] === "ci";
        if (installing) await validateInstall(workDir);
        else if (command !== "npx" || args[0] !== "--no-install")
          throw new Error("Unsupported Fusion verification command.");
        const commandArgs = installing
          ? [
              "ci",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--loglevel=error",
              `--registry=${REGISTRY}`,
              "--userconfig=/tmp/fusion-user.npmrc",
              "--globalconfig=/tmp/fusion-global.npmrc",
            ]
          : args;
        const mounts = installing
          ? ["--mount", `type=bind,src=${workDir},dst=/workspace`]
          : [
              "--mount",
              `type=bind,src=${workDir},dst=/source,readonly`,
              "--tmpfs",
              "/workspace:rw,exec,nosuid,nodev,size=536870912,mode=1777",
            ];
        const checkCommand = installing
          ? [command, ...commandArgs]
          : [
              "/bin/sh",
              "-c",
              'cp -RP /source/. /workspace/project && cd /workspace/project && exec "$@"',
              "fusion-check",
              command,
              ...commandArgs,
            ];

        // Do not use the service account's Docker config, which can inject proxies.
        config = await fs.mkdtemp(
          path.join(os.tmpdir(), "hackpilot-fusion-docker-"),
        );
        const name = `hackpilot-fusion-${randomUUID()}`;
        const result = await runDocker(
          config,
          [
            "run",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--init",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--network",
            installing ? "bridge" : "none",
            "--cpus=1",
            "--memory=768m",
            "--memory-swap=768m",
            "--pids-limit=128",
            "--ulimit=fsize=67108864:67108864",
            "--log-driver=none",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777",
            ...mounts,
            "--workdir=/workspace",
            "--user",
            `${owner.uid}:${owner.gid}`,
            "--env=HOME=/tmp",
            "--env=CI=1",
            "--env=npm_config_update_notifier=false",
            "--entrypoint=/usr/bin/timeout",
            IMAGE,
            "--signal=KILL",
            `${Math.ceil(budget / 1000)}s`,
            ...checkCommand,
          ],
          budget + 2_000,
        );
        if (!result.ok) {
          // Killing the CLI does not guarantee it stopped the container. The
          // in-container timeout also limits execution if the daemon is unreachable.
          await runDocker(config, ["rm", "--force", name], 5_000);
        }
        return result;
      } catch (error) {
        return {
          ok: false,
          code: null,
          timedOut: false,
          ms: Date.now() - start,
          output:
            error instanceof Error
              ? error.message
              : "Fusion sandbox unavailable.",
        };
      } finally {
        if (config)
          await fs.rm(config, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
