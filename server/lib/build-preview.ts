import fs from "node:fs/promises";
import path from "node:path";

export const DESIGN_PREVIEW_FILENAME = "design-preview.html";
export const DESIGN_PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src data:",
  "style-src data: 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

// These names are fixed by the Design build's Vite config. Keep the browser
// document independent of authenticated asset requests from its opaque origin.
const MODULE_NAME = "assets/preview.js";
const STYLE_NAME = "assets/preview.css";
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

export async function writeDesignPreview(root: string, dir: string) {
  const dist = path.join(dir, "dist");
  const assets = await fs.readdir(path.join(dist, "assets"));
  const modules = assets.filter((name) => name.endsWith(".js"));
  const styles = assets.filter((name) => name.endsWith(".css"));
  if (
    modules.length !== 1 ||
    modules[0] !== path.basename(MODULE_NAME) ||
    styles.length > 1 ||
    (styles[0] && styles[0] !== path.basename(STYLE_NAME)) ||
    assets.length !== modules.length + styles.length
  ) {
    throw new Error("The Design preview requires one local JavaScript bundle and optional CSS.");
  }
  const modulePath = path.join(dist, MODULE_NAME);
  const stylePath = styles.length ? path.join(dist, STYLE_NAME) : null;
  const [moduleStat, styleStat] = await Promise.all([
    fs.stat(modulePath),
    stylePath ? fs.stat(stylePath) : null,
  ]);
  if (!moduleStat.size || moduleStat.size + (styleStat?.size ?? 0) > MAX_BUNDLE_BYTES) {
    throw new Error("The Design preview bundle is empty or exceeds 2 MiB.");
  }
  const [js, css] = await Promise.all([
    fs.readFile(modulePath, "base64"),
    stylePath ? fs.readFile(stylePath, "base64") : null,
  ]);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build preview</title>
${css ? `<link rel="stylesheet" href="data:text/css;base64,${css}">` : ""}
</head>
<body><div id="root"></div>
<script type="module" src="data:text/javascript;base64,${js}"></script>
</body>
</html>`;
  await fs.writeFile(path.join(root, DESIGN_PREVIEW_FILENAME), html);
}
