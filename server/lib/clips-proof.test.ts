import { ssrfSafeFetch } from "@agent-native/core/tools/url-safety";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isHostedClipsUrl } from "../../shared/clips.js";
import { verifyClipsShare } from "./clips-proof.js";

vi.mock("@agent-native/core/tools/url-safety", () => ({
  ssrfSafeFetch: vi.fn(),
}));

const fetchShare = vi.mocked(ssrfSafeFetch);
const share = "https://clips.agent-native.com/share/Demo-123";
const publicVideo = {
  id: "Demo-123",
  kind: "video",
  status: "ready",
  visibility: "public",
  hasPassword: false,
  mediaAccessToken: null,
  videoUrl: "/api/video/Demo-123",
};

beforeEach(() => {
  fetchShare.mockReset();
});

describe("Clips proof verification", () => {
  it.each([
    "http://clips.agent-native.com/share/Demo-123",
    "https://clips.agent-native.com./share/Demo-123",
    `${share}?agent_access=temporary-token`,
    "https://clips.agent-native.com/embed/Demo-123",
    "https://clips.agent-native.com/folder/../share/Demo-123",
  ])(
    "rejects invalid hosted candidate %s before requesting it",
    async (url) => {
      expect(isHostedClipsUrl(url)).toBe(true);
      await expect(verifyClipsShare(url)).rejects.toMatchObject({
        errorCode: "invalid_clips_link",
      });
      expect(fetchShare).not.toHaveBeenCalled();
    },
  );

  it("asks the public player API about this exact recording without redirects, credentials, or cache", async () => {
    fetchShare.mockResolvedValue(Response.json({ recording: publicVideo }));
    await expect(verifyClipsShare(` ${share}/ `)).resolves.toBe(share);
    expect(fetchShare).toHaveBeenCalledWith(
      "https://clips.agent-native.com/api/public-recording?id=Demo-123",
      expect.objectContaining({ credentials: "omit", cache: "no-store" }),
      { followRedirects: false, httpsOnly: true },
    );
  });

  it.each([
    [401, "clips_share_password_required"],
    [403, "clips_share_restricted"],
    [404, "clips_share_unavailable"],
    [409, "clips_share_redaction_pending"],
    [410, "clips_share_expired"],
    [429, "clips_verification_unavailable"],
  ])(
    "reports provider response %s without saving proof",
    async (status, errorCode) => {
      fetchShare.mockResolvedValue(
        Response.json({ error: "Clips response" }, { status }),
      );
      await expect(verifyClipsShare(share)).rejects.toMatchObject({
        errorCode,
      });
    },
  );

  it.each([
    [{ id: "different-id" }, "clips_verification_unavailable"],
    [{ visibility: "org" }, "clips_share_restricted"],
    [{ hasPassword: true }, "clips_share_password_required"],
    [{ mediaAccessToken: "unexpected-token" }, "clips_share_restricted"],
    [{ kind: "image" }, "clips_share_not_video"],
    [{ status: "processing" }, "clips_share_processing"],
    [{ verificationPending: true }, "clips_share_processing"],
    [{ status: "failed" }, "clips_share_processing_failed"],
    [{ videoUrl: null }, "clips_share_unavailable"],
  ])(
    "rejects a successful API response without a matching ready public video",
    async (patch, errorCode) => {
      fetchShare.mockResolvedValue(
        Response.json({ recording: { ...publicVideo, ...patch } }),
      );
      await expect(verifyClipsShare(share)).rejects.toMatchObject({
        errorCode,
      });
    },
  );

  it("rejects a generic 200 HTML response and an oversized JSON response", async () => {
    fetchShare
      .mockResolvedValueOnce(
        new Response("<h1>Sign in</h1>", {
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          recording: publicVideo,
          transcript: "x".repeat(1024 * 1024),
        }),
      );
    await expect(verifyClipsShare(share)).rejects.toMatchObject({
      errorCode: "clips_verification_unavailable",
    });
    await expect(verifyClipsShare(share)).rejects.toMatchObject({
      errorCode: "clips_verification_unavailable",
    });
  });
});
