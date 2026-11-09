import { fail } from "@agent-native/core/action";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss, { type ChildNode as CssNode } from "postcss";

import { readOwnedDesignIndexHtml } from "./companion-apps.js";

type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlNode = DefaultTreeAdapterTypes.ChildNode;
type Styles = Record<string, string>;

const MAX_HTML_BYTES = 96_000;
const MAX_OUTLINE_BYTES = 14_000;
const MAX_STYLESHEET_BYTES = 10_000;
const MAX_NODES = 120;
const MAX_RULES = 90;

const SCREEN_TAGS = new Set([
  "body",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "section",
  "article",
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "small",
  "strong",
  "em",
  "mark",
  "a",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "img",
  "hr",
  "details",
  "summary",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "button",
  "form",
  "fieldset",
  "legend",
  "label",
  "input",
  "select",
  "option",
  "textarea",
  "progress",
  "meter",
  "output",
]);
const CONTROL_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "progress",
  "meter",
]);

const STYLE_PROPERTIES = new Set([
  "display",
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "aspect-ratio",
  "overflow",
  "overflow-x",
  "overflow-y",
  "box-sizing",
  "object-fit",
  "object-position",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "grid",
  "grid-template",
  "grid-template-areas",
  "grid-template-columns",
  "grid-template-rows",
  "grid-column",
  "grid-row",
  "grid-area",
  "grid-auto-flow",
  "grid-auto-columns",
  "grid-auto-rows",
  "gap",
  "column-gap",
  "row-gap",
  "align-items",
  "align-self",
  "align-content",
  "justify-items",
  "justify-self",
  "justify-content",
  "place-items",
  "place-content",
  "order",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-inline",
  "margin-block",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-inline",
  "padding-block",
  "background",
  "background-color",
  "background-image",
  "color",
  "opacity",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "box-shadow",
  "outline",
  "outline-offset",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration",
  "text-wrap",
  "white-space",
]);
const STYLE_FUNCTIONS = new Set([
  "calc",
  "clamp",
  "min",
  "max",
  "var",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "oklch",
  "oklab",
  "color",
  "linear-gradient",
  "radial-gradient",
  "conic-gradient",
  "repeat",
  "minmax",
  "fit-content",
]);

