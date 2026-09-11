import type { BIF } from './bif.js';
import type { URLInfo } from '../types.js';
import { getUrls } from './urls.js';
import { getMetadata, getAuthorString, getNarratorString, createMetadata } from './bif.js';
import { tagChapterMp3, type TagChapterMp3Options } from '../utils/id3.js';
import { fetchCover, fetchWithRetry, safeFilename } from '../utils/fetch.js';
import { requestSaveFromTopFrame } from '../utils/download.js';
import type { ProgressDisplay } from '../ui/progress.js';

interface WritableFileHandle {
  createWritable: () => Promise<{
    write: (data: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    seek: (pos: number) => Promise<void>;
  }>;
}

interface ChapterResult {
  ok: boolean;
  chapterNumber: number;
  filename?: string;
  blob?: Blob;
  error?: string;
}

interface ZipFile {
  name: string;
  input: Blob | Uint8Array | string;
}

export async function exportChapters(
  BIF: BIF,
  odreadCmptParams: string[] | null,
  progress: ProgressDisplay,
  getDownloadZip: () => Promise<(files: ZipFile[]) => Promise<{ blob: () => Promise<Blob> }>>
): Promise<void> {
  const metadata = getMetadata(BIF);
  let coverBytes: Uint8Array | null = null;
  if (metadata.coverUrl) {
    const cover = await fetchCover(metadata.coverUrl, (msg) => progress.add(msg));
    coverBytes = cover.bytes;
  }

  const urls = getUrls(BIF, odreadCmptParams);
  const totalLogicalChapters = metadata.chapters ? metadata.chapters.length : urls.length;
  const results: ChapterResult[] = new Array(urls.length);
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
        const res = await fetchWithRetry(url.url, { method: 'GET' }, label, (msg) => progress.add(msg));
        const arrayBuffer = await res.arrayBuffer();
        totalBytes.done += arrayBuffer.byteLength;

        const tagOptions: TagChapterMp3Options = {
          book: BIF.map,
          displayTitle: BIF.map.title.main,
          author: getAuthorString(BIF),
          narrator: getNarratorString(BIF),
          seriesName: (BIF.map.series && BIF.map.series[0]) || null,
          seriesIndex: null,
          chapterNumber: url.index,
          totalChapters: totalLogicalChapters,
          durationMs: url.duration * 1000,
          coverBytes,
          coverMime: coverBytes ? 'image/jpeg' : null,
          progress: (msg) => progress.add(msg),
        };
        const taggedBlob = tagChapterMp3(arrayBuffer, tagOptions);

        const num = String(url.index).padStart(2, '0');
        results[i] = { ok: true, chapterNumber: url.index, filename: `${num} - Chapter ${url.index}.mp3`, blob: taggedBlob };
        progress.add(`Fetched + tagged ${i + 1}/${urls.length} (${label}, ${(totalBytes.done / 1e6).toFixed(1)} MB so far)`);
      } catch (e) {
        results[i] = { ok: false, chapterNumber: url.index, error: (e as Error).message };
        progress.add(`FAILED: ${label} - ${(e as Error).message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    const failedList = failed.map((f) => `chapter ${f.chapterNumber} (${f.error})`).join(', ');
    progress.add(`<b>Aborted: ${failed.length}/${urls.length} chapter(s) failed: ${failedList}</b>`);
    return;
  }

  progress.add(`All ${urls.length} chapters downloaded successfully (${(totalBytes.done / 1e6).toFixed(1)} MB total).`);
  progress.add('Assembling zip...');

  const makeZip = await getDownloadZip();
  if (typeof makeZip !== 'function') throw new Error('client-zip failed to load.');

  const files: ZipFile[] = [];
  if (coverBytes) {
    files.push({ name: 'cover.jpg', input: coverBytes });
  }
  results.forEach((r) => {
    if (r.ok && r.filename && r.blob) files.push({ name: r.filename, input: r.blob });
  });

  progress.add(`Zipping ${files.length} files...`);

  const zipBlob = await makeZip(files).blob();
  const outputFilename = safeFilename(getAuthorString(BIF) + ' - ' + BIF.map.title.main) + '.zip';

  progress.add('Sending ZIP to the top-level download handler…');
  try {
    await requestSaveFromTopFrame(zipBlob, outputFilename, 'application/zip');
    progress.add('<b>Download complete!</b>');
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      progress.add('Download cancelled by user.');
    } else {
      console.error('Top-level save failed', error);
      progress.add(`<b>Save failed:</b> ${String((error as Error).message ?? error)}`);
    }
  }
  progress.clear();
}

export async function fallbackBlobDownload(
  files: ZipFile[],
  filename: string,
  getDownloadZip: () => Promise<(files: ZipFile[]) => Promise<{ blob: () => Promise<Blob> }>>,
  progress: ProgressDisplay
): Promise<void> {
  progress.add('Using fallback download method...');
  const zipBlob = await (await getDownloadZip())(files).blob();
  progress.add('Generated zip file!');
  const downloadUrl = URL.createObjectURL(zipBlob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);
}

export async function createAndDownloadZip(
  BIF: BIF,
  urls: URLInfo[],
  addMeta: boolean,
  progress: ProgressDisplay,
  getDownloadZip: () => Promise<(files: ZipFile[]) => Promise<{ blob: () => Promise<Blob> }>>,
  fetchFn: (url: string) => Promise<Response>
): Promise<void> {
  const files: ZipFile[] = [];

  let coverBlob: Blob | null = null;
  if (BIF.map.title?.main) {
    const metadata = getMetadata(BIF);
    if (metadata.coverUrl) {
      const response = await fetchFn(metadata.coverUrl);
      coverBlob = await response.blob();
    }
  }

  const fetchPromises = urls.map(async (url) => {
    const response = await fetch(url.url);
    const arrayBuffer = await response.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: url.type });
    files.push({
      name: `${getAuthorString(BIF)} - ${BIF.map.title.main}.${url.index}.mp3`,
      input: blob,
    });
  });

  await Promise.all(fetchPromises);

  if (addMeta) {
    const meta = await createMetadata(BIF, fetchFn);
    files.push(...meta);
  }

  const zipBlob = await (await getDownloadZip())(files).blob();
  const downloadUrl = URL.createObjectURL(zipBlob);

  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `${getAuthorString(BIF)} - ${BIF.map.title.main}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);
}

async function getDownloadZip(): Promise<(files: ZipFile[]) => Promise<{ blob: () => Promise<Blob> }>> {
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
}

function pageWindow(): Window & typeof globalThis {
  return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
}