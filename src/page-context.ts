import { buildBookId3Tag, tagChapterMp3, chapterTitleFor } from './utils/id3.js';
import { parseMpegHeader, countMpegFrames, stripXingFrame, makeXingFrame } from './utils/mpeg.js';
import { gmFetchBlob, fetchWithRetry, fetchCover, safeFilename } from './utils/fetch.js';
import { getMetadata, getAuthorString, getNarratorString, createMetadata, type BIF } from './libby/bif.js';
import { getUrls } from './libby/urls.js';
import { pickSaveFile, requestSaveFromTopFrame, buildAudiobookSingleMp3, handleIframeDataMessage, requestFromIframe, setupIframeApi, setupIframeFetchHandler } from './utils/download.js';
import { createAndDownloadMp3, exportChapters } from './libby/chapters.js';
import { getDownloadZip } from './zip/client-zip.js';
import { openMp3Debug } from './ui/mp3-debug.js';
import { isEbookReader, wireEbookButton, makeEbookProgress } from './ui/ebook-ui.js';

const LIBREGRAB_SAVE_REQUEST = 'LIBREGRAB_SAVE_REQUEST';
const LIBREGRAB_SAVE_RESULT = 'LIBREGRAB_SAVE_RESULT';
const LIBREGRAB_PICK_REQUEST = 'LIBREGRAB_PICK_REQUEST';
const LIBREGRAB_PICK_RESULT = 'LIBREGRAB_PICK_RESULT';

function isPlayerOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'listen.libbyapp.com' || host.endsWith('.listen.libbyapp.com')
      || host === 'listen.overdrive.com' || host.endsWith('.listen.overdrive.com');
  } catch {
    return false;
  }
}

function saveBlobFromTopFrame(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.documentElement.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const isTopFrame = window.top === window.self;

if (isTopFrame) {
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!isPlayerOrigin(event.origin)) return;
    if (!data || data.type !== LIBREGRAB_SAVE_REQUEST) return;
    if (!(data.arrayBuffer instanceof ArrayBuffer)) return;
    const filename = String(data.filename || 'audiobook.mp3')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
      .slice(0, 180) || 'audiobook.mp3';
    saveBlobFromTopFrame(new Blob([data.arrayBuffer], { type: data.mimeType || 'application/octet-stream' }), filename);
    event.source.postMessage({
      type: LIBREGRAB_SAVE_RESULT,
      requestId: data.requestId,
      ok: true,
    }, event.origin);
  });
}

const oldParse = JSON.parse;
let odreadCmptParams: string[] | null = null;
JSON.parse = function (...args: unknown[]): unknown {
  const ret = oldParse.apply(this, args);
  if (typeof ret === 'object' && ret !== null && 'b' in ret && typeof ret.b === 'object' && ret.b !== null && '-odread-cmpt-params' in ret.b) {
    odreadCmptParams = Array.from((ret.b as Record<string, unknown>)['-odread-cmpt-params'] as Iterable<string>);
  }
  return ret;
}

// Player URL capture (fix5): OverDrive no longer ships usable chapter params
// (-odread-cmpt-params arrives as an empty array), so the script's own
// chapter URLs end in "?undefined" and the origin 502s them. The player
// itself requests each part with a valid cmpt param; record those URLs as
// the player sets them on its audio elements, keyed by part file.
const capturedMediaUrls = new Map<string, string>();

function partFileFromUrl(url: string): string {
  const noQuery = url.split('?')[0].split('#')[0];
  return noQuery.slice(noQuery.lastIndexOf('/') + 1);
}

function captureStatusText(): string {
  let total = 0;
  try {
    const comps = (BIF as any)?.objects?.spool?.components;
    total = Array.isArray(comps) ? comps.length : 0;
  } catch (e) { /* ignore */ }
  return 'Player URLs: ' + capturedMediaUrls.size + (total ? '/' + total : '') + ' captured';
}

function updateCaptureStatus(): void {
  const el = document.querySelector('.libregrab-capture-status');
  if (el) el.textContent = captureStatusText();
}

