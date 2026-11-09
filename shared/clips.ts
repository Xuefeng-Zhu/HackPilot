export const HOSTED_CLIPS_HOSTNAME = "clips.agent-native.com";

/** Route hosted Clips candidates to the share-link verifier, including invalid variants. */
export function isHostedClipsUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim(), "https://hackpilot.invalid");
    return (
      url.hostname.toLowerCase().replace(/\.$/, "") === HOSTED_CLIPS_HOSTNAME
    );
  } catch {
    return false;
  }
}
