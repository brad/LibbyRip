/**
 * content.opf builder for the EPUB package.
 *
 * Manifest + spine from the chapter files and downloaded assets; metadata
 * from the book record. Tags the cover image both the EPUB 2 way
 * (`<meta name="cover">`) and the EPUB 3 way (`properties="cover-image"`)
 * so readers pick the right thumbnail instead of guessing.
 */

import { getFilenameFromURL, getMimeTypeFromFileName, truncate, type EpubFile } from './xhtml.js';

export interface EpubSpineComponent {
  meta: { id?: string; path: string };
  index: number;
}

export interface EpubBookMeta {
  identifier: string;
  title: string;
  creatorName: string;
  language?: string;
  descriptionText?: string;
}

const OPF_NS = 'http://www.idpf.org/2007/opf';
const DC_NS = 'http://purl.org/dc/elements/1.1/';

function el(doc: Document, ns: string, name: string): Element {
  return doc.createElementNS(ns, name);
}

/** First `src` of an `<img>` in `html`; when `onlyDocCover`, only one marked `role="doc-cover"`. */
function imgSrcOf(html: string, onlyDocCover: boolean): string | null {
  const tag = html.match(
    onlyDocCover ? /<img[^>]*role=["']doc-cover["'][^>]*>/i : /<img[^>]*>/i
  );
  if (!tag) return null;
  const src = tag[0].match(/src=["']([^"']+)["']/i);
  return src ? src[1] : null;
}

function isChapterFile(f: EpubFile): boolean {
  return typeof f.input === 'string' && /\.(xhtml|html)$/.test(f.name);
}

/**
 * Locate the cover image filename: an explicitly marked `doc-cover` image
 * anywhere wins, otherwise the first image of the first spine chapter
 * (chapter files are pushed in spine order).
 */
export function findCoverHref(files: EpubFile[]): string | null {
  for (const f of files) {
    if (!isChapterFile(f)) continue;
    const href = imgSrcOf(f.input as string, true);
    if (href) return href;
  }
  const firstChapter = files.find(isChapterFile);
  return firstChapter ? imgSrcOf(firstChapter.input as string, false) : null;
}

function uniqueId(idStore: string[], base: string): string {
  let id = base || crypto.randomUUID();
  while (idStore.includes(id)) id = `${id}-${crypto.randomUUID()}`;
  idStore.push(id);
  return id;
}

/** Append `OEBPS/content.opf` to `files`. */
export function makePackage(
  files: EpubFile[],
  assetRegistry: string[],
  components: EpubSpineComponent[],
  meta: EpubBookMeta
): void {
  const idStore: string[] = [];
  const doc = document.implementation.createDocument(OPF_NS, 'package', null);
  const pkg = doc.documentElement;
  pkg.setAttribute('version', '2.0');
  pkg.setAttribute('xml:lang', meta.language || 'en');
  pkg.setAttribute('unique-identifier', 'pub-identifier');
  pkg.setAttribute('xmlns', OPF_NS);
  pkg.setAttribute('xmlns:dc', DC_NS);
  pkg.setAttribute('xmlns:dcterms', 'http://purl.org/dc/terms/');
  pkg.setAttribute('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance');

  const metadata = el(doc, OPF_NS, 'metadata');
  pkg.appendChild(metadata);

  const dcIdentifier = el(doc, DC_NS, 'dc:identifier');
  dcIdentifier.setAttribute('id', 'pub-identifier');
  dcIdentifier.textContent = meta.identifier;
  metadata.appendChild(dcIdentifier);

  if (meta.language) {
    const dcLanguage = el(doc, DC_NS, 'dc:language');
    dcLanguage.setAttribute('xsi:type', 'dcterms:RFC4646');
    dcLanguage.textContent = meta.language;
    metadata.appendChild(dcLanguage);
  }

  const metaIdentifier = el(doc, OPF_NS, 'meta');
  metaIdentifier.setAttribute('id', 'meta-identifier');
  metaIdentifier.setAttribute('property', 'dcterms:identifier');
  metaIdentifier.textContent = meta.identifier;
  metadata.appendChild(metaIdentifier);

  const dcTitle = el(doc, DC_NS, 'dc:title');
  dcTitle.setAttribute('id', 'pub-title');
  dcTitle.textContent = meta.title;
  metadata.appendChild(dcTitle);

  if (meta.creatorName) {
    const dcCreator = el(doc, DC_NS, 'dc:creator');
    dcCreator.textContent = meta.creatorName;
    metadata.appendChild(dcCreator);
  }

  if (meta.descriptionText) {
    const dcDescription = el(doc, DC_NS, 'dc:description');
    dcDescription.textContent = meta.descriptionText;
    metadata.appendChild(dcDescription);
  }

  const manifest = el(doc, OPF_NS, 'manifest');
  pkg.appendChild(manifest);
  const spine = el(doc, OPF_NS, 'spine');
  spine.setAttribute('toc', 'ncx');
  pkg.appendChild(spine);

  const ncxItem = el(doc, OPF_NS, 'item');
  ncxItem.setAttribute('id', 'ncx');
  ncxItem.setAttribute('href', 'toc.ncx');
  ncxItem.setAttribute('media-type', 'application/x-dtbncx+xml');
  manifest.appendChild(ncxItem);

  for (const chapter of components) {
    const id = uniqueId(idStore, chapter.meta.id || '');
    const item = el(doc, OPF_NS, 'item');
    item.setAttribute('id', id);
    item.setAttribute('href', truncate(chapter.meta.path));
    item.setAttribute('media-type', 'application/xhtml+xml');
    manifest.appendChild(item);

    const itemref = el(doc, OPF_NS, 'itemref');
    itemref.setAttribute('idref', id);
    itemref.setAttribute('linear', 'yes');
    spine.appendChild(itemref);
  }

  const coverHref = findCoverHref(files);
  let coverId: string | null = null;

  for (const asset of assetRegistry) {
    const aname = asset.startsWith('http') ? getFilenameFromURL(asset) : asset;
    const id = uniqueId(idStore, aname.split('.')[0]);
    const item = el(doc, OPF_NS, 'item');
    item.setAttribute('id', id);
    item.setAttribute('href', aname);
    item.setAttribute('media-type', getMimeTypeFromFileName(aname));
    if (coverHref && aname === coverHref) {
      item.setAttribute('properties', 'cover-image'); // EPUB 3
      coverId = id;
    }
    manifest.appendChild(item);
  }

  if (coverId) {
    const coverMeta = el(doc, OPF_NS, 'meta');
    coverMeta.setAttribute('name', 'cover'); // EPUB 2
    coverMeta.setAttribute('content', coverId);
    metadata.appendChild(coverMeta);
  }

  const serializer = new XMLSerializer();
  files.push({
    name: 'OEBPS/content.opf',
    input: `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n${serializer.serializeToString(doc)}`,
  });
}