function recordPlayerMediaUrl(url: string): void {
  try {
    if (typeof url !== 'string' || url.indexOf('.mp3') === -1) return;
    const part = partFileFromUrl(url);
    if (!part) return;
    const isNew = !capturedMediaUrls.has(part);
    capturedMediaUrls.set(part, url);
    if (isNew) {
      updateCaptureStatus();
      console.log('[LibbyRip] Captured player URL for ' + part + (url.indexOf('cmpt=') !== -1 ? ' (cmpt present)' : ' (no cmpt)'));
    }
  } catch (e) { /* capture must never break playback */ }
}

function mergePerformanceMediaUrls(): void {
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (const entry of entries) {
      if (entry.initiatorType === 'audio' || entry.initiatorType === 'media') {
        recordPlayerMediaUrl(entry.name);
      }
    }
  } catch (e) { /* ignore */ }
}

function installPlayerUrlCapture(): void {
  try {
    const proto = (HTMLMediaElement as any).prototype || (HTMLAudioElement as any).prototype;
    if (!proto) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
    if (descriptor && typeof descriptor.set === 'function') {
      const originalSet = descriptor.set;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value: string) {
          recordPlayerMediaUrl(String(value));
          return originalSet.call(this, value);
        },
      });
    }
    const origSetAttribute = proto.setAttribute;
    if (typeof origSetAttribute === 'function') {
      proto.setAttribute = function (name: string, value: string) {
        if (String(name).toLowerCase() === 'src') recordPlayerMediaUrl(String(value));
        return origSetAttribute.call(this, name, value);
      };
    }
    console.log('[LibbyRip] Player URL capture installed');
  } catch (e) {
    console.log('[LibbyRip] Player URL capture unavailable, performance entries only');
  }
}

installPlayerUrlCapture();

let downloadElem: HTMLDivElement | null = null;
let BIF: BIF | null = null;
let firstChapClick = true;
let chapterMenuElem: HTMLDivElement | null = null;
let downloadState = -1;
let uiBuilt = false;

async function viewChapters(): Promise<void> {
  if (!chapterMenuElem) return;
  if (firstChapClick) {
    firstChapClick = false;
    try {
      const { urls } = await requestFromIframe<{ urls: any[] }>('LIBREGRAB_GET_URLS');
      const countEl = document.getElementById('libregrab-chapter-count');
      if (countEl) countEl.textContent = String(urls.length);
      for (const url of urls) {
        const span = document.createElement('span');
        span.classList.add('pChapLabel');
        span.textContent = `#${1 + url.index}`;

        const audio = document.createElement('audio');
        audio.setAttribute('controls', '');
        const source = document.createElement('source');
        source.setAttribute('src', url.url);
        source.setAttribute('type', url.type);
        audio.appendChild(source);

        chapterMenuElem!.appendChild(span);
        chapterMenuElem!.appendChild(document.createElement('br'));
        chapterMenuElem!.appendChild(audio);
        chapterMenuElem!.appendChild(document.createElement('br'));
      }
    } catch (e) {
      console.error('[LibbyRip] Failed to load chapters:', e);
    }
  }
  if (chapterMenuElem.classList.contains('active')) {
    chapterMenuElem.classList.remove('active');
  } else {
    chapterMenuElem.classList.add('active');
  }
  const dumpAllBtn = chapterMenuElem.querySelector('#dumpAll');
  if (dumpAllBtn) {
    dumpAllBtn.onclick = async () => {
      if (dumpAllBtn) dumpAllBtn.style.display = 'none';
      try {
        const { urls } = await requestFromIframe<{ urls: any[] }>('LIBREGRAB_GET_URLS');
        await Promise.all(urls.map(async (url) => {
          const res = await fetch(url.url);
          const blob = await res.blob();
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = `${getAuthorString(BIF!) || 'Author'} - ${BIF?.map.title.main || 'Title'}.${url.index}.mp3`;
          link.click();
          URL.revokeObjectURL(link.href);
        }));
      } catch (e) {
        console.error('[LibbyRip] Failed to download all:', e);
      }
      if (dumpAllBtn) dumpAllBtn.style.display = '';
    };
  }
}

