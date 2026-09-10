import type { MessageData, SaveHandle, ProxySaveHandle } from '../types.js';
import { parseMpegHeader, countMpegFrames, stripXingFrame, makeXingFrame, type MpegHeader } from './mpeg.js';
import { buildBookId3Tag, tagChapterMp3, stripId3, type BuildBookId3TagOptions, type TagChapterMp3Options } from './id3.js';

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

function libregrabRequestId(): string {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
}

function iframeParentOrigin(): string {
  // Try multiple methods to get the parent origin
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
    // For same-origin iframes, we can access top.location
    return window.top.location.origin;
  } catch {}
  // Last resort: if we're on a listen.* domain, the parent is likely the main libbyapp.com
  try {
    const host = location.hostname;
    if (host.includes('listen.') || host.includes('read.')) {
      // Try to infer the main libby app origin
      const mainHost = host.replace(/^(listen|read)\./, '');
      return `https://${mainHost}`;
    }
  } catch {}
  return '';
}

function toArrayBuffer(data: Uint8Array | ArrayBuffer | Blob): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return Promise.resolve(data);
  if (ArrayBuffer.isView(data)) return Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (data instanceof Blob) return data.arrayBuffer();
  return new Blob([data]).arrayBuffer();
}

interface TopPickSession {
  requestId: string;
  source: MessagePort | Window;
  origin: string;
  filename: string;
  types: Array<{ description: string; accept: Record<string, string[]> }> | null;
  fileHandle: FileSystemFileHandle | null;
  writable: WritableStreamDefaultWriter | null;
  button: HTMLButtonElement | null;
}

const pendingIframePicks = new Map<string, { resolve: (v: { name: string; parentOrigin: string }) => void; reject: (e: Error) => void; timeoutId: ReturnType<typeof setTimeout> }>();
const pendingIframeWrites = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
const pendingIframeSeeks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
const topPickSessions = new Map<string, TopPickSession>();

function showTopFramePickButton(session: TopPickSession): void {
  if (session.button && session.button.isConnected) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'LibreGRAB: Choose save location — ' + session.filename;
  button.title = 'Click to open the system file picker';
  button.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'max-width:min(90vw, 560px)', 'padding:12px 16px', 'border:1px solid #333',
    'border-radius:8px', 'background:#fff', 'color:#111', 'font:14px/1.3 sans-serif',
    'box-shadow:0 2px 12px rgba(0,0,0,.35)', 'cursor:pointer',
  ].join(';');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'LibreGRAB: Opening file picker…';
    try {
      const w = pageWindow();
      const picker = w.showSaveFilePicker;
      if (typeof picker !== 'function') throw new Error('File System Access API is not available on the top-level page');
      const fileHandle = await picker.call(w, {
        suggestedName: session.filename,
        types: session.types && session.types.length ? session.types : [{
          description: 'MP3 audio',
          accept: { 'audio/mpeg': ['.mp3'] },
        }],
      });
      session.fileHandle = fileHandle;
      session.writable = await fileHandle.createWritable();
      button.remove();
      session.source.postMessage({
        type: LIBREGRAB_PICK_RESULT,
        requestId: session.requestId,
        ok: true,
        name: fileHandle.name || session.filename,
      }, session.origin);
    } catch (error) {
      button.remove();
      topPickSessions.delete(session.requestId);
      session.source.postMessage({
        type: LIBREGRAB_PICK_RESULT,
        requestId: session.requestId,
        ok: false,
        cancelled: !!(error && (error as Error).name === 'AbortError'),
        error: { name: (error as Error).name, message: (error as Error).message },
      }, session.origin);
    }
  }, { once: true });
  (document.body || document.documentElement).appendChild(button);
  session.button = button;
}

