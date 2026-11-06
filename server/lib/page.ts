import { fail } from "@agent-native/core/action";
import { ssrfSafeFetch } from "@agent-native/core/tools/url-safety";

export interface FetchedPage {
  url: string;
  html: string;
  text: string;
  title: string | null;
  description: string | null;
}

const MAX_BYTES = 3_000_000;
export const MAX_SOURCE_TEXT = 40_000;

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    fail("That doesn't look like a valid URL.", {
      errorCode: "invalid_url",
      statusCode: 400,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("Only http(s) URLs can be imported.", {
      errorCode: "invalid_url",
      statusCode: 400,
    });
  }
  parsed.hash = "";
  return parsed.toString();
}

/** Fetch a public page server-side (SSRF-guarded) and turn it into text. */
export async function fetchPage(url: string): Promise<FetchedPage> {
  let res: Response;
  try {
    res = await ssrfSafeFetch(
      url,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; HackPilot/1.0; +https://www.agent-native.com)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
        signal: AbortSignal.timeout(20_000),
      },
      { maxRedirects: 5 },
    );
  } catch (error) {
    fail(
      `Could not fetch ${url}: ${error instanceof Error ? error.message : "network error"}. Paste the page details instead.`,
      { errorCode: "fetch_failed", statusCode: 502 },
    );
  }
  if (!res.ok) {
    fail(`The page answered ${res.status}. Paste the page details instead.`, {
      errorCode: "fetch_failed",
      statusCode: 502,
      details: { status: res.status },
    });
  }
  const buf = await res.arrayBuffer();
  const html = new TextDecoder("utf-8").decode(buf.slice(0, MAX_BYTES));
  return { url: res.url || url, ...htmlToText(html), html };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  middot: "·",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: "…",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function meta(html: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
      "i",
    );
    const m = html.match(re);
    const v = m?.[1] ?? m?.[2];
    if (v) return decodeEntities(v).trim();
  }
  return null;
}

export function htmlToText(html: string): {
  text: string;
  title: string | null;
  description: string | null;
} {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title =
    meta(html, ["og:title", "twitter:title"]) ??
    (titleTag ? decodeEntities(titleTag).trim() : null);
  const description = meta(html, ["description", "og:description"]);
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<head[\s\S]*?<\/head>/i, " ");
  body = body
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|dt|dd|blockquote|main|nav|aside)>/gi,
      "\n",
    )
    .replace(/<(h[1-6])[^>]*>/gi, "\n## ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(
      (line, i, arr) =>
        line.length > 0 &&
        !(line === "##" || line === "-") &&
        arr[i - 1] !== line,
    )
    .join("\n")
    .slice(0, MAX_SOURCE_TEXT * 2);
  return { text, title, description };
}
