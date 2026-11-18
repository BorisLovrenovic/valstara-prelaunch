import { DomUtils, parseDocument } from 'htmlparser2';

// A thin layer over htmlparser2 (a dev dependency; the tool never ships in
// the image): a parsed document, element queries and visible text.

export type HtmlDocument = ReturnType<typeof parseDocument>;
export type HtmlElement = ReturnType<typeof DomUtils.findAll>[number];
type HtmlNode = HtmlDocument['children'][number];

export function parseHtml(html: string): HtmlDocument {
  return parseDocument(html);
}

export function attribute(
  element: HtmlElement,
  name: string,
): string | undefined {
  return DomUtils.getAttributeValue(element, name);
}

export function hasClass(element: HtmlElement, name: string): boolean {
  return (attribute(element, 'class') ?? '').split(/\s+/).includes(name);
}

/** Every element under `root` (itself excluded) that passes `test`, in document order. */
export function findAll(
  root: HtmlDocument | HtmlElement,
  test: (element: HtmlElement) => boolean,
): HtmlElement[] {
  return DomUtils.findAll(test, root.children);
}

/** The text a reader sees: text nodes joined, comments left out. */
export function visibleText(node: HtmlNode | HtmlElement): string {
  return DomUtils.textContent(node);
}

/** The element's raw text content, for a `<script>`. */
export function scriptText(element: HtmlElement): string {
  return DomUtils.textContent(element);
}

export function isInside(element: HtmlElement, ancestor: HtmlElement): boolean {
  let parent = element.parent;
  while (parent) {
    if (parent === ancestor) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

export function tagIs(name: string) {
  return (element: HtmlElement): boolean => element.name === name;
}
