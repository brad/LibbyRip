import type { MessageData, SaveHandle } from '../types.js';
import { parseMpegHeader, countMpegFrames, stripXingFrame, makeXingFrame, type MpegHeader } from './mpeg.js';
import { buildBookId3Tag, tagChapterMp3, stripId3, type BuildBookId3TagOptions, type TagChapterMp3Options } from './id3.js';

const LIBREGRAB_SAVE_REQUEST = 'LIBREGRAB_SAVE_REQUEST';
const LIBREGRAB_SAVE_RESULT = 'LIBREGRAB_SAVE_RESULT';
const LIBREGRAB_GET_URLS = 'LIBREGRAB_GET_URLS';
const LIBREGRAB_GET_URLS_RESPONSE = 'LIBREGRAB_GET_URLS_RESPONSE';
const LIBREGRAB_GET_METADATA = 'LIBREGRAB_GET_METADATA';
const LIBREGRAB_GET_METADATA_RESPONSE = 'LIBREGRAB_GET_METADATA_RESPONSE';
const LIBREGRAB_GET_CREATORS = 'LIBREGRAB_GET_CREATORS';
const LIBREGRAB_GET_CREATORS_RESPONSE = 'LIBREGRAB_GET_CREATORS_RESPONSE';

// Chunk streaming messages (iframe -> top frame)
const LIBREGRAB_FETCH_CHAPTER = 'LIBREGRAB_FETCH_CHAPTER';
const LIBREGRAB_CHUNK_DATA = 'LIBREGRAB_CHUNK_DATA';
const LIBREGRAB_CHUNK_DONE = 'LIBREGRAB_CHUNK_DONE';
const LIBREGRAB_CHUNK_ERROR = 'LIBREGRAB_CHUNK_ERROR';

function isLibbyFamilyOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'libbyapp.com' || host.endsWith('.libbyapp.com')
      || host === 'overdrive.com' || host.endsWith('.overdrive.com');
  } catch {
    return false;
  }
}

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
    const data = event.data as MessageData;
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

export async function requestSaveFromTopFrame(blob: Blob, filename: string, mimeType: string): Promise<void> {
  if (isTopFrame) {
    saveBlobFromTopFrame(blob, filename);
    return;
  }
  const parentOrigin = document.referrer ? new URL(document.referrer).origin : '';
  if (!isLibbyFamilyOrigin(parentOrigin)) {
    throw new Error('Unrecognized top-level Libby/OverDrive origin: ' + parentOrigin);
  }
  const arrayBuffer = await blob.arrayBuffer();
  window.top.postMessage({
    type: LIBREGRAB_SAVE_REQUEST,
    requestId: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
    filename,
    mimeType: mimeType || blob.type || 'application/octet-stream',
    arrayBuffer,
  }, parentOrigin, [arrayBuffer]);
}

function pageWindow(): Window & typeof globalThis {
  return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
}

/**
 * In-memory, seekable stand-in for a FileSystemFileHandle, for browsers
 * without the File System Access API (Firefox/Zen). Buffers every write as
 * a segment and triggers a blob download on close. Supports the
 * seek-then-overwrite pattern buildAudiobookSingleMp3 uses to patch the
 * Xing header: later segments win when composed at close.
 */
class MemoryWritable {
  private segments: Array<{ offset: number; data: Uint8Array }> = [];
  private length = 0;
  private position = 0;
  private closed = false;

  constructor(private suggestedName: string) {}

