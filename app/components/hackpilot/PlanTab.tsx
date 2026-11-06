import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import {
  IconAlertTriangle,
  IconCalendarRepeat,
  IconCheck,
  IconFlag,
  IconLayoutColumns,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTargetArrow,
  IconTimeline,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  MILESTONE_META,
  type Milestone,
  type MilestoneId,
  type MilestoneProgress,
  milestoneProgress,
} from "@shared/milestones";
import type { TaskOut, WorkspaceOut } from "@shared/outputs";
import { addDaysToKey, countdownLabel, dateKeyInZone, daysBetweenKeys } from "@shared/time";

import { askPilot } from "./ask-pilot";
import { BuildPanel } from "./BuildPanel";
import { useWorkspaceCache } from "./workspace-cache";

const PHASE_STYLES: Record<string, string> = {
  ideate: "bg-sky-500",
  build: "bg-foreground/70",
  polish: "bg-violet-500",
  record: "bg-rose-500",
  submit: "bg-signal",
  other: "bg-muted-foreground",
};

const MILESTONE_DOT: Record<MilestoneId, string> = {
  idea: "bg-sky-500",
  core: "bg-foreground",
  demo: "bg-violet-500",
  submit: "bg-signal",
};

function dayLabel(key: string) {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(date),
    date: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date),
  };
}

function dueLabel(iso: string, tz: string, long: boolean) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    ...(long ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  }).format(new Date(iso));
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

function relativeDay(key: string, today: string) {
  const diff = daysBetweenKeys(today, key);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  const l = dayLabel(key);
  return diff > 0 && diff < 7 ? l.weekday : `${l.weekday} ${l.date}`;
}

function TaskRow({
  task,
  today,
  onToggle,
  onDelete,
  onDragStart,
  showMilestone,
}: {
  task: TaskOut;
  today: string;
  onToggle: (done: boolean) => void;
  onDelete?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  showMilestone?: boolean;
}) {
  const overdue = !task.done && task.day < today;
  return (
    <li
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      className={`group flex items-start gap-2 rounded-lg border bg-background p-2 text-sm ${onDragStart ? "cursor-grab active:cursor-grabbing" : ""} ${overdue ? "border-rose-300/70 dark:border-rose-900" : "border-border"}`}
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
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {showMilestone ? (
            <>
              <span className={`size-1.5 rounded-full ${MILESTONE_DOT[task.milestone]}`} aria-hidden />
              {MILESTONE_META[task.milestone].title}
            </>
          ) : (
            <>
              <span className={`size-1.5 rounded-full ${PHASE_STYLES[task.phase] ?? PHASE_STYLES.other}`} aria-hidden />
              {task.phase}
            </>
          )}
          <span className={overdue ? "font-medium text-rose-600 dark:text-rose-400" : ""}>
            · {overdue ? `overdue (${relativeDay(task.day, today)})` : `due ${relativeDay(task.day, today)}`}
          </span>
          {task.estimateHours ? <span className="hp-tabular">· {task.estimateHours}h</span> : null}
          {task.source !== "plan" ? <span>· {task.source === "agent" ? "Pilot" : "you"}</span> : null}
        </span>
      </span>
      {onDelete ? (
        <button
          type="button"
          aria-label={`Delete “${task.title}”`}
          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onClick={onDelete}
        >
          <IconX className="size-3.5" />
        </button>
      ) : null}
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

/** Proportional timeline: window start → deadline, milestone markers, a "now" pin. */
function Timeline({ progress, startIso, now }: { progress: MilestoneProgress[]; startIso: string; now: Date }) {
  const deadline = progress[progress.length - 1]?.milestone.dueAt;
  if (!deadline) return null;
  const start = Math.min(Date.parse(startIso), Date.parse(progress[0]!.milestone.dueAt) - 3_600_000);
  const end = Date.parse(deadline);
  const span = Math.max(1, end - start);
  const pos = (ms: number) => `${Math.min(100, Math.max(0, ((ms - start) / span) * 100))}%`;
  const nowMs = now.getTime();
  const long = span >= 7 * 86_400_000;
  const label = (iso: string) =>
    new Intl.DateTimeFormat(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { weekday: "short", hour: "numeric" }).format(
      new Date(iso),
    );
  return (
    <div className="relative mx-3 mb-7 mt-8 h-1.5 rounded-full bg-muted" aria-hidden>
      <div className="absolute inset-y-0 left-0 rounded-full bg-signal/40" style={{ width: pos(nowMs) }} />
      {progress.map(({ milestone: m, complete, overdue }, i) => (
        <div key={m.id} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: pos(Date.parse(m.dueAt)) }}>
          <div
            className={`flex size-4 items-center justify-center rounded-full border-2 border-background ${complete ? "bg-emerald-500" : overdue ? "bg-rose-500" : MILESTONE_DOT[m.id]}`}
          >
            {complete ? <IconCheck className="size-2.5 text-white" stroke={3} /> : null}
          </div>
          <span
            className={`absolute top-5 whitespace-nowrap text-[10px] text-muted-foreground ${i === progress.length - 1 ? "right-0" : "left-1/2 -translate-x-1/2"}`}
          >
            {label(m.dueAt)}
          </span>
        </div>
      ))}
      <div className="absolute -top-6 -translate-x-1/2 text-[10px] font-semibold text-signal" style={{ left: pos(nowMs) }}>
        now
        <div className="mx-auto mt-0.5 h-3 w-px bg-signal" />
      </div>
    </div>
  );
}