export async function handleTopPickMessage(event: MessageEvent): Promise<void> {
  const data = event.data as MessageData;
  if (!isPlayerOrigin(event.origin) || !data) return;

  if (data.type === LIBREGRAB_PICK_REQUEST) {
    if (typeof data.requestId !== 'string' || topPickSessions.has(data.requestId)) return;
    const session: TopPickSession = {
      requestId: data.requestId,
      source: event.source as MessagePort | Window,
      origin: event.origin,
      filename: String(data.filename || 'audiobook.mp3').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').slice(0, 180) || 'audiobook.mp3',
      types: Array.isArray(data.types) ? data.types : null,
      fileHandle: null,
      writable: null,
      button: null,
    };
    topPickSessions.set(session.requestId, session);
    showTopFramePickButton(session);
    return;
  }

  const session = topPickSessions.get(data.requestId);
  if (!session || event.source !== session.source) return;

  if (data.type === LIBREGRAB_WRITE_CHUNK) {
    try {
      if (!session.writable) throw new Error('Save file was not chosen yet');
      if (!(data.arrayBuffer instanceof ArrayBuffer)) throw new Error('Missing file chunk');
      await session.writable.write(new Uint8Array(data.arrayBuffer));
      session.source.postMessage({
        type: LIBREGRAB_WRITE_ACK,
        requestId: session.requestId,
        seq: data.seq,
        ok: true,
      }, session.origin);
    } catch (error) {
      session.source.postMessage({
        type: LIBREGRAB_WRITE_ACK,
        requestId: session.requestId,
        seq: data.seq,
        ok: false,
        error: { name: (error as Error).name, message: (error as Error).message },
      }, session.origin);
    }
    return;
  }

  if (data.type === LIBREGRAB_WRITE_SEEK) {
    try {
      if (!session.writable) throw new Error('Save file was not chosen yet');
      await session.writable.seek(data.position);
      session.source.postMessage({
        type: LIBREGRAB_WRITE_SEEK_ACK,
        requestId: session.requestId,
        ok: true,
      }, session.origin);
    } catch (error) {
      session.source.postMessage({
        type: LIBREGRAB_WRITE_SEEK_ACK,
        requestId: session.requestId,
        ok: false,
        error: { name: (error as Error).name, message: (error as Error).message },
      }, session.origin);
    }
    return;
  }

  if (data.type === LIBREGRAB_WRITE_CLOSE) {
    try {
      if (session.writable) {
        try {
          await session.writable.close();
        } catch (closeError) {
          if (!(closeError as Error).message.includes('closed or closing')) {
            throw closeError;
          }
        }
      }
      session.source.postMessage({
        type: LIBREGRAB_WRITE_CLOSE_ACK,
        requestId: session.requestId,
        ok: true,
        name: (session.fileHandle && session.fileHandle.name) || session.filename,
      }, session.origin);
    } catch (error) {
      session.source.postMessage({
        type: LIBREGRAB_WRITE_CLOSE_ACK,
        requestId: session.requestId,
        ok: false,
        error: { name: (error as Error).name, message: (error as Error).message },
      }, session.origin);
    } finally {
      if (session.button) session.button.remove();
      topPickSessions.delete(session.requestId);
    }
  }
}

export function handleIframePickMessage(event: MessageEvent): void {
  const data = event.data as MessageData;
  if (!data || event.source !== window.top) return;

  if (data.type === LIBREGRAB_PICK_RESULT) {
    const pending = pendingIframePicks.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingIframePicks.delete(data.requestId);
    if (data.ok) pending.resolve({ name: data.name || 'audiobook.mp3', parentOrigin: event.origin });
    else if (data.cancelled) pending.reject(new DOMException('Save cancelled by user.', 'AbortError'));
    else pending.reject(new Error((data.error && data.error.message) || 'Top-level file picker failed'));
    return;
  }

  if (data.type === LIBREGRAB_WRITE_ACK) {
    const pending = pendingIframeWrites.get(data.requestId + ':' + data.seq);
    if (!pending) return;
    pendingIframeWrites.delete(data.requestId + ':' + data.seq);
    if (data.ok) pending.resolve();
    else pending.reject(new Error((data.error && data.error.message) || 'Top-level write failed'));
    return;
  }

  if (data.type === LIBREGRAB_WRITE_CLOSE_ACK) {
    const pending = pendingIframeWrites.get(data.requestId + ':close');
    if (!pending) return;
    pendingIframeWrites.delete(data.requestId + ':close');
    if (data.ok) pending.resolve(data.name);
    else pending.reject(new Error((data.error && data.error.message) || 'Top-level close failed'));
    return;
  }

  if (data.type === LIBREGRAB_WRITE_SEEK_ACK) {
    const pending = pendingIframeSeeks.get(data.requestId);
    if (!pending) return;
    pendingIframeSeeks.delete(data.requestId);
    if (data.ok) pending.resolve();
    else pending.reject(new Error((data.error && data.error.message) || 'Top-level seek failed'));
  }
}

window.addEventListener('message', (event) => {
  if (isTopFrame) handleTopPickMessage(event).catch((err) => console.error('LibreGRAB top-frame picker failed', err));
  else handleIframePickMessage(event);
});

