import { defineAppConfig } from "@agent-native/core/server";

// OpenRouter: when OPENROUTER_API_KEY is set for the deployment, run the chat
// agent on the framework's built-in `ai-sdk:openrouter` engine, with
// OPENROUTER_MODEL (e.g. "anthropic/claude-sonnet-4.5") when given. Without
// it, the framework auto-detects the engine and the model is chosen in
// Settings, exactly as before. Keys saved in Settings work too.
const openRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY?.trim());
const openRouterModel = process.env.OPENROUTER_MODEL?.trim();

export default defineAppConfig({
  app: {
    // This name appears in transactional emails.
    name: "HackPilot",
    // The source template keeps a renamed app from inheriting first-party email branding.
    sourceTemplate: "chat",
    // Sign-in lands on the hackathon list.
    homePath: "/hackathons",
    // Optional: use your own absolute HTTPS logo URL in transactional emails.
    // logoUrl: "https://example.com/logo.png",
  },
  ...(openRouterConfigured
    ? {
        agent: {
          engine: "ai-sdk:openrouter",
          ...(openRouterModel ? { model: openRouterModel } : {}),
        },
      }
    : {}),
});
