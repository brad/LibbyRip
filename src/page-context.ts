import { buildBookId3Tag, tagChapterMp3, chapterTitleFor, writeId3 } from './utils/id3.js';
import { parseMpegHeader, countMpegFrames, stripXingFrame, makeXingFrame } from './utils/mpeg.js';
import { gmFetchBlob, fetchWithRetry, fetchCover, safeFilename } from './utils/fetch.js';
import { getMetadata, getAuthorString, getNarratorString, createMetadata, type BIF } from './libby/bif.js';
import { getUrls } from './libby/urls.js';
import { pickSaveFile, requestSaveFromTopFrame, buildAudiobookSingleMp3, handleIframeDataMessage, requestFromIframe, setupIframeApi, setupIframeFetchHandler } from './utils/download.js';
import { createAndDownloadMp3, exportChapters } from './libby/chapters.js';
import { getDownloadZip } from './zip/client-zip.js';
import { parseId3Tag, formatDuration, type ParsedId3Tag } from './utils/id3-parser.js';

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
.libregrab-btn.debug { background: #ff9500; }
.libregrab-btn.debug:hover { background: #e68600; }
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
.libregrab-debug-close:hover { background: #c82333; }
.libregrab-debug-section {
    margin-bottom: 24px;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 16px;
    background: #f8f9fa;
}
.libregrab-debug-section h3 {
    margin: 0 0 12px 0;
    font-size: 18px;
    color: #0066cc;
}
.libregrab-debug-table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    background: white;
    table-layout: fixed;
}
.libregrab-debug-table th,
.libregrab-debug-table td {
    border: 1px solid #ddd;
    padding: 8px 12px;
    text-align: left;
}
.libregrab-debug-table th {
    background: #e9ecef;
    font-weight: 600;
}
.libregrab-debug-table th:nth-child(1),
.libregrab-debug-table td:nth-child(1) { width: 180px; }
.libregrab-debug-table th:nth-child(4),
.libregrab-debug-table td:nth-child(4) { width: 140px; white-space: nowrap; }
.libregrab-debug-table tr:nth-child(even) {
    background: #f8f9fa;
}
.libregrab-debug-diff {
    color: #dc3545;
    font-weight: 600;
}
.libregrab-debug-match {
    color: #28a745;
}
.libregrab-debug-missing {
    color: #ffc107;
    font-style: italic;
}
.libregrab-debug-actions {
    margin-top: 20px;
    display: flex;
    gap: 12px;
}
.libregrab-debug-btn {
    background: #28a745;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 12px 24px;
    cursor: pointer;
    font-size: 16px;
    font-weight: 600;
}
.libregrab-debug-btn:hover { background: #1e7e34; }
.libregrab-debug-btn:disabled {
    background: #6c757d;
    cursor: not-allowed;
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
    <button class="libregrab-btn debug" id="libregrab-btn-debug">Mp3 Debug</button>
  `;
  document.body.appendChild(ui);

  ui.querySelector('#libregrab-btn-mp3')!.onclick = exportMP3;
  ui.querySelector('#libregrab-btn-zip')!.onclick = exportChaptersHandler;
  ui.querySelector('#libregrab-btn-chapters')!.onclick = viewChapters;
  ui.querySelector('#libregrab-btn-debug')!.onclick = openMp3Debug;

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

  // Debug modal
  const debugModal = document.createElement('div');
  debugModal.className = 'libregrab-debug-modal';
  debugModal.id = 'libregrab-debug-modal';
  debugModal.innerHTML = `
    <div class="libregrab-debug-content">
      <div class="libregrab-debug-header">
        <h2>MP3 Debug - ID3 vs BIF Comparison</h2>
        <button class="libregrab-debug-close" id="libregrab-debug-close-btn">Close</button>
      </div>
      <div id="libregrab-debug-body"></div>
    </div>
  `;
  document.body.appendChild(debugModal);

  debugModal.querySelector('#libregrab-debug-close-btn')!.onclick = () => {
    debugModal.classList.remove('active');
  };

  // Click outside to close
  debugModal.onclick = (e) => {
    if (e.target === debugModal) {
      debugModal.classList.remove('active');
    }
  };
}

let currentMp3File: File | null = null;
let currentMp3Data: Uint8Array | null = null;
let currentId3Data: ParsedId3Tag | null = null;

async function openMp3Debug(): Promise<void> {
  console.log('[LibbyRip] Opening MP3 Debug');
  
  // Create file input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mp3,audio/mpeg';
  
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return;
    
    const file = input.files[0];
    console.log('[LibbyRip] Selected file:', file.name, file.size);
    
    try {
      // Only read first 1MB for ID3 parsing (tags are typically < 500KB)
      const maxId3Size = 1024 * 1024; // 1MB
      const readSize = Math.min(file.size, maxId3Size);
      const headerBlob = file.slice(0, readSize);
      const headerBuffer = await headerBlob.arrayBuffer();
      
      // Store reference to full file for later if needed
      currentMp3File = file;
      currentMp3Data = null; // Don't load full file into memory yet
      
      // Parse ID3 tags from header only
      currentId3Data = parseId3Tag(headerBuffer);
      
      if (!currentId3Data) {
        alert('Could not parse ID3 tags from this MP3 file.');
        return;
      }
      
      console.log('[LibbyRip] Parsed ID3:', currentId3Data);
      
      // Get BIF metadata from iframe
      const iframe = document.querySelector('iframe[src*="listen.libbyapp.com"]') as HTMLIFrameElement | null;
      if (!iframe) {
        alert('Audiobook player iframe not found. Please open the audiobook player first.');
        return;
      }
      
      const { metadata } = await requestFromIframe<{ metadata: any }>('LIBREGRAB_GET_URLS');
      const { author, narrator } = await requestFromIframe<{ author: string; narrator: string }>('LIBREGRAB_GET_CREATORS');
      
      console.log('[LibbyRip] BIF metadata:', metadata);
      
      // Show comparison
      showDebugComparison(currentId3Data, metadata, author, narrator);
      
    } catch (e) {
      console.error('[LibbyRip] MP3 Debug error:', e);
      alert('Error reading MP3 file: ' + (e as Error).message);
    }
  };
  
  input.click();
}

function showDebugComparison(id3: ParsedId3Tag, bifMetadata: any, author: string, narrator: string): void {
  const modal = document.getElementById('libregrab-debug-modal');
  const body = document.getElementById('libregrab-debug-body');
  
  if (!modal || !body) return;
  
  let html = '';
  
  // Basic metadata comparison
  html += '<div class="libregrab-debug-section">';
  html += '<h3>Basic Metadata</h3>';
  html += '<table class="libregrab-debug-table">';
  html += '<tr><th>Field</th><th>ID3 Value</th><th>BIF Value</th><th>Status</th></tr>';
  
  const metadataFields = [
    { name: 'Title', id3: id3.metadata.title, bif: bifMetadata.title },
    { name: 'Artist', id3: id3.metadata.artist, bif: author },
    { name: 'Album', id3: id3.metadata.album, bif: bifMetadata.title },
    { name: 'Album Artist', id3: id3.metadata.albumArtist, bif: narrator },
    { name: 'Composer', id3: id3.metadata.composer, bif: narrator },
    { name: 'Genre', id3: id3.metadata.genre, bif: 'Audiobook' },
    { name: 'Description', id3: id3.metadata.comment, bif: typeof bifMetadata.description === 'string' ? bifMetadata.description : (bifMetadata.description?.short || bifMetadata.description?.full || '') },
  ];
  
  for (const field of metadataFields) {
    const match = field.id3 === field.bif;
    const status = match ? '<span class="libregrab-debug-match">✓ Match</span>' : '<span class="libregrab-debug-diff">✗ Different</span>';
    html += `<tr>
      <td><strong>${field.name}</strong></td>
      <td>${field.id3 || '<span class="libregrab-debug-missing">Not set</span>'}</td>
      <td>${field.bif || '<span class="libregrab-debug-missing">Not available</span>'}</td>
      <td>${status}</td>
    </tr>`;
  }
  
  html += '</table>';
  html += '</div>';
  
  // Chapter comparison
  html += '<div class="libregrab-debug-section">';
  html += '<h3>Chapter Markers (CHAP frames)</h3>';
  
  const id3ChapterCount = id3.chapters.length;
  const bifChapterCount = bifMetadata.chapters ? bifMetadata.chapters.length : 0;
  
  html += `<p><strong>ID3 Chapters:</strong> ${id3ChapterCount}</p>`;
  html += `<p><strong>BIF Chapters:</strong> ${bifChapterCount}</p>`;
  
  if (id3ChapterCount > 0) {
    html += '<h4>ID3 Chapter Details:</h4>';
    html += '<table class="libregrab-debug-table">';
    html += '<tr><th>#</th><th>ID</th><th>Start Time</th><th>End Time</th><th>Duration</th><th>Title</th></tr>';
    
    id3.chapters.forEach((chap, i) => {
      const duration = chap.endMs - chap.startMs;
      html += `<tr>
        <td>${i + 1}</td>
        <td><code>${chap.id}</code></td>
        <td>${formatDuration(chap.startMs)}</td>
        <td>${formatDuration(chap.endMs)}</td>
        <td>${formatDuration(duration)}</td>
        <td>${chap.title}</td>
      </tr>`;
    });
    
    html += '</table>';
  } else {
    html += '<p class="libregrab-debug-missing">⚠ No CHAP frames found in ID3 tags</p>';
  }
  
  if (bifChapterCount > 0 && bifMetadata.chapters) {
    html += '<h4>BIF Chapter Details:</h4>';
    html += '<table class="libregrab-debug-table">';
    html += '<tr><th>#</th><th>Title</th><th>Spine</th><th>Offset (s)</th></tr>';
    
    bifMetadata.chapters.forEach((chap: any, i: number) => {
      html += `<tr>
        <td>${i + 1}</td>
        <td>${chap.title}</td>
        <td>${chap.spine}</td>
        <td>${chap.offset}</td>
      </tr>`;
    });
    
    html += '</table>';
  }
  
  html += '</div>';
  
  // Table of Contents (CTOC)
  if (id3.toc) {
    html += '<div class="libregrab-debug-section">';
    html += '<h3>Table of Contents (CTOC frame)</h3>';
    html += `<p><strong>TOC ID:</strong> <code>${id3.toc.id}</code></p>`;
    html += `<p><strong>Description:</strong> ${id3.toc.description}</p>`;
    html += `<p><strong>Child IDs:</strong> ${id3.toc.childIds.join(', ')}</p>`;
    html += '</div>';
  } else {
    html += '<div class="libregrab-debug-section">';
    html += '<h3>Table of Contents (CTOC frame)</h3>';
    html += '<p class="libregrab-debug-missing">⚠ No CTOC frame found in ID3 tags</p>';
    html += '</div>';
  }
  
  // Duration comparison
  html += '<div class="libregrab-debug-section">';
  html += '<h3>Duration</h3>';
  html += '<table class="libregrab-debug-table">';
  html += '<tr><th>Source</th><th>Duration</th></tr>';
  
  if (id3.metadata.duration) {
    html += `<tr><td>ID3 TLEN frame</td><td>${formatDuration(id3.metadata.duration)}</td></tr>`;
  } else {
    html += `<tr><td>ID3 TLEN frame</td><td><span class="libregrab-debug-missing">Not set</span></td></tr>`;
  }
  
  if (id3ChapterCount > 0 && id3.chapters.length > 0) {
    const lastChapter = id3.chapters[id3.chapters.length - 1];
    html += `<tr><td>ID3 Chapters (last end time)</td><td>${formatDuration(lastChapter.endMs)}</td></tr>`;
  }
  
  if (bifMetadata.spine && Array.isArray(bifMetadata.spine)) {
    const totalBifDuration = bifMetadata.spine.reduce((sum: number, s: any) => sum + (s.duration || 0), 0);
    html += `<tr><td>BIF Total (spine)</td><td>${formatDuration(totalBifDuration * 1000)}</td></tr>`;
  }
  
  html += '</table>';
  html += '</div>';
  
  // Action buttons
  html += '<div class="libregrab-debug-actions">';
  
  const hasChapterMismatch = (bifChapterCount > 0 && id3ChapterCount === 0) || 
                             (bifChapterCount > 0 && id3ChapterCount !== bifChapterCount);
  
  if (hasChapterMismatch) {
    html += '<button class="libregrab-debug-btn" id="libregrab-copy-chapters-btn">Copy BIF Chapters to MP3</button>';
  }
  
  const hasMetadataMismatch = metadataFields.some(f => f.id3 !== f.bif);
  
  if (hasMetadataMismatch || hasChapterMismatch) {
    html += '<button class="libregrab-debug-btn" id="libregrab-fix-all-btn">Fix All Metadata</button>';
  }
  
  html += '</div>';
  
  body.innerHTML = html;
  
  // Attach event listeners
  const copyChaptersBtn = document.getElementById('libregrab-copy-chapters-btn');
  if (copyChaptersBtn) {
    copyChaptersBtn.onclick = () => copyBifChaptersToMp3(bifMetadata, author, narrator);
  }
  
  const fixAllBtn = document.getElementById('libregrab-fix-all-btn');
  if (fixAllBtn) {
    fixAllBtn.onclick = () => fixAllMetadata(bifMetadata, author, narrator);
  }
  
  modal.classList.add('active');
}

async function copyBifChaptersToMp3(bifMetadata: any, author: string, narrator: string): Promise<void> {
  if (!currentMp3File) {
    alert('No MP3 file loaded');
    return;
  }
  
  try {
    // Now load the full file only when user clicks the fix button
    if (!currentMp3Data) {
      console.log('[LibbyRip] Loading full MP3 file for retagging...');
      const arrayBuffer = await currentMp3File.arrayBuffer();
      currentMp3Data = new Uint8Array(arrayBuffer);
    }
    
    // Get BIF metadata for chapters
    const { urls } = await requestFromIframe<{ urls: any[] }>('LIBREGRAB_GET_URLS');
    
    console.log('[LibbyRip] Got URLs from iframe:', urls);
    console.log('[LibbyRip] BIF metadata:', bifMetadata);
    
    // Build duration by chapter from spine durations in metadata
    // bifMetadata.spine has the actual duration data
    const spineDurations: number[] = bifMetadata.spine.map((s: any) => s.duration * 1000);
    console.log('[LibbyRip] Spine durations (ms):', spineDurations);
    
    // Calculate cumulative time for each spine position
    const cumulativeSpineTimes: number[] = [0];
    for (let i = 0; i < spineDurations.length; i++) {
      cumulativeSpineTimes.push(cumulativeSpineTimes[i] + spineDurations[i]);
    }
    
    console.log('[LibbyRip] Cumulative spine times:', cumulativeSpineTimes);
    
    // If BIF has actual chapters with spine/offset, use those
    // Otherwise fall back to treating each spine as a chapter
    let chapters: Array<{ chapter_number: number; title?: string }>;
    let durationByChapter: Record<number, number>;
    
    if (bifMetadata.chapters && bifMetadata.chapters.length > 0) {
      console.log('[LibbyRip] Using BIF chapters:', bifMetadata.chapters);
      
      // BIF chapters have spine index and offset in seconds
      // Calculate duration for each chapter
      durationByChapter = {};
      chapters = bifMetadata.chapters.map((ch: any, idx: number) => {
        const chNum = idx + 1;
        const startSpine = ch.spine;
        const startOffset = ch.offset * 1000; // Convert to ms
        const startTime = cumulativeSpineTimes[startSpine] + startOffset;
        
        console.log(`[LibbyRip] Chapter ${chNum} "${ch.title}": spine ${startSpine}, offset ${ch.offset}s, startTime ${startTime}ms`);
        
        // Find end time (start of next chapter or end of book)
        let endTime: number;
        if (idx < bifMetadata.chapters.length - 1) {
          const nextCh = bifMetadata.chapters[idx + 1];
          const nextStartSpine = nextCh.spine;
          const nextStartOffset = nextCh.offset * 1000;
          endTime = cumulativeSpineTimes[nextStartSpine] + nextStartOffset;
        } else {
          // Last chapter goes to end of book
          endTime = cumulativeSpineTimes[cumulativeSpineTimes.length - 1];
        }
        
        const duration = endTime - startTime;
        console.log(`[LibbyRip] Chapter ${chNum}: endTime ${endTime}ms, duration ${duration}ms`);
        
        durationByChapter[chNum] = duration;
        
        return {
          chapter_number: chNum,
          title: ch.title
        };
      });
    } else {
      console.log('[LibbyRip] No BIF chapters found, using spine positions as chapters');
      
      // Fall back to treating each spine position as a chapter
      durationByChapter = {};
      spineDurations.forEach((dur, index) => {
        const chNum = index + 1;
        durationByChapter[chNum] = dur;
      });
      
      chapters = spineDurations.map((_, index) => ({
        chapter_number: index + 1,
      }));
    }
    
    console.log('[LibbyRip] Final durationByChapter:', durationByChapter);
    console.log('[LibbyRip] Final chapters array:', chapters);
    
    // Get cover
    let coverBytes: Uint8Array | null = null;
    let coverMime: string | null = null;
    
    if (bifMetadata.coverUrl) {
      try {
        const coverResult = await fetchCover(
          bifMetadata.coverUrl,
          (msg) => console.log('[LibbyRip]', msg)
        );
        coverBytes = coverResult.bytes;
        coverMime = coverResult.mime;
      } catch (e) {
        console.warn('[LibbyRip] Could not fetch cover:', e);
      }
    }
    
    // Build new ID3 tag with all frames
    const { tag } = buildBookId3Tag({
      book: bifMetadata,
      displayTitle: bifMetadata.title,
      author,
      narrator,
      seriesName: null,
      seriesIndex: null,
      chapters,
      durationByChapter,
      coverBytes,
      coverMime,
    });
    
    // The tag returned by buildBookId3Tag is already a complete ID3v2 tag
    // We need to strip the old ID3 and prepend the new one
    const mp3WithoutId3 = stripId3(currentMp3Data);
    const newMp3 = concatBytes([tag, mp3WithoutId3]);
    
    // Download the new file
    const blob = new Blob([newMp3], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = currentMp3File.name.replace(/\.mp3$/i, '_fixed.mp3');
    link.click();
    URL.revokeObjectURL(url);
    
    alert('New MP3 with BIF chapters saved!');
    
    // Clear the loaded data to free memory
    currentMp3Data = null;
    
  } catch (e) {
    console.error('[LibbyRip] Copy chapters error:', e);
    alert('Error copying chapters: ' + (e as Error).message);
  }
}

function concatBytes(parts: Array<Uint8Array | ArrayBuffer | number[]>): Uint8Array {
  const arrays = parts.map((p) => {
    if (p instanceof Uint8Array) return p;
    if (p instanceof ArrayBuffer) return new Uint8Array(p);
    return new Uint8Array(p);
  });
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function stripId3(buf: Uint8Array | ArrayBuffer): Uint8Array {
  let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length >= 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
    const size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
    const footer = (u8[5] & 0x10) ? 10 : 0;
    const start = 10 + size + footer;
    if (start > 0 && start < u8.length) u8 = u8.subarray(start);
  }
  if (u8.length >= 128 &&
    u8[u8.length - 128] === 0x54 &&
    u8[u8.length - 127] === 0x41 &&
    u8[u8.length - 126] === 0x47) {
    u8 = u8.subarray(0, u8.length - 128);
  }
  for (let i = 0; i < u8.length - 1; i++) {
    if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
      return i === 0 ? u8 : u8.subarray(i);
    }
  }
  return u8;
}

async function fixAllMetadata(bifMetadata: any, author: string, narrator: string): Promise<void> {
  // This just calls copyBifChaptersToMp3 since it rebuilds all metadata
  await copyBifChaptersToMp3(bifMetadata, author, narrator);
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