function TodayStrip({
  tasks,
  next,
  today,
  tz,
  now,
  onToggle,
}: {
  tasks: TaskOut[];
  next: MilestoneProgress | null;
  today: string;
  tz: string;
  now: Date;
  onToggle: (t: TaskOut, done: boolean) => void;
}) {
  const due = tasks
    .filter((t) => !t.done && t.day <= today)
    .sort((a, b) => a.day.localeCompare(b.day) || a.position - b.position);
  const overdue = due.filter((t) => t.day < today).length;
  const upNext = due.length
    ? []
    : tasks
        .filter((t) => !t.done && t.day > today && (!next || t.milestone === next.milestone.id))
        .sort((a, b) => a.day.localeCompare(b.day) || a.position - b.position)
        .slice(0, 4);
  const shown = due.length ? due.slice(0, 6) : upNext;
  return (
    <section aria-label="Today" className="grid gap-3 rounded-xl border border-signal/40 bg-signal-soft/30 p-4 md:grid-cols-[1fr_minmax(16rem,22rem)]">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Today
          <span className="font-normal text-muted-foreground">
            {due.length ? `${due.length} task${due.length === 1 ? "" : "s"} due` : ""}
            {overdue ? <span className="text-rose-600 dark:text-rose-400"> · {overdue} overdue</span> : null}
          </span>
        </h2>
        {!due.length && shown.length ? (
          <p className="mt-2 text-xs text-muted-foreground">Nothing due today. Up next{next ? ` for ${next.milestone.title}` : ""}; get a head start:</p>
        ) : null}
        {shown.length ? (
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {shown.map((t) => (
              <TaskRow key={t.id} task={t} today={today} showMilestone onToggle={(d) => onToggle(t, d)} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">You're clear for today.</p>
        )}
        {due.length > shown.length ? <p className="mt-1.5 text-xs text-muted-foreground">+{due.length - shown.length} more below</p> : null}
      </div>
      {next ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <IconTargetArrow className="size-3.5" /> Next milestone
          </p>
          <p className="mt-1 text-lg font-semibold leading-tight">{next.milestone.title}</p>
          <p className={`text-2xl font-semibold tracking-tight hp-tabular ${next.overdue ? "text-rose-600 dark:text-rose-400" : "text-signal"}`}>
            {next.overdue ? "Behind" : `${countdownLabel(next.milestone.dueAt, now)} left`}
          </p>
          <p className="text-xs text-muted-foreground">Target {dueLabel(next.milestone.dueAt, tz, true)}</p>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-signal transition-all" style={{ width: `${next.total ? (next.done / next.total) * 100 : 0}%` }} />
            </div>
            <span className="hp-tabular">{next.done}/{next.total}</span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          <IconCheck className="size-4" /> Every milestone is done.
        </div>
      )}
    </section>
  );
}

function MilestoneBoard({
  progress,
  tasks,
  today,
  tz,
  now,
  onToggle,
  onDelete,
  onMove,
  onAdd,
}: {
  progress: MilestoneProgress[];
  tasks: TaskOut[];
  today: string;
  tz: string;
  now: Date;
  onToggle: (t: TaskOut, done: boolean) => void;
  onDelete: (t: TaskOut) => void;
  onMove: (id: string, milestone: MilestoneId) => void;
  onAdd: (title: string, milestone: MilestoneId) => void;
}) {
  const [dragTask, setDragTask] = useState<string | null>(null);
  const [over, setOver] = useState<MilestoneId | null>(null);
  return (
    <div className="grid gap-3 [container-type:inline-size] sm:grid-cols-2 xl:grid-cols-4">
      {progress.map((p, i) => {
        const m: Milestone = p.milestone;
        const mine = tasks
          .filter((t) => t.milestone === m.id)
          .sort((a, b) => Number(a.done) - Number(b.done) || a.day.localeCompare(b.day) || a.position - b.position);
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        const isNext = !p.complete && progress.slice(0, i).every((q) => q.complete);
        return (
          <section
            key={m.id}
            aria-label={`${m.title} milestone`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(m.id);
            }}
            onDragLeave={() => setOver((o) => (o === m.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              const id = dragTask ?? e.dataTransfer.getData("text/plain");
              setOver(null);
              setDragTask(null);
              const task = tasks.find((t) => t.id === id);
              if (task && task.milestone !== m.id) onMove(id, m.id);
            }}
            className={`flex min-w-0 flex-col rounded-xl border p-3 transition-colors ${isNext ? "border-signal/60 bg-signal-soft/20" : "border-border bg-card"} ${over === m.id ? "ring-2 ring-signal/50" : ""}`}
          >
            <header className="mb-2">
              <div className="flex items-center gap-2">
                <span className={`flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-white ${p.complete ? "bg-emerald-500" : MILESTONE_DOT[m.id]}`}>
                  {p.complete ? <IconCheck className="size-3" stroke={3} /> : i + 1}
                </span>
                <h3 className="text-sm font-semibold">{m.title}</h3>
                {m.id === "submit" ? <IconFlag className="size-3.5 text-signal" aria-label="Deadline" /> : null}
                <span className="ml-auto text-[11px]">
                  {p.complete ? (
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">Done</span>
                  ) : p.overdue ? (
                    <span className="inline-flex items-center gap-1 font-medium text-rose-600 dark:text-rose-400">
                      <IconAlertTriangle className="size-3" /> Behind
                    </span>
                  ) : (
                    <span className={isNext ? "font-medium text-signal" : "text-muted-foreground"}>in {countdownLabel(m.dueAt, now)}</span>
                  )}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {dueLabel(m.dueAt, tz, true)}
                {m.reslotted ? <span title="Moved because the original target passed"> · re-slotted</span> : null}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">{MILESTONE_META[m.id].blurb}</p>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full transition-all ${p.complete ? "bg-emerald-500" : "bg-signal"}`} style={{ width: `${pct}%` }} />
                </div>
                <span className="hp-tabular">{p.done}/{p.total}</span>
              </div>
            </header>
            <ul className="flex flex-1 flex-col gap-1.5">
              {mine.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  today={today}
                  onToggle={(d) => onToggle(task, d)}
                  onDelete={() => onDelete(task)}
                  onDragStart={(e) => {
                    setDragTask(task.id);
                    e.dataTransfer.setData("text/plain", task.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                />
              ))}
            </ul>
            <div className="mt-2">
              <AddTask onAdd={(title) => onAdd(title, m.id)} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DayGrid({
  ws,
  today,
  deadlineKey,
  onToggle,
  onDelete,
  onMoveDay,
}: {
  ws: WorkspaceOut;
  today: string;
  deadlineKey: string | null;
  onToggle: (t: TaskOut, done: boolean) => void;
  onDelete: (t: TaskOut) => void;
  onMoveDay: (id: string, day: string) => void;
}) {
  const [dragTask, setDragTask] = useState<string | null>(null);
  const days = useMemo(() => {
    const keys = new Set(ws.tasks.map((t) => t.day));
    if (deadlineKey && deadlineKey >= today) {
      const span = daysBetweenKeys(today, deadlineKey);
      for (let i = 0; i <= Math.min(span, 30); i++) keys.add(addDaysToKey(today, i));
    }
    return [...keys].sort();
  }, [ws.tasks, today, deadlineKey]);
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
      <div className="flex gap-3">
        {days.map((day) => {
          const label = dayLabel(day);
          const tasks = ws.tasks.filter((t) => t.day === day).sort((a, b) => a.position - b.position);
          return (
            <section
              key={day}
              aria-label={`${label.weekday} ${label.date}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragTask ?? e.dataTransfer.getData("text/plain");
                setDragTask(null);
                const task = ws.tasks.find((t) => t.id === id);
                if (task && task.day !== day) onMoveDay(id, day);
              }}
              className={`flex min-w-52 flex-1 basis-0 shrink-0 flex-col rounded-xl border p-3 ${day === today ? "border-signal/60 bg-signal-soft/40" : "border-border bg-card"} ${day < today ? "opacity-70" : ""}`}
            >
              <header className="mb-2 flex items-baseline justify-between">
                <span className="text-sm font-semibold">
                  {label.weekday} <span className="font-normal text-muted-foreground">{label.date}</span>
                </span>
                {day === deadlineKey ? <IconFlag className="size-3.5 text-signal" aria-label="Deadline" /> : day === today ? <span className="text-xs font-medium text-signal">Today</span> : null}
              </header>
              <ul className="flex flex-1 flex-col gap-1.5">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    today={today}
                    showMilestone
                    onToggle={(d) => onToggle(task, d)}
                    onDelete={() => onDelete(task)}
                    onDragStart={(e) => {
                      setDragTask(task.id);
                      e.dataTransfer.setData("text/plain", task.id);
                    }}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function PlanTab({ ws }: { ws: WorkspaceOut }) {
  const h = ws.hackathon;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = useNow();
  const today = dateKeyInZone(now, tz);
  const deadlineKey = h.deadlineAt ? dateKeyInZone(new Date(h.deadlineAt), tz) : null;
  const { patch, rollback } = useWorkspaceCache(h.id);
  const [view, setView] = useState<"milestones" | "days">("milestones");

  const progress = useMemo(() => milestoneProgress(h.milestones, ws.tasks, now), [h.milestones, ws.tasks, now]);
  const next = progress.find((p) => !p.complete) ?? null;

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
                      ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
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
                  milestone: input.milestone ?? "core",
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
  const behind = progress.some((p) => p.overdue);
  const pct = ws.progress.tasksTotal ? Math.round((ws.progress.tasksDone / ws.progress.tasksTotal) * 100) : 0;
  const toggle = (t: TaskOut, done: boolean) => update.mutate({ id: t.id, done });
  const remove = (t: TaskOut) => update.mutate({ id: t.id, delete: true });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={plan.isPending || !h.deadlineAt} onClick={() => plan.mutate({ hackathonId: h.id, mode: "fresh", timezone: tz })}>
          <IconRefresh className={`size-4 ${plan.isPending ? "motion-safe:animate-spin" : ""}`} />
          {ws.tasks.length ? "Re-plan" : "Generate plan"}
        </Button>
        {overdue || behind ? (
          <Button variant="outline" disabled={plan.isPending} onClick={() => plan.mutate({ hackathonId: h.id, mode: "rebalance", timezone: tz })}>
            <IconCalendarRepeat className="size-4" />
            Catch up{overdue ? ` (${overdue} overdue)` : ""}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={() =>
            askPilot(
              `Look at my milestone plan and progress, then re-plan the remaining time realistically around what's done and what's left (use plan-sprint mode rebalance and update-task with milestone/day; my timezone is ${tz}). Tell me the 3 tasks that matter most today for the next milestone.`,
              { id: h.id, name: h.name, tab: "plan" },
            )
          }
        >
          <IconRobot className="size-4" />
          Ask Pilot to re-plan
        </Button>
        <div className="ml-auto flex items-center gap-3">
          <div className="inline-flex rounded-lg border border-border p-0.5 text-xs" role="group" aria-label="Plan view">
            <button
              type="button"
              aria-pressed={view === "milestones"}
              onClick={() => setView("milestones")}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${view === "milestones" ? "bg-accent font-medium text-foreground" : "text-muted-foreground"}`}
            >
              <IconTimeline className="size-3.5" /> Milestones
            </button>
            <button
              type="button"
              aria-pressed={view === "days"}
              onClick={() => setView("days")}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${view === "days" ? "bg-accent font-medium text-foreground" : "text-muted-foreground"}`}
            >
              <IconLayoutColumns className="size-3.5" /> By day
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-signal transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="hp-tabular">{pct}% done</span>
          </div>
        </div>
      </div>

      {!h.deadlineAt ? (
        <p className="rounded-lg bg-signal-soft p-3 text-sm">Set the deadline on the Overview tab to plan the sprint.</p>
      ) : null}

      {ws.tasks.length && h.milestones.length ? (
        <>
          <TodayStrip tasks={ws.tasks} next={next} today={today} tz={tz} now={now} onToggle={toggle} />
          {view === "milestones" ? (
            <>
              <Timeline progress={progress} startIso={h.importedAt ?? h.milestones[0]!.dueAt} now={now} />
              <MilestoneBoard
                progress={progress}
                tasks={ws.tasks}
                today={today}
                tz={tz}
                now={now}
                onToggle={toggle}
                onDelete={remove}
                onMove={(id, milestone) => update.mutate({ id, milestone })}
                onAdd={(title, milestone) => update.mutate({ hackathonId: h.id, title, milestone })}
              />
            </>
          ) : (
            <DayGrid ws={ws} today={today} deadlineKey={deadlineKey} onToggle={toggle} onDelete={remove} onMoveDay={(id, day) => update.mutate({ id, day })} />
          )}
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No plan yet. Pick an idea, then generate a milestone plan to the deadline: Idea locked → Core works → Demo-ready → Submitted.
        </div>
      )}

      <BuildPanel ws={ws} />
    </div>
  );
}