export async function createProxySaveHandle(suggestedName: string, types: Array<{ description: string; accept: Record<string, string[]> }> | undefined, downloadElem: HTMLElement): Promise<ProxySaveHandle> {
  let origin = iframeParentOrigin();
  const targetOrigin = (origin && isLibbyFamilyOrigin(origin)) ? origin : '*';
  if (downloadElem) {
    downloadElem.innerHTML += 'Click <b>LibreGRAB: Choose save location</b> on the main Libby page to open the file picker.<br>';
    downloadElem.scrollTo(0, downloadElem.scrollHeight);
  }
  const requestId = libregrabRequestId();
  const picked = await new Promise<{ name: string; parentOrigin: string }>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingIframePicks.delete(requestId);
      reject(new Error('Timed out waiting for the top-level file picker'));
    }, 10 * 60 * 1000);
    pendingIframePicks.set(requestId, { resolve, reject, timeoutId });
    window.top.postMessage({
      type: LIBREGRAB_PICK_REQUEST,
      requestId,
      filename: suggestedName,
      types,
    }, targetOrigin);
  });
  const name = picked.name;
  origin = picked.parentOrigin || origin;
  if (!origin || !isLibbyFamilyOrigin(origin)) {
    throw new Error('Unrecognized top-level Libby/OverDrive origin: ' + origin);
  }

  let seq = 0;
  let proxyClosed = false;
  return {
    name,
    async createWritable() {
      return {
        async write(data: Uint8Array | ArrayBuffer | Blob) {
          if (proxyClosed) throw new Error('Proxy writable already closed');
          const arrayBuffer = await toArrayBuffer(data);
          const thisSeq = ++seq;
          await new Promise<void>((resolve, reject) => {
            pendingIframeWrites.set(requestId + ':' + thisSeq, { resolve, reject });
            window.top.postMessage({
              type: LIBREGRAB_WRITE_CHUNK,
              requestId,
              seq: thisSeq,
              arrayBuffer,
            }, origin, [arrayBuffer]);
          });
        },
        async close() {
          if (proxyClosed) return;
          proxyClosed = true;
          await new Promise<void>((resolve, reject) => {
            pendingIframeWrites.set(requestId + ':close', { resolve, reject });
            window.top.postMessage({
              type: LIBREGRAB_WRITE_CLOSE,
              requestId,
            }, origin);
          });
        },
        async seek(position: number) {
          if (proxyClosed) throw new Error('Proxy writable already closed');
          const seekRequestId = libregrabRequestId();
          await new Promise<void>((resolve, reject) => {
            pendingIframeSeeks.set(seekRequestId, { resolve, reject });
            window.top.postMessage({
              type: LIBREGRAB_WRITE_SEEK,
              requestId: seekRequestId,
              position,
            }, origin);
          });
        },
        abort() {
          return this.close();
        },
      };
    },
    async createSyncAccessHandle() {
      throw new Error('createSyncAccessHandle is not available across frames');
    },
  };
}

export async function pickSaveFile(suggestedName: string, types: Array<{ description: string; accept: Record<string, string[]> }>): Promise<SaveHandle> {
  if (window.top !== window.self) {
    return createProxySaveHandle(suggestedName, types, document.createElement('div')) as unknown as SaveHandle;
  }
  const w = pageWindow();
  const picker = w.showSaveFilePicker;
  if (typeof picker !== 'function') {
    throw new Error('File System Access API is not available on this window');
  }
  return picker.call(w, { suggestedName, types });
}

interface BuildAudiobookOptions {
  urls: Array<{ url: string; index: number; duration: number; size: number; type: string }>;
  metadata: { chapters?: Array<{ chapter_number: number }> };
  coverBytes: Uint8Array | null;
  coverMime: string | null;
  fileHandle: SaveHandle;
  progress: (msg: string) => void;
  fetchWithRetry: (url: string, opts: RequestInit, label: string, progress: (msg: string) => void, maxAttempts?: number) => Promise<Response>;
  BIF: { map: { title: { main: string }; series?: string[] }; map: { creator: Array<{ name: string; role: string }> } };
  getAuthorString: () => string;
  getNarratorString: () => string;
}

