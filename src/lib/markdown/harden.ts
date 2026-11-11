import { safeHref } from './url';

/**
 * Unified URL and image hardening for rendered Markdown.
 *
 * The public page (`renderStaticMarkdown`) and the editor preview
 * (`renderMarkdown`) both render author-controlled Markdown into HTML. This
 * module applies one policy to both outputs:
 *
 * - every URL-bearing attribute (`href`, `src`, `srcset`) is filtered through
 *   the same scheme allow-list as {@link safeHref};
 * - a rejected link keeps its element but is downgraded to `#`;
 * - a rejected image never keeps its original address: the offending attribute
 *   is removed (the `img` element stays, so layout and `alt` text survive);
 * - every `img` receives `referrerpolicy`, `loading` and `decoding`, without
 *   overwriting values the author explicitly wrote.
 *
 * The DOM entry point backs the browser preview; the string entry point backs
 * server-side static rendering, where no DOM implementation is available.
 */

const URL_ATTRIBUTES = ['href', 'src', 'srcset'] as const;
type UrlAttribute = (typeof URL_ATTRIBUTES)[number];

const IMG_DEFAULTS = {
  referrerpolicy: 'no-referrer',
  loading: 'lazy',
  decoding: 'async',
} as const;

/**
 * Referrer-Policy values browsers accept. Anything else is treated as missing
 * rather than echoed verbatim, so an author cannot smuggle a fake value past
 * the hardening pass.
 */
const REFERRER_POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

const LOADING_VALUES = new Set(['lazy', 'eager']);
const DECODING_VALUES = new Set(['async', 'sync', 'auto']);

const IMG_ATTRIBUTE_VALIDATORS: Readonly<Record<keyof typeof IMG_DEFAULTS, ReadonlySet<string>>> = {
  referrerpolicy: REFERRER_POLICIES,
  loading: LOADING_VALUES,
  decoding: DECODING_VALUES,
};

/** A parsed `srcset` candidate: its URL plus the descriptor the browser needs. */
interface SrcsetCandidate {
  url: string;
  /** The raw " 2x" / " 640w" suffix, including the separating whitespace. */
  descriptor: string;
}

/**
 * Applies the {@link safeHref} allow-list to a single URL attribute.
 *
 * Returns the replacement value, or `null` when the attribute must be removed.
 * Rejected `href` values are downgraded to `#` so anchors stay in place with
 * their link text; a rejected `src`/`srcset` is removed instead, because an
 * image must never retain (or silently re-point through `#`) its original
 * address.
 */
export function hardenUrlAttribute(
  attribute: UrlAttribute,
  rawValue: string,
): { value: string } | { remove: true } {
  const value = rawValue.trim();
  if (!value) return { remove: true };

  if (attribute === 'srcset') {
    const candidates = parseSrcset(value).filter((candidate) => isAllowedUrl(candidate.url));
    if (candidates.length === 0) return { remove: true };
    return { value: serializeSrcset(candidates) };
  }

  const safe = safeHref(value);
  if (safe === '') return { remove: true };
  if (safe === '#') {
    // Only navigational links degrade to '#'; embedded resources are dropped.
    return attribute === 'href' ? { value: '#' } : { remove: true };
  }
  return { value: safe };
}

/**
 * Whether `url` passes the scheme allow-list. Relative references and the
 * http/https/mailto schemes are accepted; everything `safeHref` downgrades to
 * `#` (javascript:, data:text/html, vbscript:, file:, …) is rejected.
 */
export function isAllowedUrl(url: string): boolean {
  const value = url.trim();
  if (!value) return false;
  return safeHref(value) !== '#';
}

