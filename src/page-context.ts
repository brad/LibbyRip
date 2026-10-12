import { buildBookId3Tag, tagChapterMp3, chapterTitleFor } from './utils/id3.js';
import { parseMpegHeader, countMpegFrames, stripXingFrame, makeXingFrame } from './utils/mpeg.js';
import { gmFetchBlob, fetchWithRetry, fetchCover, safeFilename } from './utils/fetch.js';
import { getMetadata, getAuthorString, getNarratorString, createMetadata, type BIF } from './libby/bif.js';
import { getUrls } from './libby/urls.js';
import { pickSaveFile, requestSaveFromTopFrame, buildAudiobookSingleMp3, handleIframeDataMessage, requestFromIframe, setupIframeApi, setupIframeFetchHandler } from './utils/download.js';
import { createAndDownloadMp3, exportChapters } from './libby/chapters.js';
import { getDownloadZip } from './zip/client-zip.js';

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
  const CSS = `
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

  const style = document.createElement('style');
  style.innerHTML = CSS;
  document.head.appendChild(style);

  // Modern fixed-position UI (doesn't need anchor element)
  const ui = document.createElement('div');
  ui.className = 'libregrab-ui';
  ui.innerHTML = `
    <button class="libregrab-btn" id="libregrab-btn-mp3">Export as MP3</button>
    <button class="libregrab-btn zip" id="libregrab-btn-zip">Export as ZIP</button>
    <button class="libregrab-btn" id="libregrab-btn-chapters">View Chapters</button>
  `;
  document.body.appendChild(ui);

  ui.querySelector('#libregrab-btn-mp3')!.onclick = exportMP3;
  ui.querySelector('#libregrab-btn-zip')!.onclick = exportChaptersHandler;
  ui.querySelector('#libregrab-btn-chapters')!.onclick = viewChapters;

  // Progress panel
  const panel = document.createElement('div');
  panel.className = 'libregrab-panel';
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

async function exportMP3(): Promise<void> {
  if (downloadState !== -1) return;
  downloadState = 0;
  if (downloadElem) {
    downloadElem.classList.add('active');
    downloadElem.innerHTML = '<b>Starting MP3...</b><br>';
  }

  try {
    const iframe = document.querySelector('iframe[src*="listen.libbyapp.com"]') as HTMLIFrameElement | null;
    if (!iframe) throw new Error('Audiobook player iframe not found. Please open the audiobook player first.');

    const { urls, metadata } = await requestFromIframe<{ urls: any[]; metadata: any }>('LIBREGRAB_GET_URLS');
    const { bytes, mime } = await fetchCover(metadata.coverUrl!, (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; });

    // Get author/narrator from iframe
    const { author, narrator } = await requestFromIframe<{ author: string; narrator: string }>('LIBREGRAB_GET_CREATORS');

    // Group URLs by unique spine index (some audiobooks have multiple parts per chapter)
    const uniqueUrls = Object.values(
      urls.reduce((acc: Record<number, any>, u: any) => {
        if (!acc[u.index] || u.duration > acc[u.index].duration) {
          acc[u.index] = u;
        }
        return acc;
      }, {})
    );

    // Create chapters array from unique spine positions
    const chaptersForId3 = uniqueUrls.map((u: any) => ({
      chapter_number: u.index + 1,
      title: `Chapter ${u.index + 1}`,
    }));

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

    await buildAudiobookSingleMp3({
      urls: uniqueUrls, // Use deduplicated URLs
      metadata: {
        ...metadata,
        chapters: chaptersForId3,
      },
      coverBytes: bytes,
      coverMime: mime,
      fileHandle: handle,
      progress: (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; },
      fetchWithRetry,
      BIF: { map: { title: { main: metadata.title }, creator: [] } },
      getAuthorString: () => author,
      getNarratorString: () => narrator,
      durationByChapter,
    });

    if (downloadElem) {
      downloadElem.innerHTML = '';
      downloadElem.classList.remove('active');
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
  }
}

async function exportChaptersHandler(): Promise<void> {
  if (downloadState !== -1) return;
  downloadState = 1;
  if (downloadElem) {
    downloadElem.classList.add('active');
    downloadElem.innerHTML = '<b>Starting ZIP export...</b><br>';
  }

  try {
    const iframe = document.querySelector('iframe[src*="listen.libbyapp.com"]') as HTMLIFrameElement | null;
    if (!iframe) throw new Error('Audiobook player iframe not found. Please open the audiobook player first.');

    const { urls, metadata } = await requestFromIframe<{ urls: any[]; metadata: any }>('LIBREGRAB_GET_URLS');
    const { coverBytes } = await fetchCover(metadata.coverUrl!, (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; });
    const { author, narrator } = await requestFromIframe<{ author: string; narrator: string }>('LIBREGRAB_GET_CREATORS');

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
      if (downloadElem) downloadElem.innerHTML += '<b>Download complete!</b><br>';
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
    if (downloadElem) {
      downloadElem.innerHTML = '';
      downloadElem.classList.remove('active');
    }
  }
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

  // TOP FRAME: no BIF here, it's in the iframe
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
}

pageContextMain();