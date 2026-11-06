import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import {
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type Criterion, formatMoney, type Prize, slugKey } from "@shared/hackpilot";
import type { WorkspaceOut } from "@shared/outputs";
import { formatInZone, isValidTimezone } from "@shared/time";

import { askPilot } from "./ask-pilot";
import { useWorkspaceCache } from "./workspace-cache";

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "YYYY-MM-DDTHH:mm" wall time of an instant in a timezone. */
function wallTime(iso: string | null, tz: string): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function DeadlineDialog({ ws, open, onOpenChange }: { ws: WorkspaceOut; open: boolean; onOpenChange: (o: boolean) => void }) {
  const h = ws.hackathon;
  const [local, setLocal] = useState(wallTime(h.deadlineAt, h.timezone));
  const [tz, setTz] = useState(h.timezone);
  useEffect(() => {
    if (open) {
      setLocal(wallTime(h.deadlineAt, h.timezone));
      setTz(h.timezone);
    }
  }, [open, h.deadlineAt, h.timezone]);
  const update = useActionMutation("update-hackathon", {
    onSuccess: () => {
      toast.success("Deadline saved.");
      onOpenChange(false);
    },
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not save the deadline."),
  });
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) && isValidTimezone(tz);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submission deadline</DialogTitle>
          <DialogDescription>Enter it exactly as the organizer publishes it, in their timezone.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="deadline-local">Date and time</Label>
            <Input id="deadline-local" type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="deadline-tz">Timezone (IANA)</Label>
            <Input id="deadline-tz" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/Los_Angeles" />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!valid || update.isPending}
            onClick={() => update.mutate({ id: h.id, deadlineLocal: local, timezone: tz })}
          >
            {update.isPending ? "Saving…" : "Save deadline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RubricEditor({ ws }: { ws: WorkspaceOut }) {
  const h = ws.hackathon;
  const [draft, setDraft] = useState<Criterion[]>(h.rubric);
  const [editing, setEditing] = useState(false);
  const { patch, rollback } = useWorkspaceCache(h.id);
  useEffect(() => {
    if (!editing) setDraft(h.rubric);
  }, [h.rubric, editing]);
  const update = useActionMutation("update-hackathon", {
    onMutate: (input) => patch((w) => ({ ...w, hackathon: { ...w.hackathon, rubric: input.rubric ?? w.hackathon.rubric } })),
    onSuccess: () => {
      setEditing(false);
      toast.success("Rubric saved — ideas re-ranked.");
    },
    onError: (e, _i, ctx) => rollback(ctx, e, "Could not save the rubric."),
  });
  const total = (editing ? draft : h.rubric).reduce((s, c) => s + c.weight, 0);
  const rubric = editing ? draft : h.rubric;

  return (
    <Section
      title="Judging rubric"
      action={
        editing ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={update.isPending || draft.some((c) => !c.name.trim())}
              onClick={() => update.mutate({ id: h.id, rubric: draft })}
            >
              Save
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <IconPencil className="size-3.5" />
            Edit
          </Button>
        )
      }
    >
      {rubric.length === 0 && !editing ? (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>No weighted rubric found on the page.</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              askPilot("Find this hackathon's judging criteria (check the page text and rules) and save them as the rubric with weights.", { id: h.id, name: h.name })
            }
          >
            <IconRobot className="size-3.5" /> Ask Pilot to find it
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {rubric.map((c, i) => (
            <li key={c.id} className="space-y-1">
              {editing ? (
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Criterion name"
                    value={c.name}
                    onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    className="h-8 flex-1"
                  />
                  <Input
                    aria-label={`${c.name} weight`}
                    type="number"
                    min={0}
                    max={100}
                    value={c.weight}
                    onChange={(e) =>
                      setDraft((d) => d.map((x, j) => (j === i ? { ...x, weight: Math.max(0, Math.min(100, Number(e.target.value) || 0)) } : x)))
                    }
                    className="h-8 w-20 hp-tabular"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${c.name}`}
                    onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                  >
                    <IconTrash className="size-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{c.name}</span>
                    <span className="font-semibold text-signal hp-tabular">{c.weight}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-signal"
                      style={{ width: `${total ? (c.weight / total) * 100 : 0}%` }}
                    />
                  </div>
                  {c.description ? <p className="text-xs text-muted-foreground">{c.description}</p> : null}
                </>
              )}
            </li>
          ))}
          {editing ? (
            <li className="flex items-center justify-between">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft((d) => [...d, { id: slugKey(`criterion_${d.length + 1}`), name: "New criterion", weight: 10 }])
                }
              >
                <IconPlus className="size-3.5" /> Add criterion
              </Button>
              <span className={`text-xs hp-tabular ${total === 100 ? "text-muted-foreground" : "text-signal"}`}>
                Total {total}%
              </span>
            </li>
          ) : null}
        </ul>
      )}
    </Section>
  );
}

function PrizesEditor({ ws }: { ws: WorkspaceOut }) {
  const h = ws.hackathon;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Prize[]>(h.prizes);
  useEffect(() => {
    if (open) setDraft(h.prizes);
  }, [open, h.prizes]);
  const update = useActionMutation("update-hackathon", {
    onSuccess: () => {
      setOpen(false);
      toast.success("Prizes saved.");
    },
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not save prizes."),
  });
  return (
    <Section
      title="Prizes"
      action={
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <IconPencil className="size-3.5" />
          Edit
        </Button>
      }
    >
      {h.prizes.length ? (
        <ul className="divide-y divide-border">
          {h.prizes.map((p, i) => (
            <li key={`${p.label}-${i}`} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{p.label}</span>
                {p.description ? <span className="block text-xs text-muted-foreground">{p.description}</span> : null}
              </span>
              <span className="shrink-0 font-semibold hp-tabular">
                {typeof p.amount === "number" ? formatMoney(p.amount, p.currency || "USD") : "—"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No prizes listed.</p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prizes</DialogTitle>
            <DialogDescription>Name and cash value of each prize.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {draft.map((p, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  aria-label="Prize name"
                  value={p.label}
                  onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                <Input
                  aria-label="Amount"
                  type="number"
                  min={0}
                  className="w-28"
                  value={p.amount ?? ""}
                  onChange={(e) =>
                    setDraft((d) => d.map((x, j) => (j === i ? { ...x, amount: e.target.value === "" ? null : Number(e.target.value) } : x)))
                  }
                />
                <Button size="icon" variant="ghost" aria-label="Remove prize" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
                  <IconTrash className="size-4" />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setDraft((d) => [...d, { label: "New prize", amount: null, currency: "USD" }])}>
              <IconPlus className="size-3.5" /> Add prize
            </Button>
          </div>
          <DialogFooter>
            <Button
              disabled={update.isPending || draft.some((p) => !p.label.trim())}
              onClick={() => update.mutate({ id: h.id, prizes: draft })}
            >
              Save prizes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function NotesEditor({ ws }: { ws: WorkspaceOut }) {
  const h = ws.hackathon;
  const [notes, setNotes] = useState(h.notes ?? "");
  useEffect(() => setNotes(h.notes ?? ""), [h.notes]);
  const update = useActionMutation("update-hackathon", {
    onSuccess: () => toast.success("Notes saved."),
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not save notes."),
  });
  return (
    <Section title="Notes">
      <Label htmlFor="hackathon-notes" className="sr-only">
        Notes
      </Label>
      <Textarea
        id="hackathon-notes"
        value={notes}
        rows={5}
        placeholder="Constraints, team, sponsor APIs, things the agent should know…"
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => {
          if ((h.notes ?? "") !== notes) update.mutate({ id: h.id, notes: notes || null });
        }}
      />
    </Section>
  );
}

export function OverviewTab({ ws }: { ws: WorkspaceOut }) {
  const h = ws.hackathon;
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const reimport = useActionMutation("import-hackathon", {
    onSuccess: (r) => {
      toast.success(r.message);
      for (const w of r.warnings) toast.warning(w);
    },
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Re-import failed."),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
        <Section
          title="The brief"
          action={
            <Badge variant="outline" className="font-normal">
              {h.extraction === "llm" ? "Extracted by AI" : h.extraction === "seed" ? "Curated demo" : h.extraction.startsWith("heuristic") ? "Parsed from page" : "Edited"}
              {h.extraction.endsWith("+edited") ? " · edited" : ""}
            </Badge>
          }
        >
          {h.tagline ? <p className="text-sm leading-relaxed">{h.tagline}</p> : <p className="text-sm text-muted-foreground">No tagline.</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 p-3 text-sm">
            <span className="text-muted-foreground">Deadline</span>
            <span className="font-medium">
              {h.deadlineAt ? formatInZone(h.deadlineAt, h.timezone) : "Not set"}
            </span>
            <span className="text-xs text-muted-foreground">({h.timezone})</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDeadlineOpen(true)}>
              <IconPencil className="size-3.5" />
              Change
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {h.url ? (
              <Button
                size="sm"
                variant="outline"
                disabled={reimport.isPending}
                onClick={() => reimport.mutate({ url: h.url ?? "", id: h.id })}
              >
                <IconRefresh className={`size-3.5 ${reimport.isPending ? "motion-safe:animate-spin" : ""}`} />
                Re-import page
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                askPilot(
                  "Double-check this hackathon's record against its page text (get-hackathon with includeSource=true): deadline and timezone, prizes, rubric weights, and submission requirements. Fix anything wrong and tell me what changed.",
                  { id: h.id, name: h.name, tab: "overview" },
                )
              }
            >
              <IconRobot className="size-3.5" />
              Verify with Pilot
            </Button>
          </div>
        </Section>
        <RubricEditor ws={ws} />
      </div>
      <div className="space-y-4">
        <PrizesEditor ws={ws} />
        <NotesEditor ws={ws} />
      </div>
      <DeadlineDialog ws={ws} open={deadlineOpen} onOpenChange={setDeadlineOpen} />
    </div>
  );
}
