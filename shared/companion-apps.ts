export const COMPANION_APPS = {
  content: {
    label: "Content",
    origin: "https://content.agent-native.com",
    editorPath: "/page",
  },
  slides: {
    label: "Slides",
    origin: "https://slides.agent-native.com",
    editorPath: "/deck",
  },
  plan: {
    label: "Plan",
    origin: "https://plan.agent-native.com",
    editorPath: "/plans",
  },
  design: {
    label: "Design",
    origin: "https://design.agent-native.com",
    editorPath: "/design",
  },
} as const;

export type CompanionApp = keyof typeof COMPANION_APPS;
export const COMPANION_APP_IDS = Object.keys(COMPANION_APPS) as CompanionApp[];
export const COMPANION_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
export const COMPANION_EDITOR_LINK_RENDERER = "hackpilot.companion-editor-link";

export function companionEditorUrl(app: CompanionApp, id: string) {
  const { origin, editorPath } = COMPANION_APPS[app];
  return `${origin}${editorPath}/${encodeURIComponent(id)}`;
}

export const CLIPS_ORIGIN = "https://clips.agent-native.com";
export const CLIPS_RECORDER_URL = `${CLIPS_ORIGIN}/record`;