  private toBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data && typeof data === 'object' && 'data' in (data as Record<string, unknown>)) {
      return this.toBytes((data as Record<string, unknown>).data);
    }
    return new Uint8Array(data as ArrayLike<number>);
  }

  async write(data: Uint8Array | ArrayBuffer | ArrayBufferView | { type?: string; data?: unknown; position?: number }): Promise<void> {
    if (this.closed) throw new Error('Writable is closed');
    let bytes: Uint8Array;
    let at = this.position;
    if (data && typeof data === 'object' && ('data' in data || 'type' in data)) {
      const opts = data as { data?: unknown; position?: number };
      if (typeof opts.position === 'number') at = opts.position;
      bytes = this.toBytes(opts.data);
    } else {
      bytes = this.toBytes(data);
    }
    this.segments.push({ offset: at, data: bytes });
    this.position = at + bytes.length;
    if (this.position > this.length) this.length = this.position;
  }

  async seek(position: number): Promise<void> {
    if (this.closed) throw new Error('Writable is closed');
    this.position = position;
  }

  async truncate(size: number): Promise<void> {
    if (this.closed) throw new Error('Writable is closed');
    this.length = size;
    if (this.position > this.length) this.position = this.length;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.length > 0) {
      const buf = new Uint8Array(this.length);
      for (const seg of this.segments) {
        if (seg.offset < this.length) {
          buf.set(seg.data.subarray(0, Math.min(seg.data.length, this.length - seg.offset)), seg.offset);
        }
      }
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = this.suggestedName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  async abort(): Promise<void> {
    this.closed = true;
  }
}

function memorySaveHandle(suggestedName: string): SaveHandle {
  return {
    name: suggestedName,
    createWritable: async () => new MemoryWritable(suggestedName) as unknown as WritableStream,
    createSyncAccessHandle: async (): Promise<never> => {
      throw new Error('Sync access handles are not supported');
    },
  };
}

export async function pickSaveFile(suggestedName: string, types: Array<{ description: string; accept: Record<string, string[]> }>): Promise<SaveHandle> {
  if (window.top !== window.self) {
    throw new Error('pickSaveFile must be called from top frame');
  }
  const w = pageWindow();
  const picker = w.showSaveFilePicker;
  if (typeof picker !== 'function') {
    // Firefox/Zen have no File System Access API: buffer in memory and
    // download a blob on close instead of streaming to disk.
    return memorySaveHandle(suggestedName);
  }
  return picker.call(w, { suggestedName, types });
}

interface BuildAudiobookOptions {
  urls: Array<{ url: string; index: number; duration: number; size: number; type: string }>;
  metadata: { chapters?: Array<{ chapter_number: number; title?: string }> };
  coverBytes: Uint8Array | null;
  coverMime: string | null;
  fileHandle: SaveHandle;
  progress: (msg: string) => void;
  fetchWithRetry: (url: string, opts: RequestInit, label: string, progress: (msg: string) => void, maxAttempts?: number) => Promise<Response>;
  BIF: { map: { title: { main: string }; series?: string[] }; map: { creator: Array<{ name: string; role: string }> } };
  getAuthorString: () => string;
  getNarratorString: () => string;
  durationByChapter?: Record<number, number>;
}

