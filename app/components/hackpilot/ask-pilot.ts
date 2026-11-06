import { sendToAgentChat } from "@agent-native/core/client/agent-chat";

/**
 * Hand a job to the agent in the sidebar, with the workspace as hidden
 * context. The agent answers by calling the same actions the UI uses, so the
 * page updates as it works.
 */
export function askPilot(message: string, workspace?: { id: string; name: string; tab?: string }) {
  sendToAgentChat({
    message,
    ...(workspace
      ? {
          context: `HackPilot workspace: "${workspace.name}" (hackathonId ${workspace.id})${workspace.tab ? `, viewing the ${workspace.tab} tab` : ""}. Use the HackPilot actions with this hackathonId.`,
        }
      : {}),
    submit: true,
    openSidebar: true,
  });
}
