import { getUserSetting, putUserSetting } from "@agent-native/core/settings";
import { and, eq } from "drizzle-orm";

import {
  COMPANION_ARTIFACT_ID_PATTERN,
  companionEditorUrl,
} from "../../shared/companion-apps.js";
import { getDb, schema } from "../db/index.js";

// Keep the shortcut with the person who verified the private Design draft.
// The colon-delimited key is outside the browser settings route's key space.
function prototypeKey(hackathonId: string, ideaId: string) {
  return `hackpilot:design-prototype:${JSON.stringify([hackathonId, ideaId])}`;
}

export async function getSelectedIdeaId(hackathonId: string) {
  const { ideas } = schema;
  const [idea] = await getDb()
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.hackathonId, hackathonId), eq(ideas.selected, true)))
    .limit(1);
  return idea?.id ?? null;
}

/** The caller must have access to the hackathon before reading its shortcut. */
export async function readDesignPrototype(
  hackathonId: string,
  userEmail: string,
) {
  const ideaId = await getSelectedIdeaId(hackathonId);
  if (!ideaId) return null;
  return readDesignPrototypeForIdea(hackathonId, ideaId, userEmail);
}

/** Read the caller's private shortcut after verifying access to the exact idea. */
export async function readDesignPrototypeForIdea(
  hackathonId: string,
  ideaId: string,
  userEmail: string,
) {
  const setting = await getUserSetting(
    userEmail,
    prototypeKey(hackathonId, ideaId),
  );
  const id = setting?.id;
  return typeof id === "string" && COMPANION_ARTIFACT_ID_PATTERN.test(id)
    ? { ideaId, id, url: companionEditorUrl("design", id) }
    : null;
}

/** Save only after the caller has verified the exact private Design draft. */
export async function saveDesignPrototype(
  hackathonId: string,
  ideaId: string,
  userEmail: string,
  id: string,
) {
  const key = prototypeKey(hackathonId, ideaId);
  try {
    await putUserSetting(userEmail, key, { id });
  } catch {
    // A failed response can still mean the write landed. Confirm below.
  }
  const saved = await getUserSetting(userEmail, key, {
    bypassCache: true,
  }).catch(() => null);
  return saved?.id === id;
}
