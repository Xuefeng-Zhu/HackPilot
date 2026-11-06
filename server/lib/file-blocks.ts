import type { GenFile } from "./build-template.js";

/**
 * Parse `=== FILE: path === … === END FILE ===` blocks. A block also ends at
 * the next FILE header (models sometimes drop the END marker) and inner
 * markdown fences are stripped.
 */
export function parseFileBlocks(text: string): { files: GenFile[]; notes: string } {
  const files: GenFile[] = [];
  const header = /^=== ?FILE:\s*(.+?)\s*===\s*$/gm;
  const heads = [...text.matchAll(header)];
  heads.forEach((m, i) => {
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < heads.length ? (heads[i + 1]?.index ?? text.length) : text.length;
    let content = text.slice(from, to).replace(/^\r?\n/, "");
    const endAt = content.search(/^=== ?END FILE ?===/m);
    if (endAt >= 0) content = content.slice(0, endAt);
    else content = content.replace(/^NOTES:.*$/m, "");
    content = content.replace(/\s+$/, "");
    const fenced = content.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
    if (fenced?.[1] !== undefined) content = fenced[1];
    const path = (m[1] ?? "").trim().replace(/^`|`$/g, "");
    if (path && content.trim()) files.push({ path, content: `${content}\n` });
  });
  const notes = text.match(/^NOTES:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { files, notes };
}
