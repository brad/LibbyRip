/**
 * toc.ncx builder (EPUB 2 navigation).
 */

import { truncate, type EpubFile } from './xhtml.js';
import type { EpubSpineComponent } from './opf.js';

const NCX_NS = 'http://www.daisy.org/z3986/2005/ncx/';

function el(doc: Document, name: string): Element {
  return doc.createElementNS(NCX_NS, name);
}

/** Append `OEBPS/toc.ncx` to `files`. */
export function makeToc(
  files: EpubFile[],
  components: EpubSpineComponent[],
  bookId: string,
  title: string
): void {
  const doc = document.implementation.createDocument(NCX_NS, 'ncx', null);
  const ncx = doc.documentElement;
  ncx.setAttribute('version', '2005-1');

  const head = el(doc, 'head');
  ncx.appendChild(head);
  const uidMeta = el(doc, 'meta');
  uidMeta.setAttribute('name', 'dtb:uid');
  uidMeta.setAttribute('content', bookId);
  head.appendChild(uidMeta);

  const docTitle = el(doc, 'docTitle');
  ncx.appendChild(docTitle);
  const titleText = el(doc, 'text');
  titleText.textContent = title;
  docTitle.appendChild(titleText);

  const navMap = el(doc, 'navMap');
  ncx.appendChild(navMap);

  for (const chapter of components) {
    const navPoint = el(doc, 'navPoint');
    navPoint.setAttribute('id', chapter.meta.id || `navpoint-${chapter.index}`);
    navPoint.setAttribute('playOrder', String(1 + chapter.index));
    navMap.appendChild(navPoint);

    const navLabel = el(doc, 'navLabel');
    navPoint.appendChild(navLabel);
    const labelText = el(doc, 'text');
    labelText.textContent = title;
    navLabel.appendChild(labelText);

    const content = el(doc, 'content');
    content.setAttribute('src', truncate(chapter.meta.path));
    navPoint.appendChild(content);
  }

  const serializer = new XMLSerializer();
  files.push({
    name: 'OEBPS/toc.ncx',
    input: `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n${serializer.serializeToString(doc)}`,
  });
}
