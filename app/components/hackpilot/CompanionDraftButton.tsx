import { useActionQuery } from "@agent-native/core/client/hooks";
import { buildMcpOAuthStartUrl } from "@agent-native/core/client/resources/mcp-integration-catalog";
import {
  IconExternalLink,
  IconFileText,
  IconPalette,
  IconPlug,
  IconPresentation,
} from "@tabler/icons-react";
import { useLocation } from "react-router";

import { Button } from "@/components/ui/button";
import { COMPANION_APPS, type CompanionApp } from "@shared/companion-apps";
import type { WorkspaceOut } from "@shared/outputs";

import { askPilot } from "./ask-pilot";

type DraftButtonApp = Exclude<CompanionApp, "plan">;

const WORKFLOWS = {
  content: {
    label: "Draft write-up in Content",
    tab: "checklist",
    icon: IconFileText,
    request:
      "Create a private submission write-up draft in Content for this hackathon. Return its verified editor link.",
  },
  slides: {
    label: "Draft deck in Slides",
    tab: "checklist",
    icon: IconPresentation,
    request:
      "Create a private pitch deck draft in Slides for this hackathon. Return its verified editor link.",
  },
  design: {
    label: "Draft UI in Design",
    tab: "ideas",
    icon: IconPalette,
    request:
      "Create a private Design draft with a renderable screen for this idea. Link the verified prototype to the idea so I can open it from Plan.",
  },
} satisfies Record<
  DraftButtonApp,
  { label: string; tab: string; icon: typeof IconPlug; request: string }
>;

export function useCompanionApps(hackathonId: string, enabled = true) {
  return useActionQuery("get-companion-apps", { hackathonId }, { enabled }).data;
}

export function DesignPrototypeLink({ url }: { url: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={url} target="_blank" rel="noopener noreferrer">
        Open prototype
        <IconExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    </Button>
  );
}

export function CompanionDraftButton({
  app,
  connected,
  hackathon,
  ideaId,
  className,
}: {
  connected: boolean;
  hackathon: WorkspaceOut["hackathon"];
  className?: string;
} & (
  | { app: "design"; ideaId: string }
  | { app: Exclude<DraftButtonApp, "design">; ideaId?: never }
)) {
  const location = useLocation();
  const { label, origin } = COMPANION_APPS[app];
  const workflow = WORKFLOWS[app];
  const Icon = workflow.icon;

  if (!connected) {
    const href = buildMcpOAuthStartUrl({
      name: label,
      url: `${origin}/mcp`,
      description: `Connect ${label} to draft hackathon materials.`,
      scope: "user",
      returnUrl: `${location.pathname}${location.search}${location.hash}`,
    });
    return (
      <Button asChild variant="outline" size="sm" className={className}>
        <a href={href}>
          <IconPlug className="size-4" />
          Connect {label}
        </a>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={() =>
        askPilot(workflow.request, {
          id: hackathon.id,
          name: hackathon.name,
          tab: workflow.tab,
          ...(ideaId ? { ideaId } : {}),
        })
      }
    >
      <Icon className="size-4" />
      {workflow.label}
    </Button>
  );
}