export async function buildAudiobookSingleMp3(options: BuildAudiobookOptions): Promise<boolean> {
  const { urls, metadata, coverBytes, coverMime, fileHandle, progress, fetchWithRetry, BIF, getAuthorString, getNarratorString } = options;
  const totalChapters = metadata.chapters ? metadata.chapters.length : urls.length;
  const displayTitle = BIF.map.title.main;
  const author = getAuthorString();
  const narrator = getNarratorString();

  progress('<b>Streaming single MP3...</b>');

  const chapterDurations = options.durationByChapter || Object.fromEntries(urls.map((u) => [u.index + 1, u.duration * 1000]));
  // The BIF description arrives as a string or as { short, full };
  // normalize to a plain string for the COMM frame (merged behavior).
  const rawDescription: unknown = (BIF.map as { description?: unknown }).description;
  const descriptionText =
    typeof rawDescription === 'string'
      ? rawDescription
      : (rawDescription as { short?: string; full?: string } | null | undefined)?.short ||
        (rawDescription as { short?: string; full?: string } | null | undefined)?.full ||
        '';
  const buildTagOptions: BuildBookId3TagOptions = {
    book: { ...BIF.map, description: descriptionText },
    displayTitle,
    author,
    narrator,
    seriesName: (BIF.map.series && BIF.map.series[0]) || null,
    seriesIndex: null,
    chapters: metadata.chapters || [],
    durationByChapter: chapterDurations,
    coverBytes,
    coverMime,
  };
const { tag, totalDurationMs } = buildBookId3Tag(buildTagOptions);
  progress(`Wrote ID3v2 tag (${tag.length} bytes) with ${totalChapters} CHAP frames, duration ${(totalDurationMs / 3600000).toFixed(2)} h.`);

  // Fetch first chapter to get proto for Xing frame
  progress(`Fetching first chapter to determine audio format...`);
  const firstChapter = await requestChapterFromIframe(urls[0].url, progress, fetchWithRetry);
  const proto = parseMpegHeader(firstChapter, 0);
  if (!proto) throw new Error('First chapter did not start with a valid MPEG frame');

  const placeholderXing = makeXingFrame(proto, 0, 0);
  const writable = await fileHandle.createWritable();
  let audioBytes = 0;
  let audioFrames = 0;

  try {
    await writable.write(tag);
    await writable.write(placeholderXing);

    // Write first chapter (already fetched)
    const firstAudio = stripXingFrame(firstChapter);
    if (!firstAudio.length) throw new Error('First chapter had no MPEG frames after header strip');
    const firstFrames = countMpegFrames(firstAudio);
    audioFrames += firstFrames;
    audioBytes += firstAudio.length;
    await writable.write(firstAudio);
    progress(`Appended 1/${urls.length} (chapter ${urls[0].index}, ${firstFrames} frames, ${(audioBytes / 1e6).toFixed(1)} MB audio)`);

    // Stream remaining chapters
    for (let i = 1; i < urls.length; i++) {
      const url = urls[i];
      const audio = await requestChapterFromIframe(url.url, progress, fetchWithRetry);
      if (!audio.length) throw new Error(`chapter ${url.index} had no MPEG frames`);
      const frames = countMpegFrames(audio);
      audioFrames += frames;
      audioBytes += audio.length;
      await writable.write(audio);
      progress(`Appended ${i + 1}/${urls.length} (chapter ${url.index}, ${frames} frames, ${(audioBytes / 1e6).toFixed(1)} MB audio)`);
    }

    const totalFrames = audioFrames + 1;
    const totalBytes = audioBytes + placeholderXing.length;
    // Use durationByChapter from options if provided, otherwise create from urls
    const chapterDurations = options.durationByChapter || Object.fromEntries(urls.map((u) => [u.index + 1, u.duration * 1000]));
    const finalXing = makeXingFrame(proto, totalFrames, totalBytes);
    if (finalXing.length !== placeholderXing.length) {
      throw new Error('Xing frame length changed between placeholder and final write');
    }
    
    progress(`Patching Xing header at position ${tag.length}...`);
    await writable.seek(tag.length);
    await writable.write(finalXing);
    progress(`Patched Xing header: ${totalFrames} frames, ${totalBytes} bytes (seek table rebuilt).`);
    progress(`Closing writable...`);
    try {
      await writable.close();
      progress(`Writable closed successfully.`);
    } catch (closeError) {
      if (!(closeError as Error).message.includes('closed or closing')) {
        throw closeError;
      }
      progress(`Writable already closed.`);
    }
  } catch (e) {
    try { await writable.close(); } catch {}
    throw new Error(
      `Aborted single-MP3 after ${(audioBytes / 1e6).toFixed(1)} MB. ` +
      `A partial file may remain. ${(e as Error).message}`
    );
  }
  progress(`<b>Done! Single MP3 on disk (${(audioBytes / 1e6).toFixed(1)} MB audio + ${tag.length} byte ID3 + Xing). Duration should match TLEN/CHAP without bitrate guessing.</b>`);
  return true;
}

