/**
 * Ebook (EPUB) download orchestration.
 *
 * Fetches each chapter from its signed iframe URL, decrypts the chapter
 * shell client-side, normalizes to XHTML, downloads assets with bounded
 * concurrency, and assembles the EPUB (OPF + NCX + zip).
 */

import type { BIF, EbookSpineComponent } from './bif.js';
import { decryptChapterShell } from './decrypt.js';
import { fixXhtml, getFilenameFromURL, truncate, type EpubFile } from '../epub/xhtml.js';
import { makePackage } from '../epub/opf.js';
import { makeToc } from '../epub/ncx.js';
import { safeFilename } from '../utils/fetch.js';

/** Minimal progress surface; structurally compatible with ProgressDisplay. */
export interface EbookProgress {
  add(msg: string): void;
  clear(): void;
}

export type ZipFactory = () => Promise<
  (files: EpubFile[]) => Promise<{ blob: () => Promise<Blob>; body?: ReadableStream<Uint8Array> | null }>
>;

/** Visible (non-hidden) spine components in order. */
export function getBookComponents(bif: BIF): EbookSpineComponent[] {
  const components = bif.objects.reader?._.context.spine._.components ?? [];
  return components.filter((p) => 'hidden' !== (p.block || {}).behavior);
}

/** Signed per-chapter URL from the component's loaded iframe. */
export function chapterUrl(c: EbookSpineComponent): string | null {
  const f = c.sheetBox?.querySelector('iframe');
  return f?.src ? f.src : null;
}

const CHAPTER_WAIT_MS = 120_000;
const CHAPTER_POLL_MS = 100;

/**
 * Force chapters to load, then wait until every component's iframe has a
 * `src`. Gives up after 2 minutes rather than hanging forever.
 */
export async function waitForChapters(
  components: EbookSpineComponent[],
  onTick: () => void
): Promise<void> {
  for (const page of components) {
    if (chapterUrl(page)) continue;
    page._loadContent({ callback: () => undefined });
  }
  const deadline = Date.now() + CHAPTER_WAIT_MS;
  while (components.some((page) => !chapterUrl(page))) {
    if (Date.now() > deadline) {
      const pending = components.filter((p) => !chapterUrl(p)).map((p) => p.id);
      console.warn('Timed out waiting for chapters: ' + pending.join(', '));
      break;
    }
    await new Promise((r) => setTimeout(r, CHAPTER_POLL_MS));
    onTick();
  }
}

const ASSET_CONCURRENCY = 6;
const ASSET_MAX_ATTEMPTS = 3;

/**
 * Fetch one asset with retries. Retries throttling (429), server errors
 * (5xx), and network failures with exponential backoff; other 4xx fail
 * fast since they won't recover.
 */
async function fetchAssetWithRetry(url: string): Promise<Response> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= ASSET_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return response;
      lastError = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt < ASSET_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error(lastError);
}

function descriptionText(bif: BIF): string | undefined {
  const d = bif.map.description as unknown;
  if (!d) return undefined;
  if (typeof d === 'string') return d;
  // Libby sometimes provides { full: "<html>" }; strip tags for the OPF.
  const full = (d as { full?: unknown }).full;
  if (typeof full === 'string') {
    const p = document.createElement('p');
    p.innerHTML = full;
    return p.textContent || undefined;
  }
  return undefined;
}

/**
 * Build the complete EPUB file list: decrypted chapters as XHTML, downloaded
 * assets, content.opf, and toc.ncx. Does not zip or save.
 */
