import { registerActionChatRenderer } from "@agent-native/toolkit/app/chat";
import {
  COMPANION_APPS,
  COMPANION_APP_IDS,
  COMPANION_ARTIFACT_ID_PATTERN,
  COMPANION_EDITOR_LINK_RENDERER,
  companionEditorUrl,
} from "@shared/companion-apps";
import { IconExternalLink } from "@tabler/icons-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";

const editorLinkSchema = z.object({
  app: z.enum(COMPANION_APP_IDS),
  id: z.string().regex(COMPANION_ARTIFACT_ID_PATTERN),
  title: z.string().optional(),
});

registerActionChatRenderer({
  id: COMPANION_EDITOR_LINK_RENDERER,
  renderer: COMPANION_EDITOR_LINK_RENDERER,
  Component: ({ context }) => {
    const link = editorLinkSchema.safeParse(context.resultJson);
    if (!link.success) return null;
    const { app, id, title } = link.data;
    const { label } = COMPANION_APPS[app];
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-medium">
          {title ?? `Verified ${label} draft`}
        </span>
        <Button asChild size="sm" variant="outline">
          <a
            href={companionEditorUrl(app, id)}
            target="_blank"
            rel="noreferrer"
          >
            Open in {label}
            <IconExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>
    );
  },
});
