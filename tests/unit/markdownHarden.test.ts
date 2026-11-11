import { describe, expect, it } from 'vitest';

import {
  hardenRenderedHtml,
  hardenUrlAttribute,
  isAllowedUrl,
  parseSrcset,
} from '../../src/lib/markdown/harden';

/** Pulls the value of an attribute straight back out of a rewritten string. */
function attributeFrom(html: string, tag: string, attribute: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>`).exec(html);
  if (!match) return null;
  const value = new RegExp(`\\s${attribute}="([^"]*)"`).exec(match[0]);
  return value ? value[1] : null;
}

function hasAttribute(html: string, tag: string, attribute: string): boolean {
  const match = new RegExp(`<${tag}\\b[^>]*>`).exec(html);
  // Word boundary so `srcset` is not mistaken for `src`.
  return Boolean(match && new RegExp(`\\s${attribute}(?:\\s*=|\\s|>)`).test(match[0]));
}

describe('hardenUrlAttribute policy', () => {
  it('keeps https, http and relative image addresses', () => {
    expect(hardenUrlAttribute('src', 'https://example.com/a.png')).toEqual({
      value: 'https://example.com/a.png',
    });
    expect(hardenUrlAttribute('src', '/images/a.png')).toEqual({ value: '/images/a.png' });
  });

  it('rejects javascript: and data:text/html URLs', () => {
    expect(hardenUrlAttribute('src', 'javascript:alert(1)')).toEqual({ remove: true });
    expect(hardenUrlAttribute('src', 'data:text/html;base64,PHNjcmlwdD4=')).toEqual({
      remove: true,
    });
    expect(hardenUrlAttribute('srcset', 'javascript:alert(1) 1x')).toEqual({ remove: true });
  });

  it('downgrades a rejected href to # instead of removing it', () => {
    expect(hardenUrlAttribute('href', 'javascript:alert(1)')).toEqual({ value: '#' });
  });

  it('removes an empty src rather than emitting a broken request', () => {
    expect(hardenUrlAttribute('src', '   ')).toEqual({ remove: true });
    expect(hardenUrlAttribute('srcset', '')).toEqual({ remove: true });
  });
});

describe('isAllowedUrl', () => {
  it('accepts the same schemes safeHref allows', () => {
    expect(isAllowedUrl('https://example.com/x')).toBe(true);
    expect(isAllowedUrl('#section')).toBe(true);
    expect(isAllowedUrl('./local.png')).toBe(true);
  });

  it('rejects everything safeHref downgrades', () => {
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedUrl('data:text/html,<x>')).toBe(false);
    expect(isAllowedUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedUrl('')).toBe(false);
  });
});

describe('parseSrcset', () => {
  it('splits candidates and keeps width/pixel descriptors attached', () => {
    expect(parseSrcset('https://a/1.png 1x, https://a/2.png 2x')).toEqual([
      { url: 'https://a/1.png', descriptor: ' 1x' },
      { url: 'https://a/2.png', descriptor: ' 2x' },
    ]);
    expect(parseSrcset('https://a/wide.png 640w')).toEqual([
      { url: 'https://a/wide.png', descriptor: ' 640w' },
    ]);
  });
});