function buildPirateUi(bif: BIF): void {
  // Don't show audiobook buttons on ebook readers (they get the EPUB button instead)
  if (isEbookReader()) {
    console.log('[LibbyRip] Ebook reader detected, skipping audiobook UI');
    return;
  }
  // Don't build twice (startup build + local-BIF poll both firing).
  if (document.querySelector('.libregrab-ui')) {
    console.log('[LibbyRip] UI already present, skipping rebuild');
    return;
  }
  const CSS = `
.libregrab-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: libregrab-spin 0.8s linear infinite;
  margin-right: 6px;
  vertical-align: middle;
}
@keyframes libregrab-spin { to { transform: rotate(360deg); } }
.libregrab-btn.debug { background: #ff9500; }
.libregrab-btn.debug:hover { background: #e68600; }
.libregrab-debug-modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    z-index: 2147483648;
    display: none;
    align-items: center;
    justify-content: center;
}
.libregrab-debug-modal.active { display: flex; }
.libregrab-debug-content {
    background: #fff;
    color: #333;
    padding: 24px;
    border-radius: 8px;
    width: 90%;
    max-width: 1000px;
    max-height: 90%;
    overflow-y: auto;
    font-family: system-ui, -apple-system, sans-serif;
}
.libregrab-debug-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    border-bottom: 2px solid #ddd;
    padding-bottom: 12px;
}
.libregrab-debug-header h2 {
    margin: 0;
    font-size: 24px;
}
.libregrab-debug-close {
    background: #dc3545;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 8px 16px;
    cursor: pointer;
    font-size: 14px;
}
.libregrab-debug-section { margin-bottom: 20px; }
.libregrab-debug-table { border-collapse: collapse; width: 100%; }
.libregrab-debug-table th, .libregrab-debug-table td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
.libregrab-debug-table th { background: #f0f0f0; }
.libregrab-debug-match { color: #28a745; font-weight: bold; }
.libregrab-debug-diff { color: #dc3545; font-weight: bold; }
.libregrab-debug-missing { color: #888; font-style: italic; }
.libregrab-debug-actions { margin-top: 16px; }
.libregrab-ui {
    position: fixed;
    top: 60px;
    right: 16px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: sans-serif;
}
.libregrab-btn {
    background: #0066cc;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 10px 16px;
    font-size: 14px;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.libregrab-btn:hover { background: #0052a3; }
.libregrab-btn:disabled { background: #999; cursor: not-allowed; }
.libregrab-btn.zip { background: #28a745; }
.libregrab-btn.zip:hover { background: #1e7e34; }
.libregrab-panel {
    position: fixed;
    top: 120px;
    right: 16px;
    z-index: 2147483647;
    width: 360px;
    max-height: 400px;
    background: #1e1e1e;
    color: #eee;
    font-family: monospace;
    font-size: 12px;
    border-radius: 4px;
    display: none;
    flex-direction: column;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    overflow: hidden;
}
.libregrab-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #2a2a2a;
    border-bottom: 1px solid #444;
}
.libregrab-panel-title { font-weight: bold; color: #ccc; }
.libregrab-panel-close { cursor: pointer; color: #aaa; font-size: 16px; }
.libregrab-panel-close:hover { color: #fff; }
.libregrab-panel-body { flex: 1; overflow-y: auto; padding: 10px; }
.libregrab-line { margin-bottom: 4px; white-space: pre-wrap; word-break: break-word; }
.foldMenu{
    position: absolute;
    width: 100%;
    height: 0%;
    z-index: 1000;
    background-color: grey;
    color: white;
    overflow-x: hidden;
    overflow-y: scroll;
    transition: height 0.3s
}
.active{
    height: 40%;
    border: double;
}
.pChapLabel{
    font-size: 2em;
}`;

  const audioBookNav = `
    <a class="pLink" id="chap"> <h1> View chapters </h1> </a>
    <a class="pLink" id="down"> <h1> Export as MP3 </h1> </a>
    <a class="pLink" id="exp"> <h1> Export audiobook </h1> </a>
  `;

  const chaptersMenu = `
    <h2>This book contains <span id="libregrab-chapter-count">loading...</span> chapters.</h2>
    <button class="shibui-button" style="background-color: white" id="dumpAll"> Download all </button><br>
  `;

  // Don't pile up identical <style> tags across watchdog rebuilds.
  const hasStyle = Array.from(document.querySelectorAll('style')).some((s) => (s.textContent || '').includes('.libregrab-ui'));
  if (!hasStyle) {
    const style = document.createElement('style');
    style.innerHTML = CSS;
    document.head.appendChild(style);
  }

  // Modern fixed-position UI (doesn't need anchor element). Positioning and
  // button styles are inline: OverDrive does not reliably apply the injected
  // <style> block (Oct 2026: computed position stayed static, buttons hid
  // behind the header). Values copied from the working merged build.
  const ui = document.createElement('div');
  ui.className = 'libregrab-ui';
  ui.style.cssText = 'position: fixed; top: 60px; right: 16px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; font-family: sans-serif;';
  ui.innerHTML = `
    <button class="libregrab-btn" id="libregrab-btn-mp3" style="background: #0066cc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;">Export as MP3</button>
    <button class="libregrab-btn zip" id="libregrab-btn-zip" style="background: #28a745; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;">Export as ZIP</button>
    <button class="libregrab-btn" id="libregrab-btn-chapters" style="background: #0066cc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;">View Chapters</button>
    <button class="libregrab-btn debug" id="libregrab-btn-debug" style="background: #ff9500; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;">Mp3 Debug</button>
  `;
  document.body.appendChild(ui);

  ui.querySelector('#libregrab-btn-mp3')!.onclick = exportMP3;
  ui.querySelector('#libregrab-btn-zip')!.onclick = exportChaptersHandler;
  ui.querySelector('#libregrab-btn-chapters')!.onclick = viewChapters;
  ui.querySelector<HTMLButtonElement>('#libregrab-btn-debug')!.onclick = () => openMp3Debug(getBookData);

  // Player-URL capture status (fix5): how many part URLs the player has
  // exposed so far. Only meaningful once BIF/spool exist (OverDrive).
  if ((BIF as any)?.objects?.spool?.components?.length) {
    mergePerformanceMediaUrls();
    const captureStatus = document.createElement('div');
    captureStatus.className = 'libregrab-capture-status';
    captureStatus.style.cssText = 'color: #eee; background: rgba(0,0,0,0.55); padding: 4px 8px; border-radius: 4px; font-size: 12px; text-align: center;';
    ui.appendChild(captureStatus);
    updateCaptureStatus();
  }

  // Progress panel (positioning inline, same reason as the UI above).
  const panel = document.createElement('div');
  panel.className = 'libregrab-panel';
  panel.style.cssText = 'position: fixed; top: 120px; right: 16px; z-index: 2147483647; width: 360px; max-height: 400px; background: #1e1e1e; color: #eee; font-family: monospace; font-size: 12px; border-radius: 4px; display: none; flex-direction: column; box-shadow: 0 4px 16px rgba(0,0,0,0.5); overflow: hidden;';
  panel.innerHTML = `
    <div class="libregrab-panel-header">
      <span class="libregrab-panel-title">LibreGRAB</span>
      <span class="libregrab-panel-close" id="libregrab-panel-close">✕</span>
    </div>
    <div class="libregrab-panel-body" id="libregrab-panel-body"></div>
  `;
  document.body.appendChild(panel);

  panel.querySelector('#libregrab-panel-close')!.onclick = () => {
    panel.style.display = 'none';
  };

  downloadElem = panel.querySelector('#libregrab-panel-body') as HTMLDivElement;

  // Legacy chapter menu (kept for compatibility)
  chapterMenuElem = document.createElement('div');
  chapterMenuElem.classList.add('foldMenu');
  chapterMenuElem.setAttribute('tabindex', '-1');
  chapterMenuElem.innerHTML = chaptersMenu;
  document.body.appendChild(chapterMenuElem);
}

