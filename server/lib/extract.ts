/**
 * Deterministic, dependency-free extraction of hackathon facts from page
 * text. It is the fallback when no LLM key is configured and a baseline the
 * LLM result is merged over. Everything here is best effort: the agent and
 * the user can correct any field with `update-hackathon`.
 */
import {
  type Criterion,
  normalizeRubric,
  type Prize,
  type Requirement,
  slugKey,
} from "../../shared/hackpilot.js";
import {
  monthFromName,
  timezoneAlias,
  zonedWallTimeToUtcIso,
} from "../../shared/time.js";

export interface ExtractedHackathon {
  name: string;
  tagline: string | null;
  deadlineAt: string | null;
  timezone: string;
  prizes: Prize[];
  rubric: Criterion[];
  requirements: Requirement[];
  warnings: string[];
}

const strip = (line: string) => line.replace(/^(##|-)\s*/, "").trim();

export function guessName(title: string | null, url: string): string {
  if (title) {
    const first = title.split(/\s+[|–—]\s+|\s+-\s+/)[0]?.trim();
    if (first && first.length > 2) return first.slice(0, 160);
  }
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).pop();
    return `${u.hostname.replace(/^www\./, "")}${tail ? ` ${tail}` : ""}`;
  } catch {
    return "Untitled hackathon";
  }
}

// ---------------------------------------------------------------- rubric

const PERCENT_ONLY = /^(\d{1,3}(?:\.\d+)?)\s*%$/;
const NAME_WITH_PERCENT =
  /^(.{3,80}?)\s*(?:[(:\-–—]\s*)?(\d{1,3}(?:\.\d+)?)\s*%\)?$/;

