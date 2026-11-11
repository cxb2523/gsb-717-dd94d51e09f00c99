/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { hardenRenderedDom } from '../../src/lib/markdown/harden';
import { renderMarkdown } from '../../src/lib/markdown/render';
import { renderStaticMarkdown } from '../../src/lib/markdown/renderStatic';

const target = () => document.createElement('div');

describe('hardenRenderedDom', () => {
  function parse(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    return hardenRenderedDom(root);
  }

  it('keeps an allowed https image and fills the hardening attributes', () => {
    const root = parse('<img src="https://example.com/a.png" alt="a">');
    const image = root.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('https://example.com/a.png');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('decoding')).toBe('async');
  });

  it('removes the src of javascript: and data:text/html images', () => {
    const root = parse(
      '<img src="javascript:alert(1)" alt="js">' +
        '<img src="data:text/html;base64,PHNjcmlwdD4=" alt="data">',
    );
    const images = [...root.querySelectorAll('img')];
    expect(images[0].hasAttribute('src')).toBe(false);
    expect(images[0].getAttribute('alt')).toBe('js');
    expect(images[1].hasAttribute('src')).toBe(false);
    expect(images[1].getAttribute('alt')).toBe('data');
  });

  it('filters a mixed srcset down to its legal candidates', () => {
    const root = parse('<img srcset="https://example.com/ok.png 1x, javascript:alert(1) 2x">');
    const srcset = root.querySelector('img')!.getAttribute('srcset')!;
    expect(srcset).toContain('https://example.com/ok.png 1x');
    expect(srcset).not.toContain('javascript');
  });

  it('removes an empty src but still hardens the element', () => {
    const root = parse('<img src="" alt="empty">');
    const image = root.querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('decoding')).toBe('async');
  });

  it('respects explicit legal hardening values and ignores illegal ones', () => {
    const root = parse(
      '<img src="https://example.com/a.png" loading="eager" referrerpolicy="bogus">',
    );
    const image = root.querySelector('img')!;
    expect(image.getAttribute('loading')).toBe('eager');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('decoding')).toBe('async');
  });

  it('downgrades rejected links to # and never touches target/rel', () => {
    const root = parse(
      '<a href="javascript:alert(1)" target="_blank" rel="noopener noreferrer">x</a>',
    );
    const anchor = root.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('#');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('renderMarkdown preview pipeline', () => {
  it('strips a javascript image src and hardens the remaining img', async () => {
    const element = target();
    await renderMarkdown(element, '<img src="javascript:alert(1)" alt="x">', { math: false });

    const image = element.querySelector('img')!;
    expect(image).toBeTruthy();
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('decoding')).toBe('async');
  });

  it('keeps an https image and its explicit hardening values', async () => {
    const element = target();
    await renderMarkdown(
      element,
      '<img src="https://example.com/a.png" loading="eager" alt="kept">',
      { math: false },
    );

    const image = element.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('https://example.com/a.png');
    expect(image.getAttribute('loading')).toBe('eager');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('decoding')).toBe('async');
  });

  it('removes illegal srcset candidates inside raw HTML', async () => {
    const element = target();
    await renderMarkdown(
      element,
      '<img srcset="https://example.com/ok.png 1x, javascript:alert(1) 2x" src="https://example.com/ok.png">',
      { math: false },
    );

    const image = element.querySelector('img')!;
    expect(image.getAttribute('srcset')).not.toContain('javascript');
    expect(image.getAttribute('srcset')).toContain('https://example.com/ok.png');
  });

  it('does not stack target/rel onto an anchor that already carries them', async () => {
    const element = target();
    await renderMarkdown(
      element,
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
      { math: false },
    );

    const anchor = element.querySelector('a')!;
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.outerHTML.match(/target=/g)).toHaveLength(1);
    expect(anchor.outerHTML.match(/rel=/g)).toHaveLength(1);
  });

  it('still marks plain external links and leaves in-page anchors alone', async () => {
    const element = target();
    await renderMarkdown(element, '[ext](https://example.com) [in](#section)', { math: false });

    const [external, internal] = [...element.querySelectorAll('a')];
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(internal.hasAttribute('target')).toBe(false);
    expect(internal.hasAttribute('rel')).toBe(false);
  });

  it('handles an empty image src at the full preview pipeline boundary', async () => {
    const element = target();
    await renderMarkdown(element, '<img src="" alt="empty">', { math: false });

    const image = element.querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.getAttribute('alt')).toBe('empty');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('decoding')).toBe('async');
  });
});

describe('renderStaticMarkdown public pipeline', () => {
  it('renders an https image with the hardening attributes', () => {
    const { html } = renderStaticMarkdown('![logo](https://example.com/logo.png)');

    expect(html).toContain('src="https://example.com/logo.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it('removes the src of a javascript image instead of keeping the address', () => {
    const { html } = renderStaticMarkdown('![x](javascript:alert(1))');

    expect(html).not.toContain('javascript:');
    expect(html).toMatch(/<img\b(?![^>]*\ssrc=)[^>]*>/);
    expect(html).toContain('alt="x"');
    expect(html).toContain('loading="lazy"');
  });

  it('removes the src of a data:text/html image', () => {
    const { html } = renderStaticMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)');

    expect(html).not.toContain('data:text/html');
    expect(html).not.toMatch(/<img[^>]*\ssrc=/);
  });

  it('downgrades a rejected link to #', () => {
    const { html } = renderStaticMarkdown('[click](javascript:alert(1))');
    expect(html).toContain('href="#"');
    expect(html).not.toContain('javascript:');
  });

  it('handles an empty image src at the full static pipeline boundary', () => {
    const { html } = renderStaticMarkdown('![empty]()');
    expect(html).not.toMatch(/<img[^>]*\ssrc=/);
    expect(html).toContain('alt="empty"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it('still renders headings, so the public page structure is unchanged', () => {
    const { html, headings } = renderStaticMarkdown('# Title\n\n## Section');
    expect(html).toContain('<h1 id="title">');
    expect(html).toContain('<h2 id="section">');
    expect(headings.map((heading) => heading.id)).toEqual(['title', 'section']);
  });
});