async function getBookData(): Promise<{ urls: any[]; metadata: any; author: string; narrator: string }> {
  // Frameless path: on OverDrive the reader has no iframe, BIF lives in the
  // top frame (found by the local-BIF poll in pageContextMain). Use it
  // directly instead of messaging an iframe that does not exist.
  if (BIF && BIF.map) {
    console.log('[LibbyRip] Using local BIF (OverDrive)');
    // Fix5: prefer URLs the player itself requested (valid cmpt param).
    // getUrls builds "?undefined" URLs now that -odread-cmpt-params is empty.
    mergePerformanceMediaUrls();
    const rawUrls = getUrls(BIF, odreadCmptParams);
    const urls = rawUrls.map((u: any) => {
      const captured = capturedMediaUrls.get(partFileFromUrl(u.url));
      return captured ? { ...u, url: captured } : u;
    });
    return {
      urls,
      metadata: getMetadata(BIF),
      author: getAuthorString(BIF),
      narrator: getNarratorString(BIF),
    };
  }
  if (!document.querySelector('iframe[src*="listen.libbyapp.com"]')) {
    throw new Error('Audiobook player iframe not found. Please open the audiobook player first.');
  }
  const { urls, metadata } = await requestFromIframe<{ urls: any[]; metadata: any }>('LIBREGRAB_GET_URLS');
  const { author, narrator } = await requestFromIframe<{ author: string; narrator: string }>('LIBREGRAB_GET_CREATORS');
  return { urls, metadata, author, narrator };
}