// Request chapter bytes: via the player iframe on Libby, or by direct fetch
// in the frameless player page itself on OverDrive (same GET the iframe-side
// handler would make, same retries, same ID3 strip).
async function requestChapterFromIframe(
  url: string,
  progress: (msg: string) => void,
  fetchWithRetry: (url: string, opts: RequestInit, label: string, progress: (msg: string) => void, maxAttempts?: number) => Promise<Response>,
): Promise<Uint8Array> {
  const iframe = document.querySelector('iframe[src*="listen.libbyapp.com"]') as HTMLIFrameElement | null;
  if (!iframe) {
    // No player iframe. Only fetch directly when a local BIF is present,
    // i.e. this frame IS the player page (OverDrive's frameless reader).
    // Anywhere else (e.g. Libby with the player not open) keep the clear
    // error instead of attempting a fetch that cannot authenticate.
    const localBif = (window as any).BIF;
    if (!localBif?.map) throw new Error('Audiobook player iframe not found');
    console.log('[LibbyRip] No player iframe; fetching chapter directly (frameless player):', url);
    const res = await fetchWithRetry(url, { method: 'GET' }, 'chapter fetch', progress);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return stripId3(bytes);
  }

  const requestId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();

  let iframeOrigin = '';
  try {
    iframeOrigin = new URL(iframe.src).origin;
  } catch {}
  const targetOrigin = iframeOrigin || '*';

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    let done = false;
    
    const timeoutId = setTimeout(() => {
      if (!done) reject(new Error('Timed out waiting for chapter data'));
    }, 120000);

    function onMessage(event: MessageEvent): void {
      if (!isPlayerOrigin(event.origin)) return;
      if (event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (!data || data.requestId !== requestId) return;

      if (data.type === LIBREGRAB_CHUNK_DATA) {
        if (data.chunk) {
          chunks.push(new Uint8Array(data.chunk));
          totalSize += data.chunk.byteLength;
        }
      } else if (data.type === LIBREGRAB_CHUNK_DONE) {
        done = true;
        clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        const result = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(stripId3(result));
      } else if (data.type === LIBREGRAB_CHUNK_ERROR) {
        done = true;
        clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        reject(new Error(data.error || 'Iframe chapter fetch failed'));
      }
    }

    window.addEventListener('message', onMessage);

    // Request chapter fetch from iframe
    iframe.contentWindow?.postMessage({
      type: LIBREGRAB_FETCH_CHAPTER,
      requestId,
      url,
    }, iframeOrigin || '*');
  });
}

function iframeParentOrigin(): string {
  try {
    if (document.referrer) {
      const refOrigin = new URL(document.referrer).origin;
      if (refOrigin && refOrigin !== 'null') return refOrigin;
    }
  } catch {}
  try {
    if (location.ancestorOrigins && location.ancestorOrigins.length) {
      return location.ancestorOrigins[0];
    }
  } catch {}
  try {
    return window.top.location.origin;
  } catch {}
  try {
    const host = location.hostname;
    if (host.includes('listen.') || host.includes('read.')) {
      const mainHost = host.replace(/^(listen|read)\./, '');
      return `https://${mainHost}`;
    }
  } catch {}
  return '';
}

function libregrabRequestId(): string {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
}

const pendingTopFrameRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeoutId: ReturnType<typeof setTimeout> }>();

export function handleIframeDataMessage(event: MessageEvent): void {
  const data = event.data as MessageData;
  if (!data) return;
  // In top frame, responses come from the iframe (child frame)
  const iframe = document.querySelector('iframe[src*="listen.libbyapp.com"]') as HTMLIFrameElement | null;
  if (!iframe || event.source !== iframe.contentWindow) return;

  if (data.type === LIBREGRAB_GET_URLS_RESPONSE) {
    const pending = pendingTopFrameRequests.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingTopFrameRequests.delete(data.requestId);
    if (data.ok) pending.resolve({ urls: data.urls, metadata: data.metadata });
    else pending.reject(new Error((data.error && data.error.message) || 'Iframe GET_URLS failed'));
    return;
  }

  if (data.type === LIBREGRAB_GET_METADATA_RESPONSE) {
    const pending = pendingTopFrameRequests.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingTopFrameRequests.delete(data.requestId);
    if (data.ok) pending.resolve(data.metadata);
    else pending.reject(new Error((data.error && data.error.message) || 'Iframe GET_METADATA failed'));
    return;
  }

  if (data.type === LIBREGRAB_GET_CREATORS_RESPONSE) {
    const pending = pendingTopFrameRequests.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingTopFrameRequests.delete(data.requestId);
    if (data.ok) pending.resolve({ author: data.author, narrator: data.narrator });
    else pending.reject(new Error((data.error && data.error.message) || 'Iframe GET_CREATORS failed'));
  }
}

