import { defineNitroPlugin } from "@agent-native/core/server";

import { registerOtariEngine } from "../lib/otari-engine.js";

/** Make the `otari` agent engine available to Pilot chat (AGENT_ENGINE=otari or Settings > AI engine). */
export default defineNitroPlugin(() => {
  registerOtariEngine();
});
