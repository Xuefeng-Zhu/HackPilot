import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import {
  IconCalendarRepeat,
  IconFlag,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { TaskOut, WorkspaceOut } from "@shared/outputs";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys } from "@shared/time";

import { askPilot } from "./ask-pilot";
import { useWorkspaceCache } from "./workspace-cache";

const PHASE_STYLES: Record<string, string> = {
  ideate: "bg-sky-500",
  build: "bg-foreground/70",
  polish: "bg-violet-500",
  record: "bg-rose-500",
  submit: "bg-signal",
  other: "bg-muted-foreground",
};

function dayLabel(key: string) {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(date),
    date: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date),
  };
}

function TaskRow({
  task,
  onToggle,
  onDelete,
  onDragStart,
}: {
  task: TaskOut;
  onToggle: (done: boolean) => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  return (
    <li
      draggable
      onDragStart={onDragStart}
      className="group flex cursor-grab items-start gap-2 rounded-lg border border-border bg-background p-2 text-sm active:cursor-grabbing"
      title={task.notes ?? undefined}
    >
      <Checkbox
        checked={task.done}
        onCheckedChange={(v) => onToggle(v === true)}
        aria-label={`Mark “${task.title}” ${task.done ? "not done" : "done"}`}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span className={`block leading-snug ${task.done ? "text-muted-foreground line-through" : ""}`}>{task.title}</span>
        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={`size-1.5 rounded-full ${PHASE_STYLES[task.phase] ?? PHASE_STYLES.other}`} aria-hidden />
          {task.phase}
          {task.estimateHours ? <span className="hp-tabular">· {task.estimateHours}h</span> : null}
          {task.source !== "plan" ? <span>· {task.source === "agent" ? "Pilot" : "you"}</span> : null}
        </span>
      </span>
      <button
        type="button"
        aria-label={`Delete “${task.title}”`}
        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        onClick={onDelete}
      >
        <IconX className="size-3.5" />
      </button>
    </li>
  );
}

function AddTask({ onAdd }: { onAdd: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <IconPlus className="size-3.5" /> Add task
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onAdd(title.trim());
        setTitle("");
        setOpen(false);
      }}
    >
      <Input
        autoFocus
        aria-label="New task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => !title.trim() && setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder="What needs doing?"
        className="h-8 text-sm"
      />
    </form>
  );
}

