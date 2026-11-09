import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import {
  IconArrowsSort,
  IconChevronDown,
  IconChevronUp,
  IconGripVertical,
  IconPencil,
  IconPlus,
  IconRobot,
  IconSparkles,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import type { IdeaOut, WorkspaceOut } from "@shared/outputs";

import { askPilot } from "./ask-pilot";
import { CompanionDraftButton, useCompanionApps } from "./CompanionDraftButton";
import { useWorkspaceCache } from "./workspace-cache";

function ScoreRing({ value }: { value: number | null }) {
  const pct = value === null ? 0 : (value / 10) * 100;
  return (
    <div
      className="relative grid size-14 shrink-0 place-items-center rounded-full"
      style={{
        background: `conic-gradient(hsl(var(--signal)) ${pct}%, hsl(var(--muted)) ${pct}% 100%)`,
      }}
      aria-label={value === null ? "Not scored" : `Weighted score ${value} out of 10`}
    >
      <div className="grid size-11 place-items-center rounded-full bg-card">
        <span className="text-base font-semibold tracking-tight hp-tabular">{value === null ? "—" : value.toFixed(1)}</span>
      </div>
    </div>
  );
}

function IdeaEditor({
  idea,
  hackathonId,
  open,
  onOpenChange,
}: {
  idea: IdeaOut | null;
  hackathonId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [pitch, setPitch] = useState("");
  const [tags, setTags] = useState("");
  useEffect(() => {
    if (open) {
      setTitle(idea?.title ?? "");
      setPitch(idea?.pitch ?? "");
      setTags((idea?.tags ?? []).join(", "));
    }
  }, [open, idea]);
  const close = () => onOpenChange(false);
  const add = useActionMutation("add-ideas", {
    onSuccess: () => {
      toast.success("Idea added. Score it against the rubric.");
      close();
    },
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not add the idea."),
  });
  const update = useActionMutation("update-idea", {
    onSuccess: close,
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not save the idea."),
  });
  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{idea ? "Edit idea" : "New idea"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            if (idea) update.mutate({ id: idea.id, title, pitch, tags: tagList });
            else add.mutate({ hackathonId, ideas: [{ title, pitch, tags: tagList }] });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="idea-title">Title</Label>
            <Input id="idea-title" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="idea-pitch">Pitch</Label>
            <Textarea
              id="idea-pitch"
              rows={4}
              value={pitch}
              maxLength={1200}
              placeholder="Who is it for, what does the agent do, what's the demo moment?"
              onChange={(e) => setPitch(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="idea-tags">Tags (comma separated)</Label>
            <Input id="idea-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="productivity, data viz" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!title.trim() || add.isPending || update.isPending}>
              {idea ? "Save" : "Add idea"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IdeaCard({
  idea,
  rank,
  ws,
  designConnected,
  draggable,
  onEdit,
  onDelete,
  onMove,
  dragHandlers,
  dragOver,
}: {
  idea: IdeaOut;
  rank: number;
  ws: WorkspaceOut;
  designConnected: boolean | undefined;
  draggable: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
  dragHandlers: React.HTMLAttributes<HTMLElement>;
  dragOver: boolean;
}) {
  const h = ws.hackathon;
  const { patch, rollback } = useWorkspaceCache(h.id);
  const [expanded, setExpanded] = useState(false);
  const [local, setLocal] = useState<Record<string, number>>(idea.scores);
  useEffect(() => setLocal(idea.scores), [idea.scores]);

  const score = useActionMutation("score-idea", {
    onMutate: (input) =>
      patch((w) => ({
        ...w,
        ideas: w.ideas.map((i) => (i.id === input.id ? { ...i, scores: { ...i.scores, ...(input.scores ?? {}) } } : i)),
      })),
    onError: (e, _i, ctx) => rollback(ctx, e, "Could not save the score."),
  });
  const select = useActionMutation("update-idea", {
    onMutate: (input) =>
      patch((w) => ({
        ...w,
        ideas: w.ideas.map((i) => ({ ...i, selected: input.selected ? i.id === input.id : i.id === input.id ? false : i.selected })),
      })),
    onSuccess: (r) => toast.success(r.message),
    onError: (e, _i, ctx) => rollback(ctx, e, "Could not update the idea."),
  });

  return (
    <article
      {...dragHandlers}
      draggable={draggable}
      className={`group rounded-xl border bg-card p-4 transition-shadow ${idea.selected ? "border-signal/60 ring-1 ring-signal/30" : "border-border"} ${dragOver ? "hp-drag-over" : ""}`}
      aria-label={`Idea ${rank}: ${idea.title}`}
    >
      <div className="flex gap-3">
        <div className="flex flex-col items-center gap-1 pt-0.5">
          {draggable ? (
            <IconGripVertical className="size-4 cursor-grab text-muted-foreground/60 group-hover:text-muted-foreground" aria-hidden />
          ) : null}
          <span className="text-xs font-medium text-muted-foreground hp-tabular">#{rank}</span>
          {draggable ? (
            <div className="flex flex-col opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <button type="button" aria-label="Move up" className="rounded p-0.5 hover:bg-accent" onClick={() => onMove(-1)}>
                <IconChevronUp className="size-3.5" />
              </button>
              <button type="button" aria-label="Move down" className="rounded p-0.5 hover:bg-accent" onClick={() => onMove(1)}>
                <IconChevronDown className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-base font-semibold tracking-tight">
                {idea.title}
                {idea.source !== "user" ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {idea.source === "llm" ? "AI" : "Pilot"}
                  </span>
                ) : null}
              </h3>
              {idea.pitch ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{idea.pitch}</p> : null}
              {idea.tags.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {idea.tags.map((t) => (
                    <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <ScoreRing value={idea.weightedScore} />
          </div>

          {h.rubric.length ? (
            <div className="grid gap-x-6 gap-y-2 pt-1 sm:grid-cols-2">
              {h.rubric.map((c) => {
                const v = local[c.id];
                return (
                  <div key={c.id} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="truncate text-muted-foreground" title={c.description}>
                        {c.name} <span className="hp-tabular">· {c.weight}%</span>
                      </span>
                      <span className="font-medium hp-tabular">{typeof v === "number" ? v : "–"}</span>
                    </div>
                    <Slider
                      aria-label={`${c.name} score for ${idea.title}`}
                      min={0}
                      max={10}
                      step={0.5}
                      value={[typeof v === "number" ? v : 0]}
                      onValueChange={(vals) => setLocal((s) => ({ ...s, [c.id]: vals[0] ?? 0 }))}
                      onValueCommit={(vals) => score.mutate({ id: idea.id, scores: { [c.id]: vals[0] ?? 0 } })}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1 pt-1">
            <Button
              size="sm"
              variant={idea.selected ? "default" : "outline"}
              onClick={() => select.mutate({ id: idea.id, selected: !idea.selected })}
            >
              {idea.selected ? <IconStarFilled className="size-3.5" /> : <IconStar className="size-3.5" />}
              {idea.selected ? "Our pick" : "Pick this"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                askPilot(
                  `Judge the idea "${idea.title}" (id ${idea.id}) honestly against the rubric, then save scores and a one-line-per-criterion rationale with score-idea. Suggest one change that would raise its weakest score.`,
                  { id: h.id, name: h.name, tab: "ideas" },
                )
              }
            >
              <IconRobot className="size-3.5" />
              Ask Pilot to judge
            </Button>
            {idea.selected && designConnected !== undefined ? (
              <CompanionDraftButton app="design" connected={designConnected} hackathon={h} />
            ) : null}
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${idea.title}`}>
              <IconPencil className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete ${idea.title}`}>
              <IconTrash className="size-3.5" />
            </Button>
            {idea.rationale ? (
              <button
                type="button"
                className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => setExpanded((x) => !x)}
                aria-expanded={expanded}
              >
                {expanded ? "Hide rationale" : "Why these scores?"}
              </button>
            ) : null}
          </div>
          {expanded && idea.rationale ? (
            <p className="whitespace-pre-line rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
              {idea.rationale}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function IdeasTab({ ws }: { ws: WorkspaceOut }) {
  const h = ws.hackathon;
  const companions = useCompanionApps(h.id, ws.progress.selectedIdeaId !== null);
  const [sortByScore, setSortByScore] = useState(false);
  const [editing, setEditing] = useState<IdeaOut | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<IdeaOut | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const { patch, rollback } = useWorkspaceCache(h.id);

  const ideas = useMemo(() => {
    const list = [...ws.ideas];
    if (sortByScore) list.sort((a, b) => (b.weightedScore ?? -1) - (a.weightedScore ?? -1));
    return list;
  }, [ws.ideas, sortByScore]);

  const reorder = useActionMutation("reorder-ideas", {
    onMutate: (input) =>
      patch((w) => {
        const byId = new Map(w.ideas.map((i) => [i.id, i]));
        return {
          ...w,
          ideas: input.ids.flatMap((id, position) => {
            const i = byId.get(id);
            return i ? [{ ...i, position }] : [];
          }),
        };
      }),
    onError: (e, _i, ctx) => rollback(ctx, e, "Could not reorder."),
  });
  const remove = useActionMutation("update-idea", {
    onMutate: (input) => patch((w) => ({ ...w, ideas: w.ideas.filter((i) => i.id !== input.id) })),
    onSuccess: () => setDeleting(null),
    onError: (e, _i, ctx) => rollback(ctx, e, "Could not delete the idea."),
  });
  const generate = useActionMutation("generate-ideas", {
    onSuccess: (r) => toast.success(r.message),
    onError: (e) => {
      const code = e && typeof e === "object" && "errorCode" in e ? (e as { errorCode?: string }).errorCode : undefined;
      if (code === "llm_not_configured") {
        toast.message("No server model key — handing the brainstorm to Pilot instead.");
        brainstorm();
        return;
      }
      toast.error(actionErrorMessage(e) ?? "Could not generate ideas.");
    },
  });

  function brainstorm() {
    askPilot(
      "Brainstorm 4 distinct, buildable ideas for this hackathon that would score well on its rubric (avoid duplicating existing cards). Add them all with add-ideas in one call, each with honest 0-10 scores per criterion and a short rationale.",
      { id: h.id, name: h.name, tab: "ideas" },
    );
  }

  function move(id: string, delta: number) {
    const ids = ws.ideas.map((i) => i.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    reorder.mutate({ hackathonId: h.id, ids });
  }

  function drop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = ws.ideas.map((i) => i.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    reorder.mutate({ hackathonId: h.id, ids });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          <IconPlus className="size-4" />
          New idea
        </Button>
        <Button variant="outline" onClick={brainstorm}>
          <IconSparkles className="size-4" />
          Brainstorm with Pilot
        </Button>
        <Button
          variant="ghost"
          disabled={generate.isPending}
          onClick={() => generate.mutate({ hackathonId: h.id, count: 3 })}
          title="One-shot generation with the server model (OPENROUTER_API_KEY)"
        >
          <IconWand className="size-4" />
          {generate.isPending ? "Generating…" : "Quick generate"}
        </Button>
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() => setSortByScore((s) => !s)}
          aria-pressed={sortByScore}
        >
          <IconArrowsSort className="size-4" />
          {sortByScore ? "Ranked by score" : "Your order"}
        </Button>
      </div>

      {!h.rubric.length ? (
        <p className="rounded-lg bg-signal-soft p-3 text-sm">
          Add judging criteria on the Overview tab to score ideas.
        </p>
      ) : null}

      {ideas.length ? (
        <div className="space-y-3">
          {ideas.map((idea, index) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              rank={index + 1}
              ws={ws}
              designConnected={companions?.canEdit ? companions.connected.design : undefined}
              draggable={!sortByScore}
              dragOver={overId === idea.id && dragId !== idea.id}
              onEdit={() => {
                setEditing(idea);
                setEditorOpen(true);
              }}
              onDelete={() => setDeleting(idea)}
              onMove={(d) => move(idea.id, d)}
              dragHandlers={
                sortByScore
                  ? {}
                  : {
                      onDragStart: (e) => {
                        setDragId(idea.id);
                        e.dataTransfer.effectAllowed = "move";
                      },
                      onDragOver: (e) => {
                        e.preventDefault();
                        setOverId(idea.id);
                      },
                      onDragLeave: () => setOverId((o) => (o === idea.id ? null : o)),
                      onDrop: (e) => {
                        e.preventDefault();
                        drop(idea.id);
                        setDragId(null);
                        setOverId(null);
                      },
                      onDragEnd: () => {
                        setDragId(null);
                        setOverId(null);
                      },
                    }
              }
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">No ideas yet. Add your own or let Pilot brainstorm against the rubric.</p>
        </div>
      )}

      <IdeaEditor idea={editing} hackathonId={h.id} open={editorOpen} onOpenChange={setEditorOpen} />
      <AlertDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>Its scores and rationale go with it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove.mutate({ id: deleting.id, delete: true })}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
