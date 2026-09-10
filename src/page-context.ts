import { buildBookId3Tag, tagChapterMp3, chapterTitleFor } from './utils/id3.js';
import { parseMpegHeader, countMpegFrames, stripXingFrame, makeXingFrame } from './utils/mpeg.js';
import { gmFetchBlob, fetchWithRetry, fetchCover, safeFilename } from './utils/fetch.js';
import { getMetadata, getAuthorString, getNarratorString, createMetadata, type BIF } from './libby/bif.js';
import { getUrls } from './libby/urls.js';
import { createProxySaveHandle, pickSaveFile, requestSaveFromTopFrame, buildAudiobookSingleMp3, handleTopPickMessage, handleIframePickMessage } from './utils/download.js';
import { createAndDownloadMp3, exportChapters } from './libby/chapters.js';
import { getDownloadZip } from './zip/client-zip.js';

const LIBREGRAB_SAVE_REQUEST = 'LIBREGRAB_SAVE_REQUEST';
const LIBREGRAB_SAVE_RESULT = 'LIBREGRAB_SAVE_RESULT';
const LIBREGRAB_PICK_REQUEST = 'LIBREGRAB_PICK_REQUEST';
const LIBREGRAB_PICK_RESULT = 'LIBREGRAB_PICK_RESULT';
const LIBREGRAB_WRITE_CHUNK = 'LIBREGRAB_WRITE_CHUNK';
const LIBREGRAB_WRITE_ACK = 'LIBREGRAB_WRITE_ACK';
const LIBREGRAB_WRITE_CLOSE = 'LIBREGRAB_WRITE_CLOSE';
const LIBREGRAB_WRITE_CLOSE_ACK = 'LIBREGRAB_WRITE_CLOSE_ACK';
const LIBREGRAB_WRITE_SEEK = 'LIBREGRAB_WRITE_SEEK';
const LIBREGRAB_WRITE_SEEK_ACK = 'LIBREGRAB_WRITE_SEEK_ACK';

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

function viewChapters(): void {
  if (!chapterMenuElem || !BIF) return;
  if (firstChapClick) {
    firstChapClick = false;
    const urls = getUrls(BIF, odreadCmptParams);
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
      const urls = getUrls(BIF!, odreadCmptParams);
      await Promise.all(urls.map(async (url) => {
        const res = await fetch(url.url);
        const blob = await res.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${getAuthorString(BIF!)} - ${BIF!.map.title.main}.${url.index}.mp3`;
        link.click();
        URL.revokeObjectURL(link.href);
      }));
      if (dumpAllBtn) dumpAllBtn.style.display = '';
    };
  }
}

function buildPirateUi(bif: BIF): void {
  const CSS = `
.pNav{
    background-color: red;
    width: 100%;
    display: flex;
    justify-content: space-between;
}
.pLink{
    color: blue;
    text-decoration-line: underline;
    padding: .25em;
    font-size: 1em;
}
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
    <h2>This book contains {CHAPTERS} chapters.</h2>
    <button class="shibui-button" style="background-color: white" id="dumpAll"> Download all </button><br>
  `;

  const style = document.createElement('style');
  style.innerHTML = CSS;
  document.head.appendChild(style);

  const nav = document.createElement('div');
  nav.innerHTML = audioBookNav;
  nav.querySelector('#chap')!.onclick = viewChapters;
  nav.querySelector('#down')!.onclick = exportMP3;
  nav.querySelector('#exp')!.onclick = exportChaptersHandler;
  nav.classList.add('pNav');

  const pbar = document.querySelector('.nav-progress-bar');
  if (pbar) {
    pbar.insertBefore(nav, pbar.children[1]);
  }

  chapterMenuElem = document.createElement('div');
  chapterMenuElem.classList.add('foldMenu');
  chapterMenuElem.setAttribute('tabindex', '-1');
  const urls = getUrls(bif, odreadCmptParams);
  chapterMenuElem.innerHTML = chaptersMenu.replace('{CHAPTERS}', String(urls.length));
  document.body.appendChild(chapterMenuElem);

  downloadElem = document.createElement('div');
  downloadElem.classList.add('foldMenu');
  downloadElem.setAttribute('tabindex', '-1');
  document.body.appendChild(downloadElem);
}

function exportMP3(): void {
  if (downloadState !== -1) return;
  downloadState = 0;
  if (downloadElem) {
    downloadElem.classList.add('active');
    downloadElem.innerHTML = '<b>Starting MP3</b><br>';
  }
  createAndDownloadMp3(
    BIF!,
    odreadCmptParams,
    {
      add: (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; },
      clear: () => { if (downloadElem) downloadElem.innerHTML = ''; downloadElem?.classList.remove('active'); },
      setActive: (active) => { if (downloadElem && active) downloadElem.classList.add('active'); else downloadElem?.classList.remove('active'); },
      getElement: () => downloadElem!,
    } as any,
    pickSaveFile,
    buildAudiobookSingleMp3
  ).then(() => {
    downloadState = -1;
  });
}

function exportChaptersHandler(): void {
  if (downloadState !== -1) return;
  downloadState = 1;
  if (downloadElem) {
    downloadElem.classList.add('active');
    downloadElem.innerHTML = '<b>Starting ZIP export</b><br>';
  }

  exportChapters(
    BIF!,
    odreadCmptParams,
    {
      add: (msg) => { if (downloadElem) downloadElem.innerHTML += msg + '<br>'; },
      clear: () => { if (downloadElem) downloadElem.innerHTML = ''; downloadElem?.classList.remove('active'); },
      setActive: (active) => { if (downloadElem && active) downloadElem.classList.add('active'); else downloadElem?.classList.remove('active'); },
      getElement: () => downloadElem!,
    } as any,
    getDownloadZip
  ).then(() => {
    downloadState = -1;
  });
}

function buildPirateUiLocal(): void {
  if (!BIF || uiBuilt) return;
  buildPirateUi(BIF);
  uiBuilt = true;
  downloadElem = document.querySelector('.foldMenu:last-of-type') as HTMLDivElement;
  chapterMenuElem = document.querySelector('.foldMenu:first-of-type') as HTMLDivElement;
}

function pageWindow(): Window & typeof globalThis {
  return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
}

function pageContextMain(): void {
  console.log('[LibbyRip] mainCode running in page context', location.href);

  // Only run full logic in top frame (where UI is injected)
  // In iframe, only set up message handler for cross-frame downloads
  const isTopFrame = window.top === window.self;
  console.log('[LibbyRip] isTopFrame:', isTopFrame, 'hostname:', location.hostname);
  if (isTopFrame) {
    console.log('[LibbyRip] In top frame, setting up message handler only');
    window.addEventListener('message', (event) => {
      handleIframePickMessage(event);
    });
    return;
  }

  window.addEventListener('message', (event) => {
    handleTopPickMessage(event).catch((err) => console.error('LibreGRAB top-frame picker failed', err));
  });

  let intr = setInterval(() => {
    if ((window as any).BIF !== undefined && document.querySelector('.nav-progress-bar') !== null) {
      clearInterval(intr);
      BIF = (window as any).BIF;
      buildPirateUiLocal();
    }
  }, 25);

  if ((window as any).BIF !== undefined && (window as any).BIF?.map) {
    buildPirateUiLocal();
  } else {
    console.log('[LibbyRip] BIF not ready, waiting...');
    const checkBIF = setInterval(() => {
      if ((window as any).BIF !== undefined && (window as any).BIF?.map) {
        clearInterval(checkBIF);
        BIF = (window as any).BIF;
        buildPirateUiLocal();
      }
    }, 500);
  }
}

pageContextMain();