const IDENTIFIER = /^[a-z_][\w-]{0,47}$/i;
const STYLE_VALUE = /^[\w\s#.,%+*()/'"-]{1,160}$/;
const SELECTOR =
  /^(?:[a-z0-9_.#* >+~-]|:(?:root|hover|focus(?:-visible)?|disabled|checked|first-child|last-child)(?![\w-])){1,120}$/i;
const MEDIA_QUERY = /^\((?:min-|max-)?width:\s*\d{1,4}(?:px|rem|em)\)$/i;

type ScreenFact = {
  tag: string;
  depth: number;
  id?: string;
  classes?: string[];
  text?: string;
  label?: string;
  placeholder?: string;
  inputType?: string;
  style?: Styles;
};

type RuleFact = { selectors: string[]; style: Styles; media?: string };

function isElement(node: HtmlNode): node is HtmlElement {
  return (
    "tagName" in node && node.namespaceURI === "http://www.w3.org/1999/xhtml"
  );
}

function textLabel(value: string | undefined) {
  return (
    value
      ?.replace(
        /\b(?:[a-z][\w+.-]*:\/\/|www\.|mailto:|data:|javascript:)[^\s<>"']+|\/\/[a-z0-9][^\s<>"']*/gi,
        " ",
      )
      .replace(/[<>\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || undefined
  );
}

function directText(element: HtmlElement) {
  return element.childNodes
    .flatMap((child) => ("value" in child ? [child.value] : []))
    .join(" ");
}

function styleFacts(nodes: readonly CssNode[] | undefined) {
  const facts: Styles = {};
  for (const node of nodes ?? []) {
    if (node.type !== "decl") continue;
    const property = node.prop.startsWith("--")
      ? node.prop
      : node.prop.toLowerCase();
    const value = node.value.trim();
    if (
      !STYLE_PROPERTIES.has(property) &&
      !/^--[a-z][\w-]{0,47}$/i.test(property)
    )
      continue;
    if (!STYLE_VALUE.test(value) || /\/\/|\/\*|\*\//.test(value)) continue;
    if (
      Array.from(value.matchAll(/([a-z][\w-]*)\s*\(/gi)).some(
        ([, name]) => !STYLE_FUNCTIONS.has(name?.toLowerCase() ?? ""),
      )
    )
      continue;
    facts[property] = value;
    if (Object.keys(facts).length === 20) break;
  }
  return facts;
}

function parseCss(css: string) {
  try {
    return postcss.parse(css).nodes;
  } catch {
    // Invalid styles do not make a readable screen unusable.
    return [];
  }
}

function outline(body: HtmlElement) {
  const facts: ScreenFact[] = [];
  const pending = [{ element: body, depth: 0 }];
  let bytes = 0;
  while (pending.length && facts.length < MAX_NODES) {
    const { element, depth } = pending.pop()!;
    const tag = element.tagName;
    if (depth > 24 || !SCREEN_TAGS.has(tag)) continue;
    const attributes = new Map(
      element.attrs.map(({ name, value }) => [name, value]),
    );
    const inputType =
      tag === "input" ? attributes.get("type")?.toLowerCase() : undefined;
    if (
      attributes.has("hidden") ||
      attributes.get("aria-hidden") === "true" ||
      inputType === "hidden"
    )
      continue;
    const id = attributes.get("id");
    const classes = attributes
      .get("class")
      ?.split(/\s+/)
      .filter((name) => IDENTIFIER.test(name))
      .slice(0, 8);
    const text = textLabel(directText(element));
    const label = textLabel(
      attributes.get("aria-label") ?? attributes.get("alt"),
    );
    const placeholder = textLabel(attributes.get("placeholder"));
    const inline = attributes.get("style");
    const inlineRule =
      inline && inline.length <= 3000 && !/[{}]/.test(inline)
        ? parseCss(`x{${inline}}`)[0]
        : undefined;
    const style =
      inlineRule?.type === "rule" ? styleFacts(inlineRule.nodes) : {};
    const fact: ScreenFact = {
      tag,
      depth,
      ...(id && IDENTIFIER.test(id) ? { id } : {}),
      ...(classes?.length ? { classes } : {}),
      ...(text ? { text } : {}),
      ...(label ? { label } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(inputType && /^[a-z-]{1,16}$/.test(inputType) ? { inputType } : {}),
      ...(Object.keys(style).length ? { style } : {}),
    };
    bytes += Buffer.byteLength(JSON.stringify(fact)) + 1;
    if (bytes > MAX_OUTLINE_BYTES) break;
    facts.push(fact);
    for (const child of element.childNodes.slice().reverse()) {
      if (isElement(child)) pending.push({ element: child, depth: depth + 1 });
    }
  }
  return facts;
}

function stylesheet(root: HtmlElement) {
  const facts: RuleFact[] = [];
  let bytes = 0;
  function readRules(nodes: readonly CssNode[], media?: string) {
    for (const node of nodes) {
      if (bytes >= MAX_STYLESHEET_BYTES || facts.length === MAX_RULES) return;
      if (
        node.type === "atrule" &&
        !media &&
        node.name.toLowerCase() === "media"
      ) {
        const query = node.params.trim();
        if (MEDIA_QUERY.test(query)) readRules(node.nodes ?? [], query);
      }
      if (node.type !== "rule") continue;
      const selectors = node.selectors
        .filter((selector) => SELECTOR.test(selector))
        .slice(0, 8);
      const style = styleFacts(node.nodes);
      if (!selectors.length || !Object.keys(style).length) continue;
      const fact = { selectors, style, ...(media ? { media } : {}) };
      bytes += Buffer.byteLength(JSON.stringify(fact)) + 1;
      if (bytes <= MAX_STYLESHEET_BYTES) facts.push(fact);
    }
  }
  const pending = [root];
  while (
    pending.length &&
    bytes < MAX_STYLESHEET_BYTES &&
    facts.length < MAX_RULES
  ) {
    const element = pending.pop()!;
    if (element.tagName === "style") {
      readRules(parseCss(directText(element)));
    } else if (
      element.tagName === "html" ||
      element.tagName === "head" ||
      SCREEN_TAGS.has(element.tagName)
    ) {
      for (const child of element.childNodes.slice().reverse()) {
        if (isElement(child)) pending.push(child);
      }
    }
  }
  return facts;
}

/** Describe the screen as data. Never execute, render, or retrieve its assets. */
export function extractDesignBuildReference(html: string): string {
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
    fail(
      "The Design prototype is too large to use. Simplify its index.html and retry.",
      {
        errorCode: "design_build_unusable",
      },
    );
  }
  const document = parse(html);
  const root = document.childNodes.find(
    (node): node is HtmlElement => isElement(node) && node.tagName === "html",
  );
  const body = root?.childNodes.find(
    (node): node is HtmlElement => isElement(node) && node.tagName === "body",
  );
  const screen = body ? outline(body) : [];
  const styles = root ? stylesheet(root) : [];
  if (
    !screen.some(
      (node) =>
        node.text ||
        node.label ||
        node.placeholder ||
        node.style ||
        CONTROL_TAGS.has(node.tag),
    ) &&
    !(screen.length > 1 && styles.length)
  ) {
    fail("The Design prototype has no usable static screen in index.html.", {
      errorCode: "design_build_unusable",
    });
  }
  return JSON.stringify({ screen, styles });
}

export async function readDesignBuildReference(
  userEmail: string,
  designId: string,
): Promise<string> {
  const html = await readOwnedDesignIndexHtml(userEmail, designId);
  return extractDesignBuildReference(html);
}
