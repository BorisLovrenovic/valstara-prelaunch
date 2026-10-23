export interface ContentsEntry {
  id: string;
  text: string;
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#x([\da-f]+)|#(\d+)|([a-z]+));/giu,
    (match, hex: string, decimal: string, name: string) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      return entities[name.toLowerCase()] ?? match;
    },
  );
}

// The contents list on legal and rules pages links only to section anchors
// that already exist in the rendered content (E11.5-09): every second-level
// heading that carries an id. Nothing is added to the content to create one,
// so a page whose content has no such heading gets an empty list.
export function contentsFromRenderedHtml(html: string): ContentsEntry[] {
  return [...html.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/giu)].flatMap(
    ([, attributes = '', inner = '']) => {
      const id = /\bid="([^"]+)"/u.exec(attributes)?.[1];
      const text = decodeEntities(inner.replace(/<[^>]*>/gu, ''))
        .replace(/\s+/gu, ' ')
        .trim();
      return id && text ? [{ id: decodeEntities(id), text }] : [];
    },
  );
}
