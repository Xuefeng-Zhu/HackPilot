import { describe, expect, it } from "vitest";

import { extractDesignBuildReference } from "./design-build-reference.js";

describe("static Design build reference", () => {
  it("preserves visual facts and controls while omitting executable content and URLs", () => {
    const html = `<!doctype html>
      <html><head><style>
        @import "https://attacker.test/theme.css";
        :root { --Brand: #126e58; font-family: Inter, sans-serif; }
        .mission-board { display: grid; grid-template-columns: 1fr 2fr; gap: 18px; }
        .action { color: var(--Brand); background: url(https://attacker.test/pixel); }
        @media (max-width: 600px) { .mission-board { grid-template-columns: 1fr; } }
      </style><script src="https://attacker.test/setup.js"></script></head>
      <body><main class="mission-board"><h1>Mission control</h1>
        <form action="https://attacker.test/form">
          <input type="text" aria-label="Mission name" value="do not transfer" />
          <button class="action" style="padding: 10px 20px" onclick="sendSecrets()">Launch mission</button>
        </form>
        <a href="https://attacker.test/help">Help at https://attacker.test/help</a>
        <p hidden>hidden request data</p>
        <svg><text>foreign content</text></svg>
        <script>console.log('private script')</script>
      </main></body></html>`;

    const result = extractDesignBuildReference(html);
    const { screen, styles } = JSON.parse(result);
    expect(screen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "main",
          depth: 1,
          classes: ["mission-board"],
        }),
        expect.objectContaining({
          tag: "h1",
          depth: 2,
          text: "Mission control",
        }),
        expect.objectContaining({
          tag: "input",
          label: "Mission name",
          inputType: "text",
        }),
        expect.objectContaining({
          tag: "button",
          text: "Launch mission",
          style: { padding: "10px 20px" },
        }),
      ]),
    );
    expect(styles).toEqual(
      expect.arrayContaining([
        {
          selectors: [":root"],
          style: { "--Brand": "#126e58", "font-family": "Inter, sans-serif" },
        },
        {
          selectors: [".mission-board"],
          style: {
            display: "grid",
            "grid-template-columns": "1fr 2fr",
            gap: "18px",
          },
        },
        { selectors: [".action"], style: { color: "var(--Brand)" } },
        {
          selectors: [".mission-board"],
          media: "(max-width: 600px)",
          style: { "grid-template-columns": "1fr" },
        },
      ]),
    );
    expect(result).not.toMatch(
      /attacker\.test|private script|sendSecrets|do not transfer|hidden request data|foreign content|<\w/,
    );
  });

  it("caps the model input by bytes while preserving valid reference JSON", () => {
    const paragraphs = `<p>${"試".repeat(160)}</p>`.repeat(110);
    const rules = Array.from(
      { length: 120 },
      (_, i) => `.item${i}{box-shadow:${"1px 2px #123, ".repeat(10)}none}`,
    ).join("\n");
    const result = extractDesignBuildReference(
      `<style>${rules}</style><main>${paragraphs}</main>`,
    );
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(24_030);
    const { screen, styles } = JSON.parse(result);
    expect(screen.length).toBeGreaterThan(10);
    expect(screen.length).toBeLessThan(110);
    expect(styles.length).toBeGreaterThan(10);
  });

  it("rejects script-only or oversized inputs", () => {
    for (const input of [
      "<script>renderApp()</script>",
      `<p>${"x".repeat(96_000)}</p>`,
    ]) {
      expect(() => extractDesignBuildReference(input)).toThrow(
        expect.objectContaining({
          errorCode: "design_build_unusable",
        }),
      );
    }
  });
});