describe('hardenRenderedHtml — images', () => {
  it('keeps an allowed https image and adds the three hardening attributes', () => {
    const html = hardenRenderedHtml('<p><img src="https://example.com/logo.png" alt="logo" /></p>');

    expect(attributeFrom(html, 'img', 'src')).toBe('https://example.com/logo.png');
    expect(attributeFrom(html, 'img', 'referrerpolicy')).toBe('no-referrer');
    expect(attributeFrom(html, 'img', 'loading')).toBe('lazy');
    expect(attributeFrom(html, 'img', 'decoding')).toBe('async');
    expect(attributeFrom(html, 'img', 'alt')).toBe('logo');
  });

  it('removes the src of a javascript: image so the original address cannot survive', () => {
    const html = hardenRenderedHtml('<img src="javascript:alert(1)" alt="x">');

    expect(html).not.toContain('javascript:');
    expect(hasAttribute(html, 'img', 'src')).toBe(false);
    // The element and its alt text remain, and the hardening attributes still apply.
    expect(html).toContain('<img');
    expect(attributeFrom(html, 'img', 'alt')).toBe('x');
    expect(attributeFrom(html, 'img', 'loading')).toBe('lazy');
  });

  it('removes the src of a data:text/html image', () => {
    const html = hardenRenderedHtml('<img src="data:text/html;base64,PHNjcmlwdD4=" alt="x">');

    expect(html).not.toContain('data:text/html');
    expect(hasAttribute(html, 'img', 'src')).toBe(false);
  });

  it('filters illegal candidates out of a srcset but keeps the legal ones', () => {
    const html = hardenRenderedHtml(
      '<img srcset="https://example.com/ok.png 1x, javascript:alert(1) 2x" src="https://example.com/ok.png">',
    );

    const srcset = attributeFrom(html, 'img', 'srcset');
    expect(srcset).toContain('https://example.com/ok.png 1x');
    expect(srcset).not.toContain('javascript:');
  });

  it('removes a srcset whose every candidate is illegal', () => {
    const html = hardenRenderedHtml(
      '<img srcset="javascript:alert(1) 1x, data:text/html,<x> 2x" src="https://example.com/ok.png">',
    );

    expect(hasAttribute(html, 'img', 'srcset')).toBe(false);
    expect(attributeFrom(html, 'img', 'src')).toBe('https://example.com/ok.png');
  });

  it('handles an empty src by removing the attribute', () => {
    const html = hardenRenderedHtml('<img src="" alt="empty">');

    expect(hasAttribute(html, 'img', 'src')).toBe(false);
    expect(attributeFrom(html, 'img', 'alt')).toBe('empty');
    // Hardening attributes are still filled in.
    expect(attributeFrom(html, 'img', 'decoding')).toBe('async');
  });

  it('does not overwrite hardening attributes the author explicitly set to legal values', () => {
    const html = hardenRenderedHtml(
      '<img src="https://example.com/a.png" referrerpolicy="origin" loading="eager" decoding="sync">',
    );

    expect(attributeFrom(html, 'img', 'referrerpolicy')).toBe('origin');
    expect(attributeFrom(html, 'img', 'loading')).toBe('eager');
    expect(attributeFrom(html, 'img', 'decoding')).toBe('sync');
  });

  it('replaces an unrecognised hardening value with the default', () => {
    const html = hardenRenderedHtml(
      '<img src="https://example.com/a.png" loading="whenever-i-feel-like-it">',
    );

    expect(attributeFrom(html, 'img', 'loading')).toBe('lazy');
  });

  it('hardens src/srcset on non-img elements such as picture sources', () => {
    const html = hardenRenderedHtml(
      '<picture><source srcset="javascript:alert(1)" /><img src="https://example.com/fallback.png" /></picture>',
    );

    expect(html).not.toContain('javascript:');
    expect(hasAttribute(html, 'source', 'srcset')).toBe(false);
    expect(attributeFrom(html, 'img', 'src')).toBe('https://example.com/fallback.png');
  });
});

describe('hardenRenderedHtml — links and other URL attributes', () => {
  it('downgrades a javascript: link to # while keeping the anchor and its text', () => {
    const html = hardenRenderedHtml('<p><a href="javascript:alert(1)">click</a></p>');

    expect(attributeFrom(html, 'a', 'href')).toBe('#');
    expect(html).toContain('>click</a>');
    expect(html).not.toContain('javascript:');
  });

  it('keeps an allowed href untouched', () => {
    const html = hardenRenderedHtml('<a href="https://example.com/docs">docs</a>');
    expect(attributeFrom(html, 'a', 'href')).toBe('https://example.com/docs');
  });

  it('removes a rejected src attribute on an element that is not an anchor', () => {
    const html = hardenRenderedHtml('<video src="javascript:alert(1)"></video>');
    expect(hasAttribute(html, 'video', 'src')).toBe(false);
    expect(html).toContain('<video');
  });

  it('leaves markup without URL attributes byte-identical in structure', () => {
    const source =
      '<h1 id="title">Title</h1><p>Body with <strong>bold</strong> text.</p><ul><li>one</li></ul>';
    expect(hardenRenderedHtml(source)).toBe(source);
  });

  it('decodes entities before checking the scheme and re-escapes the rewritten value', () => {
    const html = hardenRenderedHtml('<a href="java&#x73;cript:alert(1)">x</a>');
    expect(attributeFrom(html, 'a', 'href')).toBe('#');
    expect(html).not.toContain('cript:');
  });

  it('preserves query strings and ampersand escaping on allowed URLs', () => {
    const html = hardenRenderedHtml('<a href="https://example.com/a?b=1&amp;c=2">x</a>');
    // The value passes the allow-list decoded, and is re-escaped on the way out.
    expect(html).toContain('https://example.com/a?b=1&amp;c=2');
    expect(html).not.toContain('?b=1&c=2');
  });

  it('never adds target or rel attributes itself', () => {
    const html = hardenRenderedHtml(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
    const tag = /<a\b[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag.match(/target=/g)).toHaveLength(1);
    expect(tag.match(/rel=/g)).toHaveLength(1);
  });
});