/**
 * Splits a `srcset` value into candidates the way the HTML spec describes:
 * commas only separate candidates when followed by whitespace (a comma inside
 * a URL, e.g. an unquoted `data:` URL, stays part of that URL), and each
 * candidate is a URL followed by an optional whitespace-separated descriptor.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const parts: string[] = [];
  let chunk = '';

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === ',' && /\s/.test(value[index + 1] ?? '')) {
      parts.push(chunk);
      chunk = '';
    } else {
      chunk += char;
    }
  }
  parts.push(chunk);

  const candidates: SrcsetCandidate[] = [];
  for (const part of parts) {
    const match = /^(\s*\S+)(\s+.*)?$/.exec(part.trim());
    if (!match) continue;
    const url = (match[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!url) continue;
    candidates.push({ url, descriptor: match[2] ?? '' });
  }
  return candidates;
}

function serializeSrcset(candidates: readonly SrcsetCandidate[]): string {
  return candidates.map((candidate) => `${candidate.url}${candidate.descriptor}`).join(', ');
}

/**
 * Fills the three hardening attributes on an `img`, keeping any value the
 * author already wrote as long as it is one the browser recognises.
 */
export function applyImageDefaults(
  read: (attribute: keyof typeof IMG_DEFAULTS) => string | null,
  write: (attribute: keyof typeof IMG_DEFAULTS, value: string) => void,
): void {
  for (const attribute of Object.keys(IMG_DEFAULTS) as (keyof typeof IMG_DEFAULTS)[]) {
    const existing = read(attribute)?.trim();
    if (existing && IMG_ATTRIBUTE_VALIDATORS[attribute].has(existing.toLowerCase())) continue;
    write(attribute, IMG_DEFAULTS[attribute]);
  }
}

// ---------------------------------------------------------------------------
// DOM entry point (editor preview and any in-browser rendering)
// ---------------------------------------------------------------------------

/**
 * Hardens a rendered DOM subtree in place and returns the same root.
 *
 * Every element carrying `href`, `src` or `srcset` is checked, and every
 * `img` receives the default hardening attributes.
 */
export function hardenRenderedDom<T extends Element>(root: T): T {
  const selector = URL_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(',');

  root.querySelectorAll<Element>(selector).forEach((element) => {
    for (const attribute of URL_ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) continue;
      const raw = element.getAttribute(attribute) ?? '';
      const result = hardenUrlAttribute(attribute, raw);
      if ('remove' in result) {
        element.removeAttribute(attribute);
      } else {
        element.setAttribute(attribute, result.value);
      }
    }
  });

  root.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    applyImageDefaults(
      (attribute) => image.getAttribute(attribute),
      (attribute, value) => image.setAttribute(attribute, value),
    );
  });

  return root;
}

// ---------------------------------------------------------------------------
// String entry point (server-side static rendering; no DOM available)
// ---------------------------------------------------------------------------

interface ParsedAttribute {
  /** Lower-cased attribute name. */
  name: string;
  /** Decoded attribute value, or the empty string for a boolean attribute. */
  value: string;
  /** Whether the source carried an explicit (possibly empty) value. */
  quoted: boolean;
  /** Original raw text of the attribute, including name and quoting. */
  raw: string;
}

const ATTRIBUTE_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match);
}

function parseAttributes(segment: string): ParsedAttribute[] {
  const attributes: ParsedAttribute[] = [];
  for (const match of segment.matchAll(ATTRIBUTE_PATTERN)) {
    const [raw, name, doubleQuoted, singleQuoted, unquoted] = match;
    if (!name) continue;
    const rawValue = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
    attributes.push({
      name: name.toLowerCase(),
      value: decodeHtmlEntities(rawValue),
      quoted: doubleQuoted !== undefined || singleQuoted !== undefined || unquoted !== undefined,
      raw,
    });
  }
  return attributes;
}

