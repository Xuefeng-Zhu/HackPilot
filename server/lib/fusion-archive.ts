import { crc32 } from "node:zlib";

import { fail } from "@agent-native/core/action";
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";

import { MAX_FUSION_ARCHIVE_BYTES } from "../../shared/build.js";

const MAX_ENTRIES = 120;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;
const STARTER_FILES = new Set([
  ".gitignore",
  "README.md",
  "index.html",
  "package.json",
  "package-lock.json",
  "smoke.test.ts",
  "tsconfig.json",
  "vite.config.ts",
]);
const ASSET_EXTENSIONS = /\.(?:avif|css|gif|ico|jpeg|jpg|json|png|svg|webp|woff2?)$/i;
const SOURCE_EXTENSIONS = /\.(?:js|jsx|mjs|ts|tsx)$/i;

class InvalidArchive extends Error {
  constructor(message: string, readonly tooLarge = false) {
    super(message);
  }
}

async function readEntries(zip: ZipFile): Promise<Entry[]> {
  const entries: Entry[] = [];
  for await (const entry of zip.eachEntry()) {
    if (entries.length >= MAX_ENTRIES) {
      throw new InvalidArchive("The Fusion ZIP has too many files or folders.", true);
    }
    entries.push(entry);
  }
  return entries;
}

function inspectEntry(entry: Entry) {
  const directory = entry.fileName.endsWith("/");
  const filename = directory ? entry.fileName.slice(0, -1) : entry.fileName;
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;
  if (
    filename.length > 240 ||
    filename.split("/").some((part) => (
      part !== ".gitignore" &&
      (!/^[\w@-][\w@. -]*$/.test(part) || /[. ]$/.test(part) ||
        /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    )) ||
    (unixType !== 0 && unixType !== (directory ? 0o040000 : 0o100000)) ||
    (dosDirectory && !directory) ||
    (directory && entry.uncompressedSize !== 0) ||
    (entry.generalPurposeBitFlag & 0x2041) !== 0 ||
    !entry.canDecodeFileData()
  ) {
    throw new InvalidArchive("The Fusion ZIP contains an unsafe path, link, or encrypted entry.");
  }
  return { entry, filename, directory };
}

function validatePaths(entries: Entry[]) {
  const inspected = entries.map(inspectEntry);
  const wrapper = inspected.some(({ filename }) => filename === "package.json")
    ? undefined
    : inspected.find(({ filename }) => /^[^/]+\/package\.json$/.test(filename))?.filename.split("/")[0];
  const explicit = new Set<string>();
  const paths = new Map<string, { path: string; directory: boolean }>();
  const files: { entry: Entry; path: string }[] = [];
  let total = 0;

  for (const { entry, filename, directory } of inspected) {
    const key = filename.toLowerCase();
    if (explicit.has(key)) throw new InvalidArchive("The Fusion ZIP contains duplicate paths.");
    explicit.add(key);
    if (wrapper && directory && filename === wrapper) continue;
    if (wrapper && !filename.startsWith(`${wrapper}/`)) {
      throw new InvalidArchive("The Fusion ZIP must contain a single starter project.");
    }
    const path = wrapper ? filename.slice(wrapper.length + 1) : filename;
    const segments = path.split("/");
    const root = segments[0];
    const inSource = root === "src" || root === "public";
    if (
      segments.some((segment) => segment.toLowerCase() === "node_modules") ||
      (segments.length > 1 && segments.includes(".gitignore")) ||
      (directory ? !inSource : !STARTER_FILES.has(path) && !(
        inSource && segments.length > 1 &&
        (ASSET_EXTENSIONS.test(path) || (root === "src" && SOURCE_EXTENSIONS.test(path)))
      ))
    ) {
      throw new InvalidArchive("Use Fusion’s source ZIP with the starter files and src or public assets.");
    }

    for (let depth = 1; depth <= segments.length; depth++) {
      const prefix = segments.slice(0, depth).join("/");
      const prefixKey = prefix.toLowerCase();
      const isDirectory = depth < segments.length || directory;
      const previous = paths.get(prefixKey);
      if (previous && (previous.path !== prefix || previous.directory !== isDirectory)) {
        throw new InvalidArchive("The Fusion ZIP contains conflicting paths.");
      }
      paths.set(prefixKey, { path: prefix, directory: isDirectory });
    }

    if (directory) continue;
    total += entry.uncompressedSize;
    if (entry.uncompressedSize > MAX_FILE_BYTES || total > MAX_EXPANDED_BYTES) {
      throw new InvalidArchive("The Fusion ZIP expands beyond the supported size.", true);
    }
    files.push({ entry, path });
  }
  if (!files.some(({ path }) => path === "package.json")) {
    throw new InvalidArchive("The Fusion ZIP must contain the starter’s package.json.");
  }
  return files;
}

async function readFile(zip: ZipFile, entry: Entry): Promise<Buffer> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > entry.uncompressedSize) throw new InvalidArchive("The Fusion ZIP has an invalid file size.");
    chunks.push(buffer);
  }
  const content = Buffer.concat(chunks, size);
  if (size !== entry.uncompressedSize || crc32(content) !== entry.crc32) {
    throw new InvalidArchive("The Fusion ZIP contains a corrupted file.");
  }
  return content;
}

export async function decodeFusionArchive(archive: string): Promise<{ path: string; content: Buffer }[]> {
  if (archive.length > Math.ceil(MAX_FUSION_ARCHIVE_BYTES / 3) * 4) {
    fail("Choose a Fusion ZIP of 2 MB or less.", { errorCode: "fusion_archive_too_large", statusCode: 413 });
  }
  const data = Buffer.from(archive, "base64");
  if (data.length > MAX_FUSION_ARCHIVE_BYTES) {
    fail("Choose a Fusion ZIP of 2 MB or less.", { errorCode: "fusion_archive_too_large", statusCode: 413 });
  }
  if (!data.length || data.toString("base64") !== archive) {
    fail("Choose a valid Fusion ZIP file.", { errorCode: "invalid_fusion_archive", statusCode: 400 });
  }

  let zip: ZipFile | undefined;
  try {
    zip = await fromBufferPromise(data, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
    if (zip.entryCount > MAX_ENTRIES) throw new InvalidArchive("The Fusion ZIP has too many files or folders.", true);
    const entries = validatePaths(await readEntries(zip));
    const files: { path: string; content: Buffer }[] = [];
    for (const { path, entry } of entries) {
      files.push({ path, content: await readFile(zip, entry) });
    }
    return files;
  } catch (error) {
    const tooLarge = error instanceof InvalidArchive && error.tooLarge;
    return fail(error instanceof InvalidArchive ? error.message : "Choose a valid, unencrypted Fusion ZIP file.", {
      errorCode: tooLarge ? "fusion_archive_too_large" : "invalid_fusion_archive",
      statusCode: tooLarge ? 413 : 400,
    });
  } finally {
    zip?.close();
  }
}
