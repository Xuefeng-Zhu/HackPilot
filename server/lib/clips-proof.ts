import { fail } from "@agent-native/core/action";
import { ssrfSafeFetch } from "@agent-native/core/tools/url-safety";
import { z } from "zod";

import { HOSTED_CLIPS_HOSTNAME } from "../../shared/clips.js";

const CLIPS_ORIGIN = `https://${HOSTED_CLIPS_HOSTNAME}`;
const SHARE_URL =
  /^https:\/\/clips\.agent-native\.com\/share\/([a-z0-9_-]{1,128})\/?$/i;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CHECK_TIMEOUT_MS = 8_000;

const publicRecordingResponse = z.object({
  recording: z.object({
    id: z.string(),
    kind: z.enum(["video", "image"]),
    visibility: z.enum(["public", "private", "org"]),
    status: z.enum(["uploading", "processing", "ready", "failed"]),
    hasPassword: z.boolean(),
    mediaAccessToken: z.string().nullable(),
    verificationPending: z.boolean().optional(),
    videoUrl: z.string().nullable(),
  }),
});

function verificationUnavailable(): never {
  return fail("Clips verification is unavailable. Try again in a moment.", {
    errorCode: "clips_verification_unavailable",
    statusCode: 502,
  });
}

function sharePasswordRequired(): never {
  return fail("This Clips recording is password-protected. Share a link that opens without a password.", {
    errorCode: "clips_share_password_required",
    statusCode: 422,
  });
}

function shareRestricted(): never {
  return fail(
    "The recording must open without sign-in or a password. Check its sharing settings in Clips.",
    { errorCode: "clips_share_restricted", statusCode: 422 },
  );
}

async function readRecordingResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let json = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(json + decoder.decode());
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error("Clips response exceeded the size limit");
      json += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Verify the same public recording data that the Clips share page uses for its player. */
export async function verifyClipsShare(
  raw: string,
  signal?: AbortSignal,
): Promise<string> {
  const shareId = SHARE_URL.exec(raw.trim())?.[1];
  if (!shareId) {
    fail("Paste a public Clips share link from clips.agent-native.com.", {
      errorCode: "invalid_clips_link",
      statusCode: 400,
    });
  }

  // The Clips share route passes its shareId directly to the public player API.
  const endpoint = new URL("/api/public-recording", CLIPS_ORIGIN);
  endpoint.searchParams.set("id", shareId);
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  let response: Response;
  let body: unknown;
  try {
    response = await ssrfSafeFetch(
      endpoint.href,
      {
        headers: { accept: "application/json", "cache-control": "no-cache" },
        cache: "no-store",
        credentials: "omit",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      },
      { followRedirects: false, httpsOnly: true },
    );
    if (
      response.ok &&
      /^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      body = await readRecordingResponse(response);
    } else {
      void response.body?.cancel().catch(() => {});
    }
  } catch {
    signal?.throwIfAborted();
    return verificationUnavailable();
  }
  signal?.throwIfAborted();

  switch (response.status) {
    case 401:
      return sharePasswordRequired();
    case 403:
      return shareRestricted();
    case 404:
      fail(
        "Clips could not find a public recording at this link. Check the link and sharing settings.",
        {
          errorCode: "clips_share_unavailable",
          statusCode: 422,
        },
      );
    case 409:
      fail(
        "Clips is holding playback while video redactions are processed. Try again when the share plays.",
        {
          errorCode: "clips_share_redaction_pending",
          statusCode: 422,
        },
      );
    case 410:
      fail(
        "This Clips share link has expired. Copy a current public link from Clips.",
        {
          errorCode: "clips_share_expired",
          statusCode: 422,
        },
      );
  }

  const result = publicRecordingResponse.safeParse(body);
  if (!response.ok || !result.success || result.data.recording.id !== shareId) {
    return verificationUnavailable();
  }
  const { recording } = result.data;
  if (recording.hasPassword) return sharePasswordRequired();
  if (recording.visibility !== "public" || recording.mediaAccessToken !== null) {
    return shareRestricted();
  }
  if (recording.kind !== "video") {
    fail(
      "This Clips share contains a screenshot. Attach a video recording instead.",
      {
        errorCode: "clips_share_not_video",
        statusCode: 422,
      },
    );
  }
  if (recording.status === "failed") {
    fail(
      "Clips could not process this recording. Check it in Clips before attaching it.",
      {
        errorCode: "clips_share_processing_failed",
        statusCode: 422,
      },
    );
  }
  if (recording.status !== "ready" || recording.verificationPending) {
    fail(
      "Clips is still preparing this recording. Try again when it plays in Clips.",
      {
        errorCode: "clips_share_processing",
        statusCode: 422,
      },
    );
  }

  const mediaUrl = recording.videoUrl?.trim();
  const playback = mediaUrl && URL.parse(mediaUrl, CLIPS_ORIGIN);
  if (
    !playback ||
    playback.protocol !== "https:" ||
    playback.username ||
    playback.password
  ) {
    fail("Clips did not provide a playback URL for this recording.", {
      errorCode: "clips_share_unavailable",
      statusCode: 422,
    });
  }
  return `${CLIPS_ORIGIN}/share/${shareId}`;
}
