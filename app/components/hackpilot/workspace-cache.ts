import { actionErrorMessage } from "@agent-native/core/client/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";

import { weightedScore, scoreCoverage } from "@shared/hackpilot";
import type { WorkspaceOut } from "@shared/outputs";

export function workspaceKey(id: string) {
  return ["action", "get-hackathon", { id }] as const;
}

/**
 * Optimistic edits to the cached workspace. Each mutation patches the cache
 * immediately (target < 100 ms), then the action result or its error decides.
 */
export function useWorkspaceCache(id: string) {
  const queryClient = useQueryClient();
  const key = useMemo(() => workspaceKey(id), [id]);

  const patch = useCallback(
    (fn: (ws: WorkspaceOut) => WorkspaceOut) => {
      void queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<WorkspaceOut>(key);
      if (previous) queryClient.setQueryData<WorkspaceOut>(key, recompute(fn(previous)));
      return { previous };
    },
    [queryClient, key],
  );

  const rollback = useCallback(
    (context: unknown, error: unknown, fallback: string) => {
      const previous = (context as { previous?: WorkspaceOut } | undefined)?.previous;
      if (previous) queryClient.setQueryData(key, previous);
      toast.error(actionErrorMessage(error) ?? fallback);
    },
    [queryClient, key],
  );

  return { patch, rollback };
}

function recompute(ws: WorkspaceOut): WorkspaceOut {
  const rubric = ws.hackathon.rubric;
  return {
    ...ws,
    ideas: ws.ideas.map((i) => ({
      ...i,
      weightedScore: weightedScore(i.scores, rubric),
      coverage: scoreCoverage(i.scores, rubric),
    })),
    progress: {
      tasksDone: ws.tasks.filter((t) => t.done).length,
      tasksTotal: ws.tasks.length,
      submissionDone: ws.submissionItems.filter((s) => s.status === "done").length,
      submissionTotal: ws.submissionItems.length,
      selectedIdeaId: ws.ideas.find((i) => i.selected)?.id ?? null,
    },
  };
}
