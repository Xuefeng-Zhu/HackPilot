import { defineAppConfig, readDeployCredentialEnv } from "@agent-native/core/server";

// OpenRouter: when OPENROUTER_API_KEY is set for the deployment, run the chat
// agent on the framework's built-in `ai-sdk:openrouter` engine. The default
// model is Claude Haiku 5.5; OPENROUTER_MODEL can select another model. Without a
// deployment key, the framework resolves the engine and model from Settings.
const openRouterConfigured = Boolean(readDeployCredentialEnv("OPENROUTER_API_KEY")?.trim());
// guard:allow-env-credential — model selection is nonsecret deployment configuration
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
          model: openRouterModel || "anthropic/claude-haiku-5.5",
        },
      }
    : {}),
});
