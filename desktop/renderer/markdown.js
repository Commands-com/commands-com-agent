/**
 * markdown.js — Untrusted markdown renderer for renderer process.
 *
 * Uses vendored marked ESM (sandbox-compatible) plus a strict sanitizer.
 */

import { marked } from './vendor/marked.esm.js';

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * Defense-in-depth sanitizer for marked output.
 * Strips: dangerous tags, on* handlers, and javascript:/data: href/src schemes.
 */
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?(?:script|iframe|object|embed|form|style|link|base|meta|img)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*"[\s]*(?:javascript:|data:)[^"]*"/gi, ' $1="#blocked:"')
    .replace(/\s(href|src)\s*=\s*'[\s]*(?:javascript:|data:)[^']*'/gi, ' $1="#blocked:"')
    .replace(/\s(href|src)\s*=\s*`[\s]*(?:javascript:|data:)[^`]*`/gi, ' $1="#blocked:"')
    .replace(/\s(href|src)\s*=\s*(?:javascript:|data:)[^\s>]+/gi, ' $1="#blocked:"');
}

function blockedImageSpan(altText, srcText, titleText) {
  const alt = escapeHtml((altText || '').trim() || 'image');
  const src = escapeHtml((srcText || '').trim());
  const title = escapeHtml((titleText || '').trim() || 'External images blocked');
  const label = src ? `${alt} - ${src}` : alt;
  return `<span class="md-image-blocked" title="${title}">[blocked ${label}]</span>`;
}

const renderer = new marked.Renderer();

// Escape raw HTML in markdown source.
renderer.html = (html) => {
  const raw = typeof html === 'string' ? html : html?.text || html?.raw || '';
  return escapeHtml(raw);
};

// Block markdown image rendering entirely to prevent silent external fetches.
renderer.image = (href, title, text) => {
  const token = href && typeof href === 'object' ? href : null;
  const src = token ? token.href : href;
  const alt = token ? token.text : text;
  const effectiveTitle = token ? token.title : title;
  return blockedImageSpan(String(alt || ''), String(src || ''), String(effectiveTitle || ''));
};

marked.setOptions({ breaks: true, gfm: true, renderer });

export function renderMarkdownUntrusted(text) {
  try {
    return sanitizeHtml(marked.parse(String(text || '')));
  } catch {
    return escapeHtml(text);
  }
}

