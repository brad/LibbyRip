/**
 * XHTML normalization for EPUB chapters.
 *
 * Takes chapter HTML (decrypted via `decryptChapterShell`) and produces
 * valid XHTML: lowercased tags, images rewritten to local filenames with
 * their remote URLs collected into an asset registry, stylesheets linked.
 */

export interface EpubFile {
  name: string;
  input: Blob | string;
}

/** `foo/bar/baz.jpg` -> `baz.jpg` */
export function truncate(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

/** `https://host/a/b.jpg?x=1` -> `b.jpg` (pathname only, no query). */
export function getFilenameFromURL(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname.substring(pathname.lastIndexOf('/') + 1);
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mp3',
  pdf: 'application/pdf',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  json: 'application/json',
};

export function getMimeTypeFromFileName(fileName: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

const XHTML_NAMESPACES =
  'xmlns="http://www.w3.org/1999/xhtml" ' +
  'xmlns:epub="http://www.idpf.org/2007/ops" ' +
  'xmlns:m="http://www.w3.org/1998/Math/MathML" ' +
  'xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" ' +
  'xmlns:ssml="http://www.w3.org/2001/10/synthesis" ' +
  'xmlns:svg="http://www.w3.org/2000/svg"';

/**
 * Normalize one chapter's HTML into XHTML.
 *
 * @param metaId        identifier stamped onto `<body id=...>`
 * @param baseUrl       chapter URL used to resolve relative asset URLs
 * @param htmlString    chapter HTML
 * @param assetRegistry append-only list collecting absolute asset URLs
 * @param stylesheetLinks CSS URLs to `<link>` into `<head>`
 * @param defaultTitle  fallback `<title>` text
 */
export function enforceEpubXHTML(
  metaId: string,
  baseUrl: string,
  htmlString: string,
  assetRegistry: string[],
  stylesheetLinks: string[],
  defaultTitle: string
): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  const body = doc.querySelector('body');
  if (body) body.setAttribute('id', metaId);

  // Convert all elements to lowercase tag names. Snapshot the live
  // collection first so replacing nodes doesn't disturb iteration.
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    const replacement = doc.createElement(el.tagName.toLowerCase());
    for (const attr of Array.from(el.attributes)) {
      replacement.setAttribute(attr.name, attr.value);
    }
    while (el.firstChild) {
      replacement.appendChild(el.firstChild);
    }
    el.parentNode?.replaceChild(replacement, el);
  }

  // Rewrite image sources to local filenames; collect remote URLs.
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'img' && tag !== 'image') continue;
    let src = el.getAttribute('src') || el.getAttribute('xlink:href');
    if (!src) continue;
    if (!src.startsWith('http://') && !src.startsWith('https://')) {
      src = new URL(src, new URL(baseUrl)).toString();
    }
    if (!assetRegistry.includes(src)) assetRegistry.push(src);
    if (el.getAttribute('src')) el.setAttribute('src', truncate(src));
    if (el.getAttribute('xlink:href')) el.setAttribute('xlink:href', truncate(src));
  }

  // Ensure <head> exists with a <title>.
  let head = doc.querySelector('head');
  if (!head) {
    head = doc.createElement('head');
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
  }
  if (!head.querySelector('title')) {
    const title = doc.createElement('title');
    title.textContent = defaultTitle;
    head.appendChild(title);
  }

  for (const link of stylesheetLinks) {
    const href = link.startsWith('http://') || link.startsWith('https://')
      ? link
      : new URL(link, new URL(baseUrl)).toString();
    const linkElement = doc.createElement('link');
    linkElement.setAttribute('href', truncate(href));
    linkElement.setAttribute('rel', 'stylesheet');
    linkElement.setAttribute('type', 'text/css');
    head.appendChild(linkElement);
  }

  const serializer = new XMLSerializer();
  let xhtmlString = serializer.serializeToString(doc);

  if (!xhtmlString.includes('xmlns="http://www.w3.org/1999/xhtml"')) {
    xhtmlString = xhtmlString.replace('<html>', `<html ${XHTML_NAMESPACES}>`);
  }
  return xhtmlString;
}

/** Wrap normalized chapter XHTML with the XML declaration. */
export function fixXhtml(
  metaId: string,
  baseUrl: string,
  html: string,
  assetRegistry: string[],
  stylesheetLinks: string[],
  defaultTitle: string
): string {
  const inner = enforceEpubXHTML(
    metaId,
    baseUrl,
    `<!DOCTYPE html><html ${XHTML_NAMESPACES}>${html}</html>`,
    assetRegistry,
    stylesheetLinks,
    defaultTitle
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${inner}`;
}