export async function buildAudiobookSingleMp3(options: BuildAudiobookOptions): Promise<boolean> {
  const { urls, metadata, coverBytes, coverMime, fileHandle, progress, fetchWithRetry, BIF, getAuthorString, getNarratorString } = options;
  const totalChapters = metadata.chapters ? metadata.chapters.length : urls.length;
  const displayTitle = BIF.map.title.main;
  const author = getAuthorString();
  const narrator = getNarratorString();

  progress('<b>Streaming single MP3...</b>');

  const buildTagOptions: BuildBookId3TagOptions = {
    book: BIF.map,
    displayTitle,
    author,
    narrator,
    seriesName: (BIF.map.series && BIF.map.series[0]) || null,
    seriesIndex: null,
    chapters: metadata.chapters || [],
    durationByChapter: Object.fromEntries(urls.map((u) => [u.index, u.duration * 1000])),
    coverBytes,
    coverMime,
  };
  const { tag, totalDurationMs } = buildBookId3Tag(buildTagOptions);
  progress(`Wrote ID3v2 tag (${tag.length} bytes) with ${totalChapters} CHAP frames, duration ${(totalDurationMs / 3600000).toFixed(2)} h.`);

  async function fetchChapterAudio(url: { url: string; index: number }): Promise<Uint8Array> {
    const label = `chapter ${url.index}`;
    const res = await fetchWithRetry(url.url, { method: 'GET' }, label, progress);
    return stripId3(new Uint8Array(await res.arrayBuffer()));
  }

  const firstRaw = await fetchChapterAudio(urls[0]);
  const proto = parseMpegHeader(firstRaw, 0);
  if (!proto) throw new Error(`chapter ${urls[0].index} did not start with a valid MPEG frame`);

  const placeholderXing = makeXingFrame(proto, 0, 0);
  const writable = await fileHandle.createWritable();
  let audioBytes = 0;
  let audioFrames = 0;

  try {
    await writable.write(tag);
    await writable.write(placeholderXing);

    let pending = Promise.resolve(firstRaw);
    for (let i = 0; i < urls.length; i++) {
      const raw = await pending;
      if (i + 1 < urls.length) pending = fetchChapterAudio(urls[i + 1]);
      const audio = stripXingFrame(raw);
      if (!audio.length) throw new Error(`chapter ${urls[i].index} had no MPEG frames after header strip`);
      const frames = countMpegFrames(audio);
      audioFrames += frames;
      audioBytes += audio.length;
      await writable.write(audio);
      progress(`Appended ${i + 1}/${urls.length} (chapter ${urls[i].index}, ${frames} frames, ${(audioBytes / 1e6).toFixed(1)} MB audio)`);
    }

    const totalFrames = audioFrames + 1;
    const totalBytes = audioBytes + placeholderXing.length;
    const finalXing = makeXingFrame(proto, totalFrames, totalBytes);
    if (finalXing.length !== placeholderXing.length) {
      throw new Error('Xing frame length changed between placeholder and final write');
    }
    
    // Try to patch Xing header with retries
    progress(`Attempting to patch Xing header at position ${tag.length}...`);
    let seekSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const timeoutMs = 30000 * attempt; // 30s, 60s, 90s
      try {
        await Promise.race([
          writable.seek(tag.length),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('seek timeout')), timeoutMs)
          ),
        ]);
        progress(`Seek succeeded (attempt ${attempt}), writing final Xing...`);
        await writable.write(finalXing);
        progress(`Patched Xing header: ${totalFrames} frames, ${totalBytes} bytes (seek table rebuilt).`);
        seekSuccess = true;
        break;
      } catch (seekError) {
        progress(`Xing patch attempt ${attempt}/3 failed: ${(seekError as Error).message}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
    if (!seekSuccess) {
      // Fallback: try writing Xing at current position (end of file)
      // This won't create a valid Xing header but file will be playable
      progress(`NOTE: Xing header patch failed after 3 attempts; writing Xing at end of file as fallback.`);
      try {
        await writable.write(finalXing);
        progress(`Wrote Xing frame at end of file (not a valid seek table).`);
      } catch (e) {
        progress(`NOTE: Fallback Xing write also failed: ${(e as Error).message}`);
      }
    }
    progress(`Closing writable...`);
    let closed = false;
    try {
      await writable.close();
      closed = true;
      progress(`Writable closed successfully.`);
    } catch (closeError) {
      if (!(closeError as Error).message.includes('closed or closing')) {
        throw closeError;
      }
      progress(`Writable already closed.`);
    }
  } catch (e) {
    if (!closed) {
      try { await writable.close(); } catch {}
    }
    throw new Error(
      `Aborted single-MP3 after ${(audioBytes / 1e6).toFixed(1)} MB. ` +
      `A partial file may remain. ${(e as Error).message}`
    );
  }

  if (!closed) {
    await writable.close();
    progress(`Writable closed successfully.`);
  }
  progress(`<b>Done! Single MP3 on disk (${(audioBytes / 1e6).toFixed(1)} MB audio + ${tag.length} byte ID3 + Xing). Duration should match TLEN/CHAP without bitrate guessing.</b>`);
  return true;
}