async function exportMP3(): Promise<void> {
  if (downloadState !== -1) return;
  downloadState = 0;
  const mp3Button = document.querySelector<HTMLButtonElement>('#libregrab-btn-mp3');
  const mp3ButtonHtml = mp3Button?.innerHTML ?? '';
  if (mp3Button) {
    mp3Button.disabled = true;
    mp3Button.innerHTML = '<span class="libregrab-spinner"></span> Exporting...';
  }
  if (downloadElem) {
    downloadElem.classList.add('active');
    setPanelVisible(true);
    downloadElem.innerHTML = '<b>Starting MP3...</b><br>';
  }

  try {
    const { urls, metadata, author, narrator } = await getBookData();
    const { bytes, mime } = await fetchCover(metadata.coverUrl!, (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; });

    // Group URLs by unique spine index (some audiobooks have multiple parts per chapter)
    const uniqueUrls = Object.values(
      urls.reduce((acc: Record<number, any>, u: any) => {
        if (!acc[u.index] || u.duration > acc[u.index].duration) {
          acc[u.index] = u;
        }
        return acc;
      }, {})
    );

    // Create chapters array from unique spine positions; titles come
    // from the BIF chapter list (spine position, falling back to the
    // previous entry), else a generic title.
    const bifChapters = metadata.chapters || [];
    const chaptersForId3 = uniqueUrls.map((u: any) => {
      const chapterNumber = u.index + 1;
      const chapterMeta = bifChapters[u.index] || bifChapters[chapterNumber - 1];
      return {
        chapter_number: chapterNumber,
        title: chapterMeta?.title || `Chapter ${chapterNumber}`,
      };
    });

    // Fix5: fail fast when any part the export would fetch lacks the
    // player's cmpt param (OverDrive 502s param-less chapter fetches).
    // Libby's iframe path is unaffected (BIF is null in the top frame).
    if (BIF && BIF.map) {
      const missing = uniqueUrls.filter((u: any) => u.url.indexOf('cmpt=') === -1).map((u: any) => partFileFromUrl(u.url));
      const uniqueMissing = missing.filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
      if (uniqueMissing.length > 0) {
        throw new Error('No player URL captured for ' + uniqueMissing.length + ' part(s): ' + uniqueMissing.join(', ') + '. Play or seek through those parts in the player first, then export again.');
      }
    }

    // Create durationByChapter keyed by chapter_number (1-indexed)
    // Sum durations for any multi-part chapters
    const durationByChapter = uniqueUrls.reduce((acc: Record<number, number>, u: any) => {
      const chNum = u.index + 1;
      acc[chNum] = (acc[chNum] || 0) + u.duration * 1000;
      return acc;
    }, {});

    const filename = author + ' - ' + metadata.title + '.mp3';
    const handle = await pickSaveFile(filename, [{
      description: 'MP3 Audio',
      accept: { 'audio/mpeg': ['.mp3'] },
    }]);

    const fallbackBif = { map: { title: { main: metadata.title }, creator: [], description: metadata.description } };
    await buildAudiobookSingleMp3({
      urls: uniqueUrls, // Use deduplicated URLs
      metadata: {
        ...metadata,
        description: metadata.description || 'Audiobook exported by LibreGRAB.',
        chapters: chaptersForId3,
      },
      coverBytes: bytes,
      coverMime: mime,
      fileHandle: handle,
      progress: (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; },
      fetchWithRetry,
      BIF: (BIF && BIF.map) ? BIF : fallbackBif,
      getAuthorString: () => author,
      getNarratorString: () => narrator,
      durationByChapter,
    });

    if (downloadElem) {
      downloadElem.innerHTML += '<br><b style="color: green;">✓ MP3 download complete!</b><br>';
      setTimeout(() => {
        if (downloadElem) {
          downloadElem.innerHTML = '';
          downloadElem.classList.remove('active');
          setPanelVisible(false);
        }
      }, 8000);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      if (downloadElem) downloadElem.innerHTML += 'Download cancelled by user.<br>';
    } else {
      console.error('MP3 export failed:', err);
      if (downloadElem) downloadElem.innerHTML += `<b>Error:</b> ${(err as Error).message}<br>`;
    }
  } finally {
    downloadState = -1;
    if (mp3Button) {
      mp3Button.disabled = false;
      mp3Button.innerHTML = mp3ButtonHtml;
    }
  }
}

