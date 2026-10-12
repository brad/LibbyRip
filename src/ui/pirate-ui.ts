import type { BIF } from '../libby/bif.js';
import type { URLInfo } from '../types.js';
import { getUrls } from '../libby/urls.js';
import { CSS, audioBookNav, chaptersMenu } from './styles.js';
import { ProgressDisplay } from './progress.js';
import { createAndDownloadMp3 } from '../libby/chapters.js';
import { exportChapters } from '../libby/chapters.js';
import { buildAudiobookSingleMp3 } from '../utils/download.js';
import { fetchWithRetry } from '../utils/fetch.js';
import { pickSaveFile } from '../utils/download.js';

let chapterMenuElem: HTMLDivElement | null = null;
let downloadElem: HTMLDivElement | null = null;
let downloadProgress: ProgressDisplay | null = null;
let chapterProgress: ProgressDisplay | null = null;
let firstChapClick = true;

export function buildPirateUi(BIF: BIF): void {
  const style = document.createElement('style');
  style.innerHTML = CSS;
  document.head.appendChild(style);

  const nav = document.createElement('div');
  nav.innerHTML = audioBookNav;
  nav.querySelector('#chap')!.onclick = () => viewChapters(BIF);
  nav.querySelector('#down')!.onclick = () => exportMP3(BIF);
  nav.querySelector('#exp')!.onclick = () => exportChaptersHandler(BIF);
  nav.classList.add('pNav');

  const pbar = document.querySelector('.nav-progress-bar');
  if (pbar) {
    pbar.insertBefore(nav, pbar.children[1]);
  }

  chapterMenuElem = document.createElement('div');
  chapterMenuElem.classList.add('foldMenu');
  chapterMenuElem.setAttribute('tabindex', '-1');
  const urls = getUrls(BIF, (window as unknown as { odreadCmptParams: string[] | null }).odreadCmptParams || null);
  chapterMenuElem.innerHTML = chaptersMenu.replace('{CHAPTERS}', String(urls.length));
  document.body.appendChild(chapterMenuElem);

  downloadElem = document.createElement('div');
  downloadElem.classList.add('foldMenu');
  downloadElem.setAttribute('tabindex', '-1');
  document.body.appendChild(downloadElem);

  downloadProgress = new ProgressDisplay(downloadElem);
  chapterProgress = new ProgressDisplay(chapterMenuElem);
}

function viewChapters(BIF: BIF): void {
  if (!chapterMenuElem) return;
  if (firstChapClick) {
    firstChapClick = false;
    const urls = getUrls(BIF, (window as unknown as { odreadCmptParams: string[] | null }).odreadCmptParams || null);
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
      const urls = getUrls(BIF, (window as unknown as { odreadCmptParams: string[] | null }).odreadCmptParams || null);
      await Promise.all(urls.map(async (url) => {
        const res = await fetch(url.url);
        const blob = await res.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${getAuthorString(BIF)} - ${BIF.map.title.main}.${url.index}.mp3`;
        link.click();
        URL.revokeObjectURL(link.href);
      }));
      if (dumpAllBtn) dumpAllBtn.style.display = '';
    };
  }
}

function getAuthorString(BIF: BIF): string {
  return BIF.map.creator.filter((creator) => creator.role === 'author').map((creator) => creator.name).join(', ');
}

function exportMP3(BIF: BIF): void {
  const state = (window as unknown as { downloadState: number }).downloadState;
  if (state !== -1) return;

  (window as unknown as { downloadState: number }).downloadState = 0;
  if (downloadElem) {
    downloadElem.classList.add('active');
    downloadProgress?.add('<b>Starting MP3</b>');
  }
  createAndDownloadMp3(
    BIF,
    (window as unknown as { odreadCmptParams: string[] | null }).odreadCmptParams || null,
    downloadProgress!,
    pickSaveFile,
    buildAudiobookSingleMp3
  ).then(() => {
    (window as unknown as { downloadState: number }).downloadState = -1;
  });
}

function exportChaptersHandler(BIF: BIF): void {
  const state = (window as unknown as { downloadState: number }).downloadState;
  if (state !== -1) return;

  (window as unknown as { downloadState: number }).downloadState = 1;
  if (downloadElem) {
    downloadElem.classList.add('active');
    downloadProgress?.add('<b>Starting ZIP export</b>');
  }

  const getDownloadZip = async () => {
    const page = pageWindow();
    if (page.downloadZip) return page.downloadZip;
    if (window.__libregrabClientZipReady) return window.__libregrabClientZipReady;
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/client-zip@2.5.0/worker.js';
      s.onload = () => resolve();
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return page.downloadZip;
  };

  exportChapters(
    BIF,
    (window as unknown as { odreadCmptParams: string[] | null }).odreadCmptParams || null,
    downloadProgress!,
    getDownloadZip
  ).then(() => {
    (window as unknown as { downloadState: number }).downloadState = -1;
  });
}

function pageWindow(): Window & typeof globalThis {
  return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
}