export function extractRubric(lines: string[]): Criterion[] {
  const found: Criterion[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = strip(lines[i] ?? "");
    let name: string | null = null;
    let weight: number | null = null;
    const only = line.match(PERCENT_ONLY);
    if (only) {
      // "Usefulness and Execution" on the line above, "40%" on its own.
      const prev = strip(lines[i - 1] ?? "");
      if (prev && !PERCENT_ONLY.test(prev) && prev.length <= 80) {
        name = prev;
        weight = Number(only[1]);
      }
    } else {
      const m = line.match(NAME_WITH_PERCENT);
      if (
        m?.[1] &&
        m[2] &&
        !/\$|off|discount|of (?:the )?(?:prize|participants)/i.test(m[1])
      ) {
        name = m[1].replace(/[\s:(\-–—]+$/, "").trim();
        weight = Number(m[2]);
      }
    }
    if (!name || weight === null || weight <= 0 || weight > 100) continue;
    const next = strip(lines[i + 1] ?? "");
    const description =
      next &&
      !PERCENT_ONLY.test(next) &&
      !lines[i + 1]?.startsWith("##") &&
      next.length < 300
        ? next
        : undefined;
    found.push({ id: slugKey(name), name, weight, description });
  }
  // Keep the first contiguous-looking group that sums close to 100.
  for (let start = 0; start < found.length; start++) {
    let sum = 0;
    for (let end = start; end < found.length; end++) {
      sum += found[end]?.weight ?? 0;
      if (sum >= 95 && sum <= 105 && end > start) {
        return normalizeRubric(found.slice(start, end + 1));
      }
      if (sum > 105) break;
    }
  }
  return found.length >= 2 && found.length <= 8 ? normalizeRubric(found) : [];
}

// ---------------------------------------------------------------- prizes

const MONEY =
  /(?:(US\$|\$|€|£|USD\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?(?:\s?(k|K))?)|(\d{1,3}(?:,\d{3})+|\d+)\s?(USD|EUR|GBP)/;
const PRIZE_LABEL =
  /(grand prize|first|second|third|1st|2nd|3rd|\dth|winner|runner[- ]?up|honou?rable|best |track|category|place|prize|award|bounty)/i;
const POOL_LINE = /(in prizes|prize pool|across|totaling|total of|worth of)/i;

function parseMoney(line: string): { amount: number; currency: string } | null {
  const m = line.match(MONEY);
  if (!m) return null;
  if (m[2]) {
    let amount = Number(m[2].replace(/,/g, ""));
    if (m[3]) amount *= 1000;
    const sym = (m[1] ?? "").trim();
    const currency = sym === "€" ? "EUR" : sym === "£" ? "GBP" : "USD";
    return { amount, currency };
  }
  return {
    amount: Number((m[4] ?? "0").replace(/,/g, "")),
    currency: m[5] ?? "USD",
  };
}

export function extractPrizes(lines: string[]): Prize[] {
  const prizes: Prize[] = [];
  const seenLabels = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = strip(lines[i] ?? "");
    const money = parseMoney(line);
    if (!money || money.amount <= 0) continue;
    if (POOL_LINE.test(line)) continue;
    let label = line
      .replace(new RegExp(MONEY.source, "g"), "")
      .replace(/[\s:–—-]+$/, "")
      .trim();
    if (!label || label.length < 3) {
      // Amount on its own line: the label is just above (skip a subtitle).
      for (const back of [1, 2]) {
        const candidate = strip(lines[i - back] ?? "");
        if (
          candidate &&
          PRIZE_LABEL.test(candidate) &&
          !parseMoney(candidate)
        ) {
          label = candidate;
          break;
        }
      }
      if (!label) label = strip(lines[i - 1] ?? "") || "Prize";
    }
    if (!PRIZE_LABEL.test(label) && label.length > 60) continue;
    const key = label.toLowerCase();
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    prizes.push({
      label: label.slice(0, 160),
      amount: money.amount,
      currency: money.currency,
    });
  }
  return prizes.slice(0, 20);
}

// ---------------------------------------------------------------- deadline

const DATE_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i;
const TIME_24_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const TZ_RE =
  /\b(PT|PST|PDT|MT|MST|MDT|CT|CST|CDT|ET|EST|EDT|UTC|GMT|BST|CET|CEST|IST|JST|SGT|AEST|AEDT)\b/;
const DEADLINE_HINT =
  /(deadline|submissions? (?:close|due)|submit by|due (?:by|date)|closes? on|final submission|last day to submit)/i;

const ZONE_PHRASES: [RegExp, string][] = [
  [/pacific time/i, "America/Los_Angeles"],
  [/eastern time/i, "America/New_York"],
  [/central time/i, "America/Chicago"],
  [/mountain time/i, "America/Denver"],
  [/coordinated universal time|\bUTC\b/i, "UTC"],
];

export function detectTimezone(text: string): string | null {
  const allTimes = text.match(
    /all times (?:are )?(?:in )?([A-Za-z ]+?)(?:\(|\.|\n|$)/i,
  );
  if (allTimes) {
    for (const [re, tz] of ZONE_PHRASES) if (re.test(allTimes[1] ?? "")) return tz;
    const token = (allTimes[1] ?? "").match(TZ_RE);
    if (token?.[1]) return timezoneAlias(token[1]);
  }
  const token = text.match(TZ_RE);
  if (token?.[1]) return timezoneAlias(token[1]);
  for (const [re, tz] of ZONE_PHRASES) if (re.test(text)) return tz;
  return null;
}

function inferYear(text: string, month: number, now: Date): number {
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  const plausible = years.filter(
    (y) => y >= now.getUTCFullYear() - 1 && y <= now.getUTCFullYear() + 2,
  );
  if (plausible.length) {
    const counts = new Map<number, number>();
    for (const y of plausible) counts.set(y, (counts.get(y) ?? 0) + 1);
    return [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || b[0] - a[0],
    )[0]![0];
  }
  const y = now.getUTCFullYear();
  return month < now.getUTCMonth() + 1 ? y + 1 : y;
}

export function extractDeadline(
  lines: string[],
  fullText: string,
  now = new Date(),
): { deadlineAt: string | null; timezone: string | null } {
  const pageTz = detectTimezone(fullText);
  type Candidate = {
    score: number;
    wall: {
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
    };
    tz: string | null;
  };
  const candidates: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!DEADLINE_HINT.test(lines[i] ?? "")) continue;
    const windowLines = [
      lines[i],
      lines[i + 1] ?? "",
      lines[i - 1] ?? "",
      lines[i + 2] ?? "",
      lines[i - 2] ?? "",
    ];
    let date: { year: number | null; month: number; day: number } | null = null;
    let time: { hour: number; minute: number } | null = null;
    let tz: string | null = null;
    let score = 0;
    for (const [idx, l = ""] of windowLines.entries()) {
      if (!date) {
        const iso = l.match(ISO_DATE_RE);
        const d = l.match(DATE_RE);
        if (iso)
          date = {
            year: Number(iso[1]),
            month: Number(iso[2]),
            day: Number(iso[3]),
          };
        else if (d) {
          const month = monthFromName(d[1] ?? "");
          if (month)
            date = {
              year: d[3] ? Number(d[3]) : null,
              month,
              day: Number(d[2]),
            };
        }
        if (date && idx === 0) score += 2;
      }
      if (!time) {
        const t = l.match(TIME_RE);
        if (t) {
          let hour = Number(t[1]) % 12;
          if (/p/i.test(t[3] ?? "")) hour += 12;
          time = { hour, minute: Number(t[2] ?? 0) };
        } else {
          const t24 = l.match(TIME_24_RE);
          if (t24) time = { hour: Number(t24[1]), minute: Number(t24[2]) };
        }
      }
      if (!tz) {
        const z = l.match(TZ_RE);
        if (z?.[1]) tz = timezoneAlias(z[1]);
      }
    }
    if (!date) continue;
    if (time) score += 1;
    if (tz) score += 1;
    const year = date.year ?? inferYear(fullText, date.month, now);
    candidates.push({
      score,
      wall: {
        year,
        month: date.month,
        day: date.day,
        hour: time?.hour ?? 23,
        minute: time ? time.minute : 59,
      },
      tz,
    });
  }
  if (!candidates.length) return { deadlineAt: null, timezone: pageTz };
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;
  const tz = best.tz ?? pageTz ?? "UTC";
  return { deadlineAt: zonedWallTimeToUtcIso(best.wall, tz), timezone: tz };
}