export function PlanTab({ ws }: { ws: WorkspaceOut }) {
  const h = ws.hackathon;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = dateKeyInZone(new Date(), tz);
  const deadlineKey = h.deadlineAt ? dateKeyInZone(new Date(h.deadlineAt), tz) : null;
  const { patch, rollback } = useWorkspaceCache(h.id);
  const [dragTask, setDragTask] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);

  const days = useMemo(() => {
    const keys = new Set(ws.tasks.map((t) => t.day));
    if (deadlineKey && deadlineKey >= today) {
      const span = daysBetweenKeys(today, deadlineKey);
      for (let i = 0; i <= Math.min(span, 30); i++) keys.add(addDaysToKey(today, i));
    }
    return [...keys].sort();
  }, [ws.tasks, today, deadlineKey]);

  const plan = useActionMutation("plan-sprint", {
    onSuccess: (r) => toast.success(r.message),
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not plan the sprint."),
  });
  const update = useActionMutation("update-task", {
    onMutate: (input) =>
      patch((w) => ({
        ...w,
        tasks: input.delete
          ? w.tasks.filter((t) => t.id !== input.id)
          : input.id
            ? w.tasks.map((t) =>
                t.id === input.id
                  ? {
                      ...t,
                      ...(input.done !== undefined ? { done: input.done } : {}),
                      ...(input.day !== undefined ? { day: input.day } : {}),
                    }
                  : t,
              )
            : [
                ...w.tasks,
                {
                  id: `pending-${Date.now()}`,
                  title: input.title ?? "",
                  notes: null,
                  day: input.day ?? today,
                  phase: input.phase ?? "build",
                  position: 9999,
                  done: false,
                  source: "user",
                  estimateHours: null,
                },
              ],
      })),
    onError: (e, _i, ctx) => rollback(ctx, e, "Could not update the task."),
  });

  const overdue = ws.tasks.filter((t) => !t.done && t.day < today).length;
  const pct = ws.progress.tasksTotal ? Math.round((ws.progress.tasksDone / ws.progress.tasksTotal) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={plan.isPending || !h.deadlineAt} onClick={() => plan.mutate({ hackathonId: h.id, mode: "fresh", timezone: tz })}>
          <IconRefresh className={`size-4 ${plan.isPending ? "motion-safe:animate-spin" : ""}`} />
          {ws.tasks.length ? "Re-plan" : "Generate plan"}
        </Button>
        {overdue ? (
          <Button variant="outline" disabled={plan.isPending} onClick={() => plan.mutate({ hackathonId: h.id, mode: "rebalance", timezone: tz })}>
            <IconCalendarRepeat className="size-4" />
            Catch up ({overdue} overdue)
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={() =>
            askPilot(
              `Look at my sprint plan and progress, then re-plan the remaining days realistically around what's done and what's left (use plan-sprint and update-task; my timezone is ${tz}). Tell me the 3 tasks that matter most today.`,
              { id: h.id, name: h.name, tab: "plan" },
            )
          }
        >
          <IconRobot className="size-4" />
          Ask Pilot to re-plan
        </Button>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-signal transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="hp-tabular">{pct}% done</span>
        </div>
      </div>

      {!h.deadlineAt ? (
        <p className="rounded-lg bg-signal-soft p-3 text-sm">Set the deadline on the Overview tab to plan the sprint.</p>
      ) : null}

      {days.length ? (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
          <div className="flex min-w-max gap-3">
            {days.map((day) => {
              const label = dayLabel(day);
              const tasks = ws.tasks.filter((t) => t.day === day).sort((a, b) => a.position - b.position);
              const isToday = day === today;
              const isDeadline = day === deadlineKey;
              const past = day < today;
              return (
                <section
                  key={day}
                  aria-label={`${label.weekday} ${label.date}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverDay(day);
                  }}
                  onDragLeave={() => setOverDay((d) => (d === day ? null : d))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = dragTask ?? e.dataTransfer.getData("text/plain");
                    setOverDay(null);
                    setDragTask(null);
                    const task = ws.tasks.find((t) => t.id === id);
                    if (task && task.day !== day) update.mutate({ id, day });
                  }}
                  className={`flex w-64 shrink-0 flex-col rounded-xl border p-3 transition-colors ${isToday ? "border-signal/60 bg-signal-soft/40" : "border-border bg-card"} ${overDay === day ? "ring-2 ring-signal/50" : ""} ${past ? "opacity-70" : ""}`}
                >
                  <header className="mb-2 flex items-baseline justify-between">
                    <span className="text-sm font-semibold">
                      {label.weekday} <span className="font-normal text-muted-foreground">{label.date}</span>
                    </span>
                    {isDeadline ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-signal">
                        <IconFlag className="size-3.5" /> Deadline
                      </span>
                    ) : isToday ? (
                      <span className="text-xs font-medium text-signal">Today</span>
                    ) : null}
                  </header>
                  <ul className="flex flex-1 flex-col gap-1.5">
                    {tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onToggle={(done) => update.mutate({ id: task.id, done })}
                        onDelete={() => update.mutate({ id: task.id, delete: true })}
                        onDragStart={(e) => {
                          setDragTask(task.id);
                          e.dataTransfer.setData("text/plain", task.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                      />
                    ))}
                  </ul>
                  <div className="mt-2">
                    <AddTask onAdd={(title) => update.mutate({ hackathonId: h.id, title, day })} />
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No plan yet. Pick an idea, then generate a day-by-day sprint to the deadline.
        </div>
      )}
    </div>
  );
}