async function exportChaptersHandler(): Promise<void> {
  if (downloadState !== -1) return;
  downloadState = 1;
  const zipButton = document.querySelector<HTMLButtonElement>('#libregrab-btn-zip');
  const zipButtonHtml = zipButton?.innerHTML ?? '';
  if (zipButton) {
    zipButton.disabled = true;
    zipButton.innerHTML = '<span class="libregrab-spinner"></span> Exporting...';
  }
  if (downloadElem) {
    downloadElem.classList.add('active');
    setPanelVisible(true);
    downloadElem.innerHTML = '<b>Starting ZIP export...</b><br>';
  }

  try {
    const { urls, metadata, author, narrator } = await getBookData();
    // Fix5: same fail-fast as exportMP3 (see there); ZIP fetches every URL.
    if (BIF && BIF.map) {
      const missing = urls.filter((u: any) => u.url.indexOf('cmpt=') === -1).map((u: any) => partFileFromUrl(u.url));
      const uniqueMissing = missing.filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
      if (uniqueMissing.length > 0) {
        throw new Error('No player URL captured for ' + uniqueMissing.length + ' part(s): ' + uniqueMissing.join(', ') + '. Play or seek through those parts in the player first, then export again.');
      }
    }
    const { bytes: coverBytes } = await fetchCover(metadata.coverUrl!, (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; });

    const totalLogicalChapters = metadata.chapters ? metadata.chapters.length : urls.length;
    const results: Array<{ ok: boolean; chapterNumber: number; filename?: string; blob?: Blob; error?: string }> = new Array(urls.length);
    let idx = 0;
    const CONCURRENCY = 6;
    const totalBytes = { done: 0 };

    async function worker(): Promise<void> {
      while (true) {
        const i = idx++;
        if (i >= urls.length) break;
        const url = urls[i];
        const label = `chapter ${url.index}`;
        try {
          const res = await fetchWithRetry(url.url, { method: 'GET' }, label, (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; });
          const arrayBuffer = await res.arrayBuffer();
          totalBytes.done += arrayBuffer.byteLength;

          const taggedBlob = tagChapterMp3(arrayBuffer, {
            book: metadata,
            displayTitle: metadata.title,
            author,
            narrator,
            seriesName: metadata.series || null,
            seriesIndex: null,
            chapterNumber: url.index,
            totalChapters: totalLogicalChapters,
            durationMs: url.duration * 1000,
            coverBytes,
            coverMime: coverBytes ? 'image/jpeg' : null,
            progress: (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; },
          });

          const num = String(url.index).padStart(2, '0');
          results[i] = { ok: true, chapterNumber: url.index, filename: `${num} - Chapter ${url.index}.mp3`, blob: taggedBlob };
          if (downloadElem) downloadElem.innerHTML += `Fetched + tagged ${i + 1}/${urls.length} (${label}, ${(totalBytes.done / 1e6).toFixed(1)} MB so far)<br>`;
        } catch (e) {
          results[i] = { ok: false, chapterNumber: url.index, error: (e as Error).message };
          if (downloadElem) downloadElem.innerHTML += `FAILED: ${label} - ${(e as Error).message}<br>`;
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      const failedList = failed.map((f) => `chapter ${f.chapterNumber} (${f.error})`).join(', ');
      if (downloadElem) downloadElem.innerHTML += `<b>Aborted: ${failed.length}/${urls.length} chapter(s) failed: ${failedList}</b><br>`;
      return;
    }

    if (downloadElem) downloadElem.innerHTML += `All ${urls.length} chapters downloaded successfully (${(totalBytes.done / 1e6).toFixed(1)} MB total).<br>`;
    if (downloadElem) downloadElem.innerHTML += 'Assembling zip...<br>';

    const makeZip = await getDownloadZip();
    if (typeof makeZip !== 'function') throw new Error('client-zip failed to load.');

    const files: Array<{ name: string; input: Blob | Uint8Array | string }> = [];
    if (coverBytes) {
      files.push({ name: 'cover.jpg', input: coverBytes });
    }
    results.forEach((r) => {
      if (r.ok && r.filename && r.blob) files.push({ name: r.filename, input: r.blob });
    });

    if (downloadElem) downloadElem.innerHTML += `Zipping ${files.length} files...<br>`;

    const zipBlob = await makeZip(files).blob();
    const outputFilename = safeFilename(author + ' - ' + metadata.title) + '.zip';

    if (downloadElem) downloadElem.innerHTML += 'Sending ZIP to the top-level download handler…<br>';
    try {
      await requestSaveFromTopFrame(zipBlob, outputFilename, 'application/zip');
      if (downloadElem) downloadElem.innerHTML += '<br><b style="color: green;">✓ ZIP download complete!</b><br>';
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        if (downloadElem) downloadElem.innerHTML += 'Download cancelled by user.<br>';
      } else {
        console.error('Top-level save failed', error);
        if (downloadElem) downloadElem.innerHTML += `<b>Save failed:</b> ${String((error as Error).message ?? error)}<br>`;
      }
    }
  } catch (err) {
    console.error('ZIP export failed:', err);
    if (downloadElem) downloadElem.innerHTML += `<b>Error:</b> ${(err as Error).message}<br>`;
  } finally {
    downloadState = -1;
    const zipButtonNow = document.querySelector<HTMLButtonElement>('#libregrab-btn-zip');
    if (zipButtonNow) {
      zipButtonNow.disabled = false;
      zipButtonNow.innerHTML = zipButtonHtml;
    }
    setTimeout(() => {
      if (downloadElem) {
        downloadElem.innerHTML = '';
        downloadElem.classList.remove('active');
        setPanelVisible(false);
      }
    }, 8000);
  }
}

// The progress panel is display:none by default, and the MP3/ZIP handlers
// write into its body — so show it when an export starts and hide it when
// the 8s auto-clear runs. (The panel close button hides it the same way.)
function setPanelVisible(visible: boolean): void {
  const parent = downloadElem?.parentElement;
  if (parent) parent.style.display = visible ? 'flex' : 'none';
}

function buildPirateUiLocal(): void {
  if (uiBuilt) return;
  console.log('[LibbyRip] buildPirateUiLocal called');
  try {
    buildPirateUi(BIF);
    uiBuilt = true;
    console.log('[LibbyRip] buildPirateUi succeeded');
  } catch (e) {
    console.error('[LibbyRip] buildPirateUi failed:', e);
  }
}

function pageWindow(): Window & typeof globalThis {
  return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
}

function pageContextMain(): void {
  console.log('[LibbyRip] mainCode running in page context', location.href);

  const isTopFrame = window.top === window.self;
  console.log('[LibbyRip] isTopFrame:', isTopFrame, 'hostname:', location.hostname);
  console.log('[LibbyRip] window.BIF:', !!(window as any).BIF, 'map:', !!(window as any).BIF?.map);
  console.log('[LibbyRip] unsafeWindow.BIF:', !!(typeof unsafeWindow !== 'undefined' && (unsafeWindow as any).BIF), 'map:', !!(typeof unsafeWindow !== 'undefined' && (unsafeWindow as any).BIF?.map));
  console.log('[LibbyRip] hasNavBar:', !!document.querySelector('.nav-progress-bar'));

  if (!isTopFrame) {
    console.log('[LibbyRip] In iframe, setting up API exposure only');
    let bif = (window as any).BIF || (typeof unsafeWindow !== 'undefined' && (unsafeWindow as any).BIF);
    if (bif !== undefined && bif?.map) {
      BIF = bif;
      console.log('[LibbyRip] iframe: BIF ready immediately');
      setupIframeApi(
        BIF,
        odreadCmptParams,
        getUrls,
        getMetadata,
        getAuthorString,
        getNarratorString
      );
      setupIframeFetchHandler(fetchWithRetry);
    } else {
      console.log('[LibbyRip] BIF not ready in iframe, waiting...');
      const checkBIF = setInterval(() => {
        const bif = (window as any).BIF || (typeof unsafeWindow !== 'undefined' && (unsafeWindow as any).BIF);
        if (bif !== undefined && bif?.map) {
          clearInterval(checkBIF);
          BIF = bif;
          console.log('[LibbyRip] iframe: BIF found after wait');
          setupIframeApi(
            BIF,
            odreadCmptParams,
            getUrls,
            getMetadata,
            getAuthorString,
            getNarratorString
          );
          setupIframeFetchHandler(fetchWithRetry);
        }
      }, 500);
    }
    return;
  }

  // TOP FRAME: check for a local BIF first (OverDrive's reader has no iframe;
  // BIF lives in the top frame). BIF may not be ready at document-start, so
  // poll; the interval self-clears on success or after 30s.
  const checkLocalBIF = setInterval(() => {
    const localBif = (window as any).BIF || (pageWindow() as any).BIF;
    if (localBif !== undefined && localBif?.map) {
      clearInterval(checkLocalBIF);
      console.log('[LibbyRip] Top frame: local BIF found (no-iframe reader, e.g. Overdrive)');
      BIF = localBif;
      wireEbookButton(localBif, { getDownloadZip, makeProgress: makeEbookProgress });
      setupIframeApi(
        localBif,
        odreadCmptParams,
        getUrls,
        getMetadata,
        getAuthorString,
        getNarratorString
      );
      setupIframeFetchHandler(fetchWithRetry);
      // Build the UI now if the startup build could not run (e.g.
      // document.body did not exist yet at document-start). buildPirateUiLocal
      // is guarded by uiBuilt and buildPirateUi dedups on .libregrab-ui, so
      // this is a no-op when the startup build already succeeded.
      buildPirateUiLocal();
      console.log('[LibbyRip] Top frame (local BIF): BIF now available for exports');
    }
  }, 500);
  setTimeout(() => clearInterval(checkLocalBIF), 30000);

  // TOP FRAME (Libby): no BIF here, it's in the iframe
  window.addEventListener('message', (event) => {
    handleIframeDataMessage(event);
  });

  console.log('[LibbyRip] Top frame: no local BIF, will request from iframe');

  // Build UI immediately - no nav-progress-bar needed
  console.log('[LibbyRip] Top frame: building UI immediately, BIF=', !!BIF, 'uiBuilt=', uiBuilt);
  try {
    buildPirateUiLocal();
    console.log('[LibbyRip] Top frame: buildPirateUiLocal returned, uiBuilt=', uiBuilt);
  } catch (e) {
    console.error('[LibbyRip] Top frame build error:', e);
  }

  // Watchdog: the reader app wipes the UI after boot (buttons appear
  // briefly, then vanish; the <style> tag in <head> survives). Rebuild
  // whenever the container is missing. buildPirateUiLocal is guarded by
  // uiBuilt and buildPirateUi dedups on .libregrab-ui, so this is a no-op
  // while the UI is present, and rebuilds refresh the stale panel handle.
  if (!isEbookReader()) {
    setInterval(() => {
      if (!document.body) return;
      if (!document.querySelector('.libregrab-ui')) {
        console.log('[LibbyRip] UI watchdog: UI missing, rebuilding');
        uiBuilt = false;
        buildPirateUiLocal();
      }
    }, 2000);
  }
}

pageContextMain();