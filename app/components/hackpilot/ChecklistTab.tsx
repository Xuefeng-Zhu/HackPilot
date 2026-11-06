import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import {
  IconCircle,
  IconCircleCheckFilled,
  IconCircleHalf2,
  IconExternalLink,
  IconPlus,
  IconRobot,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SUBMISSION_KIND_LABELS,
  SUBMISSION_KINDS,
  type SubmissionKind,
  type SubmissionStatus,
} from "@shared/hackpilot";
import type { SubmissionItemOut, WorkspaceOut } from "@shared/outputs";

import { askPilot } from "./ask-pilot";
import { useWorkspaceCache } from "./workspace-cache";

const NEXT: Record<string, SubmissionStatus> = { todo: "in_progress", in_progress: "done", done: "todo" };

function StatusButton({ status, onClick, label }: { status: string; onClick: () => void; label: string }) {
  const Icon = status === "done" ? IconCircleCheckFilled : status === "in_progress" ? IconCircleHalf2 : IconCircle;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${status.replace("_", " ")}. Click to advance.`}
      className={`rounded-full p-0.5 transition-colors hover:bg-accent ${status === "done" ? "text-signal" : status === "in_progress" ? "text-foreground" : "text-muted-foreground"}`}
    >
      <Icon className="size-5" />
    </button>
  );
}

function ItemRow({ item, ws }: { item: SubmissionItemOut; ws: WorkspaceOut }) {
  const { patch, rollback } = useWorkspaceCache(ws.hackathon.id);
  const [link, setLink] = useState(item.link ?? "");
  useEffect(() => setLink(item.link ?? ""), [item.link]);
  const update = useActionMutation("update-submission-item", {
    onMutate: (input) =>
      patch((w) => ({
        ...w,
        submissionItems: input.delete
          ? w.submissionItems.filter((s) => s.id !== input.id)
          : w.submissionItems.map((s) =>
              s.id === input.id
                ? {
                    ...s,
                    ...(input.status ? { status: input.status } : {}),
                    ...(input.link !== undefined ? { link: input.link } : {}),
                  }
                : s,
            ),
      })),
    onError: (e, _i, ctx) => rollback(ctx, e, "Could not update the checklist."),
  });
  const needsLink = ["demo_video", "repo", "deployment", "form"].includes(item.kind);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <StatusButton
          status={item.status}
          label={item.label}
          onClick={() => update.mutate({ id: item.id, status: NEXT[item.status] ?? "todo" })}
        />
        <div className="min-w-0">
          <p className={`text-sm font-medium ${item.status === "done" ? "text-muted-foreground line-through" : ""}`}>{item.label}</p>
          <p className="text-xs text-muted-foreground">
            {SUBMISSION_KIND_LABELS[item.kind as SubmissionKind] ?? item.kind}
            {item.detail ? ` · ${item.detail}` : ""}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 pl-8 sm:w-80 sm:pl-0">
        {needsLink ? (
          <>
            <Input
              aria-label={`Proof link for ${item.label}`}
              value={link}
              placeholder="https:// link (video, repo, live app…)"
              className="h-8 text-xs"
              onChange={(e) => setLink(e.target.value)}
              onBlur={() => {
                const next = link.trim();
                if (next === (item.link ?? "")) return;
                if (next && !/^https?:\/\//i.test(next)) {
                  toast.error("Links must start with http:// or https://");
                  return;
                }
                update.mutate({ id: item.id, link: next || null });
              }}
            />
            {item.link ? (
              <a href={item.link} target="_blank" rel="noreferrer" aria-label="Open link" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <IconExternalLink className="size-4" />
              </a>
            ) : null}
          </>
        ) : (
          <span className="flex-1" />
        )}
        <Button size="icon" variant="ghost" aria-label={`Remove ${item.label}`} onClick={() => update.mutate({ id: item.id, delete: true })}>
          <IconTrash className="size-4" />
        </Button>
      </div>
    </li>
  );
}

export function ChecklistTab({ ws }: { ws: WorkspaceOut }) {
  const h = ws.hackathon;
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<SubmissionKind>("other");
  const add = useActionMutation("update-submission-item", {
    onSuccess: () => {
      setLabel("");
      setKind("other");
    },
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not add the item."),
  });
  const done = ws.progress.submissionDone;
  const total = ws.progress.submissionTotal;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_18rem]">
      <section className="rounded-xl border border-border bg-card px-4">
        {ws.submissionItems.length ? (
          <ul className="divide-y divide-border">
            {ws.submissionItems.map((item) => (
              <ItemRow key={item.id} item={item} ws={ws} />
            ))}
          </ul>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">No submission requirements yet.</p>
        )}
        <form
          className="flex flex-col gap-2 border-t border-border py-3 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) add.mutate({ hackathonId: h.id, label: label.trim(), kind });
          }}
        >
          <Input
            aria-label="New checklist item"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Add a requirement…"
            className="h-9 flex-1"
          />
          <Select value={kind} onValueChange={(v) => setKind(v as SubmissionKind)}>
            <SelectTrigger className="h-9 sm:w-40" aria-label="Kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBMISSION_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {SUBMISSION_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" variant="outline" className="h-9" disabled={!label.trim() || add.isPending}>
            <IconPlus className="size-4" /> Add
          </Button>
        </form>
      </section>
      <aside className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Ready to submit</h2>
          <span className="text-2xl font-semibold text-signal hp-tabular">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-signal transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground hp-tabular">
          {done} of {total} items done. Click a circle to move it from to-do → in progress → done.
        </p>
        <Button
          variant="outline"
          className="w-full"
          onClick={() =>
            askPilot(
              "Am I ready to submit? Run check-submission, then tell me exactly what's left in priority order and draft the project write-up if it's missing.",
              { id: h.id, name: h.name, tab: "checklist" },
            )
          }
        >
          <IconRobot className="size-4" />
          Readiness check with Pilot
        </Button>
      </aside>
    </div>
  );
}