export async function buildEbookFiles(bif: BIF, progress: EbookProgress): Promise<EpubFile[]> {
  const files: EpubFile[] = [];

  // EPUB spec requires mimetype first and META-INF/container.xml
  files.push({ name: 'mimetype', input: 'application/epub+zip' });
  files.push({
    name: 'META-INF/container.xml',
    input:
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>` +
      `</rootfiles></container>`,
  });
  const imgAssets: string[] = [];
  const cssRegistry: Record<string, string[]> = {};

  const components = getBookComponents(bif);
  const total = components.length;
  progress.add(`Gathering chapters <span id="chapAcc"> 0/${total} </span>`);

  await waitForChapters(components, () => {
    const ready = components.filter((p) => chapterUrl(p)).length;
    const el = document.querySelector('span#chapAcc');
    if (el) el.innerHTML = ` ${ready}/${total}`;
  });
  progress.add('Chapter gathering complete');

  // Collect stylesheet URLs from each chapter iframe (also seeds assets).
  // The cover image goes first so the OPF tags it as the cover (merged
  // build behavior: cover URL from the BIF root image, front of queue).
  const coverEl = bif.root.querySelector('image');
  const coverHref = coverEl ? coverEl.getAttribute('href') : null;
  if (coverHref && !imgAssets.includes(coverHref)) {
    imgAssets.unshift(coverHref);
    console.log('[LibbyRip] Added cover image to download queue');
  }
  const idToIframe = new Map<string, HTMLIFrameElement>();
  const idToMetaId = new Map<string, string>();
  for (const c of components) {
    const iframe = c.sheetBox.querySelector('iframe');
    if (!iframe) {
      console.warn('No iframe for chapter ' + c.id);
      continue;
    }
    c.meta.id = c.meta.id || crypto.randomUUID();
    idToMetaId.set(c.id, c.meta.id);
    idToIframe.set(c.id, iframe);
    const links = iframe.contentWindow?.document.querySelectorAll('link') ?? [];
    for (const link of Array.from(links)) {
      const href = (link as HTMLLinkElement).href;
      cssRegistry[c.id] = cssRegistry[c.id] || [];
      cssRegistry[c.id].push(href);
      if (!imgAssets.includes(href)) imgAssets.push(href);
    }
  }

  // Chapters are fetched sequentially (gentle on the server); each shell is
  // decrypted client-side before XHTML normalization.
  let fetched = 0;
  for (const c of components) {
    const src = idToIframe.get(c.id)?.src || chapterUrl(c);
    if (!src) {
      console.warn('No chapter URL for ' + c.id + ', skipping');
      continue;
    }
    let res: Response;
    try {
      res = await fetch(src, { credentials: 'include' });
    } catch (e) {
      progress.add(`<b>WARNING:</b> Could not fetch chapter ${c.id}: ${e}`);
      continue;
    }
    if (!res.ok) {
      progress.add(`<b>WARNING:</b> Could not fetch chapter ${c.id} (HTTP ${res.status})`);
      continue;
    }
    const html = decryptChapterShell(await res.text());
    files.push({
      name: 'OEBPS/' + truncate(c.id),
      input: fixXhtml(
        idToMetaId.get(c.id) || c.id,
        src,
        html,
        imgAssets,
        cssRegistry[c.id] || [],
        bif.map.title.main
      ),
    });
    fetched += 1;
    const acc = document.querySelector('span#chapAcc');
    if (acc) acc.innerHTML = ` ${fetched}/${total}`;
  }

  // Assets download through a bounded worker queue so a burst of hundreds
  // of requests doesn't get throttled by the CDN.
  progress.add(`Downloading assets <span id="assetGath"> 0/${imgAssets.length} </span>`);
  let done = 0;
  const queue = imgAssets.slice();
  async function assetWorker(): Promise<void> {
    while (queue.length) {
      const name = queue.shift() as string;
      const url = name.startsWith('http') ? name : location.origin + '/' + name;
      try {
        const response = await fetchAssetWithRetry(url);
        const blob = await response.blob();
        files.push({
          name: 'OEBPS/' + (name.startsWith('http') ? getFilenameFromURL(name) : name),
          input: blob,
        });
      } catch (e) {
        progress.add(`<b>WARNING:</b> Could not fetch ${name} (${(e as Error).message})`);
      }
      done += 1;
      const span = document.querySelector('span#assetGath');
      if (span) span.innerHTML = ` ${done}/${imgAssets.length} `;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ASSET_CONCURRENCY, queue.length) }, assetWorker)
  );

  const bookMeta = {
    identifier: String(bif.map['-odread-buid'] ?? ''),
    title: bif.map.title.main,
    creatorName: bif.map.creator[0]?.name ?? '',
    language: bif.map.language?.[0],
    descriptionText: descriptionText(bif),
  };
  const spineComponents = components.map((c) => ({ meta: c.meta, index: c.index }));
  makePackage(files, imgAssets, spineComponents, bookMeta);
  makeToc(files, spineComponents, bookMeta.identifier, bookMeta.title);

  return files;
}

/** Build the EPUB and save it (streaming save with blob fallback). */
export async function downloadEbook(
  bif: BIF,
  progress: EbookProgress,
  getDownloadZip: ZipFactory
): Promise<void> {
  progress.add('<b>Starting EPUB download</b>');
  const files = await buildEbookFiles(bif, progress);

  progress.add('<br><b>Downloads complete!</b> Starting EPUB generation and download...');
  const filename = safeFilename(
    `${bif.map.creator[0]?.name ?? 'Unknown'} - ${bif.map.title.main}.epub`
  );

  const saveBlob = (blob: Blob): void => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  try {
    if ('showSaveFilePicker' in window) {
      const handle = await (window as unknown as {
        showSaveFilePicker(opts: unknown): Promise<{ createWritable(): Promise<WritableStream> }>;
      }).showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'EPUB book', accept: { 'application/epub+zip': ['.epub'] } }],
      });
      progress.add('Streaming EPUB file to disk...');
      const writable = await handle.createWritable();
      const zipBody = (await (await getDownloadZip())(files)).body;
      if (!zipBody) throw new Error('zip stream unavailable');
      await zipBody.pipeTo(writable);
      progress.add('Download complete!');
    } else {
      throw new Error('no File System Access API');
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      progress.add('Download cancelled by user.');
    } else {
      console.error('Streaming download failed:', err);
      progress.add('Streaming failed, using fallback...');
      progress.add('Using fallback download method...');
      const zipBlob = await (await (await getDownloadZip())(files)).blob();
      progress.add('Generated EPUB file!');
      saveBlob(zipBlob);
      progress.add('<br><b style="color: green;">✓ EPUB download complete!</b>');
    }
  }
  setTimeout(() => progress.clear(), 8000);
}
