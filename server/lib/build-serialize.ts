import { buildDownloadUrl, buildPreviewUrl, type BuildOut } from "../../shared/build.js";
import type { schema } from "../db/index.js";
import { hasPreview } from "./builder.js";

type BuildRow = typeof schema.builds.$inferSelect;

export function serializeBuild(row: BuildRow): BuildOut {
  return {
    id: row.id,
    hackathonId: row.hackathonId,
    ideaId: row.ideaId,
    ideaTitle: row.ideaTitle,
    status: (["running", "passed", "failed"].includes(row.status) ? row.status : "failed") as BuildOut["status"],
    stage: row.stage,
    mode: row.mode,
    rounds: row.rounds,
    steps: row.steps ?? [],
    files: row.files ?? [],
    meta: row.meta ?? {},
    notes: row.notes,
    error: row.error,
    downloadUrl: row.status === "passed" && row.meta?.zipBytes ? buildDownloadUrl(row.id) : null,
    previewUrl: row.mode !== "fusion" && row.status === "passed" && hasPreview(row.dir) ? buildPreviewUrl(row.id) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}