function serializeAttribute(attribute: ParsedAttribute): string {
  // Boolean attributes (e.g. `<video controls>`) carry no value.
  if (!attribute.quoted && attribute.value === '') return ` ${attribute.name}`;
  return ` ${attribute.name}="${escapeAttribute(attribute.value)}"`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function isImageTag(tagName: string): boolean {
  return tagName.toLowerCase() === 'img';
}

interface ScannedTag {
  /** Index of the opening `<`. */
  start: number;
  /** Index just past the closing `>`. */
  end: number;
  closing: boolean;
  tagName: string;
  /** The raw source text of the whole tag, including the angle brackets. */
  raw: string;
  /** The raw text between the tag name and the closing `>`. */
  segment: string;
}

/**
 * Walks the HTML one character at a time, tracking quoted attribute values so
 * a `>` (or `<`) inside a quote never terminates a tag. Comments, processing
 * instructions and doctypes are skipped wholesale.
 */
function scanTags(html: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  let index = 0;

  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;

    // Comments, CDATA, doctypes and processing instructions: skip to their end.
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[open + 1] === '?' || html[open + 1] === '!') {
      const close = html.indexOf('>', open);
      index = close === -1 ? html.length : close + 1;
      continue;
    }

    const header = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(open, open + 32));
    if (!header) {
      // A stray `<` that is not a tag: emit it as text and move on.
      index = open + 1;
      continue;
    }
    const closing = header[1] === '/';
    const tagName = header[2];
    let cursor = open + header[0].length;
    let quote: '"' | "'" | null = null;

    while (cursor < html.length) {
      const char = html[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      cursor += 1;
    }

    if (cursor >= html.length) {
      // Unterminated tag: leave the remainder untouched.
      break;
    }

    tags.push({
      start: open,
      end: cursor + 1,
      closing,
      tagName,
      raw: html.slice(open, cursor + 1),
      segment: html.slice(open + header[0].length, cursor).replace(/\s*\/\s*$/, ''),
    });
    index = cursor + 1;
  }

  return tags;
}

function rewriteTag(tag: ScannedTag): string {
  const attributes = parseAttributes(tag.segment);
  const hasUrlAttribute = attributes.some((attribute) =>
    (URL_ATTRIBUTES as readonly string[]).includes(attribute.name),
  );
  // Nothing this pass owns: reproduce the source tag verbatim.
  if (!hasUrlAttribute && !isImageTag(tag.tagName)) {
    return tag.raw;
  }

  const kept = new Map<string, ParsedAttribute>();
  const removed = new Set<string>();

  for (const attribute of attributes) {
    if ((URL_ATTRIBUTES as readonly string[]).includes(attribute.name)) {
      const result = hardenUrlAttribute(attribute.name as UrlAttribute, attribute.value);
      if ('remove' in result) {
        removed.add(attribute.name);
        continue;
      }
      kept.set(attribute.name, { ...attribute, value: result.value });
    } else {
      kept.set(attribute.name, attribute);
    }
  }

  if (isImageTag(tag.tagName)) {
    applyImageDefaults(
      (name) => {
        if (removed.has(name)) return null;
        return kept.get(name)?.value ?? null;
      },
      (name, value) => {
        kept.set(name, { name, value, quoted: true, raw: '' });
      },
    );
  }

  const rewritten = [...kept.values()].map((attribute) => serializeAttribute(attribute));
  return `<${tag.tagName}${rewritten.join('')}>`;
}

/**
 * Hardens an HTML string without a DOM implementation, returning the rewritten
 * string. Only start tags are rewritten; text nodes, comments and end tags are
 * copied byte-for-byte, so documents that contain no URL attributes come back
 * unchanged.
 */
export function hardenRenderedHtml(html: string): string {
  const tags = scanTags(html);
  if (tags.length === 0) return html;

  let output = '';
  let cursor = 0;
  for (const tag of tags) {
    output += html.slice(cursor, tag.start);
    output += tag.closing ? html.slice(tag.start, tag.end) : rewriteTag(tag);
    cursor = tag.end;
  }
  output += html.slice(cursor);
  return output;
}

/**
 * Hardens either an HTML string or a rendered DOM root, depending on the input
 * type. The two entry points share one policy; this convenience keeps call
 * sites in the render pipeline identical.
 */
export function hardenRenderedMarkdown(input: string): string;
export function hardenRenderedMarkdown<T extends Element>(input: T): T;
export function hardenRenderedMarkdown(input: string | Element): string | Element {
  return typeof input === 'string' ? hardenRenderedHtml(input) : hardenRenderedDom(input);
}