export async function requestFromIframe<T>(type: string, timeoutMs = 10000): Promise<T> {
  const requestId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
  
  const iframe = document.querySelector('iframe[src*="listen.libbyapp.com"]') as HTMLIFrameElement | null;
  if (!iframe) throw new Error('Audiobook player iframe not found');

  // Get iframe's actual origin from its src
  let iframeOrigin = '';
  try {
    iframeOrigin = new URL(iframe.src).origin;
  } catch {}
  
  const targetOrigin = iframeOrigin || '*';
  console.log('[LibbyRip] top frame sending', type, 'to iframe at', targetOrigin, 'requestId:', requestId);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingTopFrameRequests.delete(requestId);
      reject(new Error(`Timed out waiting for iframe response (${type})`));
    }, timeoutMs);
    pendingTopFrameRequests.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timeoutId });
    iframe.contentWindow?.postMessage({ type, requestId }, targetOrigin);
  });
}

// Iframe-side handler for chapter fetch requests
export function setupIframeFetchHandler(fetchWithRetry: (url: string, opts: RequestInit, label: string, progress: (msg: string) => void, maxAttempts?: number) => Promise<Response>): void {
  if (isTopFrame) return;
  
  window.addEventListener('message', async (event) => {
    if (!isLibbyFamilyOrigin(event.origin)) return;
    const { type, requestId, url } = event.data;
    if (!type || !requestId) return;
    if (type !== LIBREGRAB_FETCH_CHAPTER) return;

    const targetOrigin = event.origin;
    const source = event.source;
    
    console.log('[LibbyRip] iframe fetching chapter:', url);
    
    try {
      const res = await fetchWithRetry(url, { method: 'GET' }, `chapter fetch`, (msg) => {
        source?.postMessage({ type: 'LIBREGRAB_FETCH_PROGRESS', requestId, msg }, targetOrigin);
      });
      
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body reader');
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        source?.postMessage({
          type: LIBREGRAB_CHUNK_DATA,
          requestId,
          chunk: value.buffer,
        }, targetOrigin, [value.buffer]);
      }
      
      source?.postMessage({
        type: LIBREGRAB_CHUNK_DONE,
        requestId,
      }, targetOrigin);
    } catch (e) {
      console.error('[LibbyRip] iframe fetch error:', e);
      source?.postMessage({
        type: LIBREGRAB_CHUNK_ERROR,
        requestId,
        error: (e as Error).message,
      }, targetOrigin);
    }
  });
}

export function setupIframeApi(bif: { map: any; root: any; objects: any }, odreadCmptParams: string[] | null, getUrlsFn: (bif: any, params: string[] | null) => any[], getMetadataFn: (bif: any) => any, getAuthorStringFn: (bif: any) => string, getNarratorStringFn: (bif: any) => string): void {
  if (window.top === window.self) return;

  (window as any).LibreGRAB = {
    getUrls() { return getUrlsFn(bif, odreadCmptParams); },
    getMetadata() { return getMetadataFn(bif); },
    getAuthorString() { return getAuthorStringFn(bif); },
    getNarratorString() { return getNarratorStringFn(bif); }
  };

  window.addEventListener('message', (event) => {
    console.log('[LibbyRip] iframe received message:', event.data, 'from origin:', event.origin);
    if (!isLibbyFamilyOrigin(event.origin)) return;
    const { type, requestId } = event.data;
    if (!type || !requestId) return;

    if (type === LIBREGRAB_GET_URLS) {
      console.log('[LibbyRip] iframe responding to GET_URLS');
      event.source.postMessage({
        type: LIBREGRAB_GET_URLS_RESPONSE,
        requestId,
        ok: true,
        urls: (window as any).LibreGRAB.getUrls(),
        metadata: (window as any).LibreGRAB.getMetadata()
      }, event.origin);
    } else if (type === LIBREGRAB_GET_METADATA) {
      event.source.postMessage({
        type: LIBREGRAB_GET_METADATA_RESPONSE,
        requestId,
        ok: true,
        metadata: (window as any).LibreGRAB.getMetadata()
      }, event.origin);
    } else if (type === LIBREGRAB_GET_CREATORS) {
      event.source.postMessage({
        type: LIBREGRAB_GET_CREATORS_RESPONSE,
        requestId,
        ok: true,
        author: (window as any).LibreGRAB.getAuthorString(),
        narrator: (window as any).LibreGRAB.getNarratorString()
      }, event.origin);
    }
  });
}