// ---------------------------------------------------------- requirements

const REQUIREMENT_RULES: {
  kind: Requirement["kind"];
  label: string;
  re: RegExp;
}[] = [
  {
    kind: "demo_video",
    label: "Demo video",
    re: /(demo video|video demo|record (?:a|your)|clips demo|youtube|loom|vimeo|screen ?recording)/i,
  },
  {
    kind: "repo",
    label: "Code repository",
    re: /(github|gitlab|repository|repo link|source code|open[- ]source)/i,
  },
  {
    kind: "writeup",
    label: "Project write-up",
    re: /(write-?up|project (?:details|description)|readme|describe your project|project story)/i,
  },
  {
    kind: "deployment",
    label: "Working app / live link",
    re: /(working app|live (?:demo|url|link|app)|deployed|hosted (?:app|url)|demo link)/i,
  },
  {
    kind: "form",
    label: "Submission form",
    re: /(submit your project|submission form|submission page|devpost|submit (?:on|via|through))/i,
  },
  {
    kind: "slides",
    label: "Pitch deck",
    re: /(pitch deck|slide deck|slides)/i,
  },
];

export function extractRequirements(lines: string[]): Requirement[] {
  const out: Requirement[] = [];
  for (const rule of REQUIREMENT_RULES) {
    const hit = lines.find(
      (l) => rule.re.test(l) && l.length >= 16 && l.length < 240,
    );
    if (hit)
      out.push({ kind: rule.kind, label: rule.label, detail: strip(hit) });
  }
  return out;
}

export function extractHackathon(input: {
  text: string;
  title: string | null;
  description: string | null;
  url: string;
  now?: Date;
}): ExtractedHackathon {
  const lines = input.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const warnings: string[] = [];
  const rubric = extractRubric(lines);
  const prizes = extractPrizes(lines);
  const { deadlineAt, timezone } = extractDeadline(
    lines,
    input.text,
    input.now,
  );
  const requirements = extractRequirements(lines);
  if (!deadlineAt) warnings.push("No deadline found; set it manually.");
  if (!rubric.length)
    warnings.push(
      "No weighted judging rubric found; add criteria manually or ask the agent.",
    );
  if (!prizes.length) warnings.push("No prizes found.");
  const h1 = lines.find((l) => l.startsWith("## "));
  return {
    name: guessName(input.title, input.url),
    tagline:
      input.description?.slice(0, 300) ?? (h1 ? strip(h1).slice(0, 300) : null),
    deadlineAt,
    timezone: timezone ?? "UTC",
    prizes,
    rubric,
    requirements,
    warnings,
  };
}
