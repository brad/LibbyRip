/**
 * MP3 Debug tool: compare an exported MP3's ID3 tags against the BIF
 * record, and retag a file with the BIF chapters/metadata.
 *
 * Reconstructed from the behavior of the debug tool in the shipped
 * merged build (openMp3Debug / showDebugComparison /
 * copyBifChaptersToMp3 / fixAllMetadata). One deliberate deviation:
 * the original's retag path issued an unused `LIBREGRAB_GET_URLS`
 * iframe request whose result it only logged; that call is dropped so
 * retagging works on the frameless OverDrive player page, where no
 * iframe exists.
 */

import { parseId3Tag, type ParsedId3 } from '../utils/id3-parser.js';
import { buildBookId3Tag, stripId3 } from '../utils/id3.js';
import { fetchCover } from '../utils/fetch.js';
import type { BookMetadata } from '../libby/bif.js';

export interface DebugBookData {
  metadata: BookMetadata;
  author: string;
  narrator: string;
}

export type GetBookDataFn = () => Promise<{
  urls: unknown[];
  metadata: BookMetadata;
  author: string;
  narrator: string;
}>;

let debugFile: File | null = null;
let debugFileBytes: Uint8Array | null = null;
let debugParsed: ParsedId3 | null = null;

/** Milliseconds to `h:mm:ss` / `m:ss`. */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * BIF descriptions arrive as a plain string or as `{ short, full }`;
 * normalize to display text.
 */
function bifDescriptionText(description: unknown): string {
  if (typeof description === 'string') return description;
  if (description && typeof description === 'object') {
    const d = description as { short?: unknown; full?: unknown };
    if (typeof d.short === 'string') return d.short;
    if (typeof d.full === 'string') return d.full;
  }
  return '';
}

function concatBytes(parts: Array<Uint8Array | ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * Open the MP3 Debug dialog: pick a file, parse its ID3 tag, and show
 * the comparison against the current book's BIF record.
 */
export async function openMp3Debug(getBookData: GetBookDataFn): Promise<void> {
  console.log('[LibbyRip] Opening MP3 Debug');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mp3,audio/mpeg';
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    console.log('[LibbyRip] Selected file:', file.name, file.size);
    try {
      const headSize = Math.min(file.size, 1048576);
      const head = await file.slice(0, headSize).arrayBuffer();
      debugFile = file;
      debugFileBytes = null;
      debugParsed = parseId3Tag(head);
      if (!debugParsed) {
        alert('Could not parse ID3 tags from this MP3 file.');
        return;
      }
      console.log('[LibbyRip] Parsed ID3:', debugParsed);
      let metadata: BookMetadata;
      let author: string;
      let narrator: string;
      try {
        const bookData = await getBookData();
        metadata = bookData.metadata;
        author = bookData.author;
        narrator = bookData.narrator;
      } catch (e) {
        alert((e as Error).message);
        return;
      }
      console.log('[LibbyRip] BIF metadata:', metadata);
      showDebugComparison(debugParsed, metadata, author, narrator);
    } catch (e) {
      console.error('[LibbyRip] MP3 Debug error:', e);
      alert('Error reading MP3 file: ' + (e as Error).message);
    }
  };
  input.click();
}

/** Render the ID3-vs-BIF comparison modal. */
export function showDebugComparison(
  parsed: ParsedId3,
  metadata: BookMetadata,
  author: string,
  narrator: string
): void {
  let modal = document.getElementById('libregrab-debug-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'libregrab-debug-modal';
    modal.id = 'libregrab-debug-modal';
    modal.innerHTML = `
      <div class="libregrab-debug-content">
        <div class="libregrab-debug-header">
          <h2>MP3 Debug - ID3 vs BIF Comparison</h2>
          <button class="libregrab-debug-close" id="libregrab-debug-close-btn">Close</button>
        </div>
        <div id="libregrab-debug-body"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector<HTMLElement>('#libregrab-debug-close-btn')!.onclick = () => {
      modal!.classList.remove('active');
    };
    modal.onclick = (event) => {
      if (event.target === modal) modal!.classList.remove('active');
    };
  }
  const body = document.getElementById('libregrab-debug-body');
  if (!body) return;
  modal.classList.add('active');

  let html = '';
  html += '<div class="libregrab-debug-section">';
  html += '<h3>Basic Metadata</h3>';
  html += '<table class="libregrab-debug-table">';
  html += '<tr><th>Field</th><th>ID3 Value</th><th>BIF Value</th><th>Status</th></tr>';
  const fields = [
    { name: 'Title', id3: parsed.metadata.title, bif: metadata.title },
    { name: 'Artist', id3: parsed.metadata.artist, bif: author },
    { name: 'Album', id3: parsed.metadata.album, bif: metadata.title },
    { name: 'Album Artist', id3: parsed.metadata.albumArtist, bif: narrator },
    { name: 'Composer', id3: parsed.metadata.composer, bif: narrator },
    { name: 'Genre', id3: parsed.metadata.genre, bif: 'Audiobook' },
    { name: 'Description', id3: parsed.metadata.comment, bif: bifDescriptionText(metadata.description) },
  ];
  for (const field of fields) {
    const status =
      field.id3 === field.bif
        ? '<span class="libregrab-debug-match">✓ Match</span>'
        : '<span class="libregrab-debug-diff">✗ Different</span>';
    html += `<tr>
      <td><strong>${field.name}</strong></td>
      <td>${field.id3 || '<span class="libregrab-debug-missing">Not set</span>'}</td>
      <td>${field.bif || '<span class="libregrab-debug-missing">Not available</span>'}</td>
      <td>${status}</td>
    </tr>`;
  }
  html += '</table>';
  html += '</div>';

  html += '<div class="libregrab-debug-section">';
  html += '<h3>Chapter Markers (CHAP frames)</h3>';
  const id3Count = parsed.chapters.length;
  const bifCount = metadata.chapters ? metadata.chapters.length : 0;
  html += `<p><strong>ID3 Chapters:</strong> ${id3Count}</p>`;
  html += `<p><strong>BIF Chapters:</strong> ${bifCount}</p>`;
  if (id3Count > 0) {
    html += '<h4>ID3 Chapter Details:</h4>';
    html += '<table class="libregrab-debug-table">';
    html += '<tr><th>#</th><th>ID</th><th>Start Time</th><th>End Time</th><th>Duration</th><th>Title</th></tr>';
    parsed.chapters.forEach((chapter, index) => {
      const duration = chapter.endMs - chapter.startMs;
      html += `<tr>
        <td>${index + 1}</td>
        <td><code>${chapter.id}</code></td>
        <td>${formatDurationMs(chapter.startMs)}</td>
        <td>${formatDurationMs(chapter.endMs)}</td>
        <td>${formatDurationMs(duration)}</td>
        <td>${chapter.title}</td>
      </tr>`;
    });
    html += '</table>';
  } else {
    html += '<p class="libregrab-debug-missing">⚠ No CHAP frames found in ID3 tags</p>';
  }
  if (bifCount > 0 && metadata.chapters) {
    html += '<h4>BIF Chapter Details:</h4>';
    html += '<table class="libregrab-debug-table">';
    html += '<tr><th>#</th><th>Title</th><th>Spine</th><th>Offset (s)</th></tr>';
    metadata.chapters.forEach((chapter, index) => {
      html += `<tr>
        <td>${index + 1}</td>
        <td>${chapter.title}</td>
        <td>${chapter.spine}</td>
        <td>${chapter.offset}</td>
      </tr>`;
    });
    html += '</table>';
  }
  html += '</div>';

  if (parsed.toc) {
    html += '<div class="libregrab-debug-section">';
    html += '<h3>Table of Contents (CTOC frame)</h3>';
    html += `<p><strong>TOC ID:</strong> <code>${parsed.toc.id}</code></p>`;
    html += `<p><strong>Description:</strong> ${parsed.toc.description}</p>`;
    html += `<p><strong>Child IDs:</strong> ${parsed.toc.childIds.join(', ')}</p>`;
    html += '</div>';
  } else {
    html += '<div class="libregrab-debug-section">';
    html += '<h3>Table of Contents (CTOC frame)</h3>';
    html += '<p class="libregrab-debug-missing">⚠ No CTOC frame found in ID3 tags</p>';
    html += '</div>';
  }

  html += '<div class="libregrab-debug-section">';
  html += '<h3>Duration</h3>';
  html += '<table class="libregrab-debug-table">';
  html += '<tr><th>Source</th><th>Duration</th></tr>';
  if (parsed.metadata.duration) {
    html += `<tr><td>ID3 TLEN frame</td><td>${formatDurationMs(parsed.metadata.duration)}</td></tr>`;
  } else {
    html += '<tr><td>ID3 TLEN frame</td><td><span class="libregrab-debug-missing">Not set</span></td></tr>';
  }
  if (id3Count > 0 && parsed.chapters.length > 0) {
    const last = parsed.chapters[parsed.chapters.length - 1];
    html += `<tr><td>ID3 Chapters (last end time)</td><td>${formatDurationMs(last.endMs)}</td></tr>`;
  }
  if (metadata.spine && Array.isArray(metadata.spine)) {
    const totalSeconds = metadata.spine.reduce((sum, part) => sum + (part.duration || 0), 0);
    html += `<tr><td>BIF Total (spine)</td><td>${formatDurationMs(totalSeconds * 1e3)}</td></tr>`;
  }
  html += '</table>';
  html += '</div>';

  html += '<div class="libregrab-debug-actions">';
  const chaptersDiffer = (bifCount > 0 && id3Count === 0) || (bifCount > 0 && id3Count !== bifCount);
  if (chaptersDiffer) {
    html +=
      '<button class="libregrab-debug-btn" id="libregrab-copy-chapters-btn" style="background: #0066cc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin: 4px;">Copy BIF Chapters to MP3</button>';
  }
  if (fields.some((field) => field.id3 !== field.bif) || chaptersDiffer) {
    html +=
      '<button class="libregrab-debug-btn" id="libregrab-fix-all-btn" style="background: #28a745; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin: 4px;">Fix All Metadata</button>';
  }
  html += '</div>';

  body.innerHTML = html;
  const copyBtn = document.getElementById('libregrab-copy-chapters-btn');
  if (copyBtn) copyBtn.onclick = () => copyBifChaptersToMp3(metadata, author, narrator);
  const fixBtn = document.getElementById('libregrab-fix-all-btn');
  if (fixBtn) fixBtn.onclick = () => fixAllMetadata(metadata, author, narrator);
  modal.classList.add('active');
}

/**
 * Rebuild the loaded MP3's ID3 tag from the BIF record (chapters from
 * the BIF chapter list, or spine positions when the book has no chapter
 * list) and download it as `<name>_fixed.mp3`.
 */
export async function copyBifChaptersToMp3(
  metadata: BookMetadata,
  author: string,
  narrator: string
): Promise<void> {
  if (!debugFile) {
    alert('No MP3 file loaded');
    return;
  }
  try {
    if (!debugFileBytes) {
      console.log('[LibbyRip] Loading full MP3 file for retagging...');
      const buffer = await debugFile.arrayBuffer();
      debugFileBytes = new Uint8Array(buffer);
    }
    console.log('[LibbyRip] BIF metadata:', metadata);
    const spineMs = metadata.spine.map((part) => part.duration * 1e3);
    console.log('[LibbyRip] Spine durations (ms):', spineMs);
    const cumulative = [0];
    for (let i = 0; i < spineMs.length; i++) cumulative.push(cumulative[i] + spineMs[i]);
    console.log('[LibbyRip] Cumulative spine times:', cumulative);

    let chapters: Array<{ chapter_number: number; title?: string }>;
    let durationByChapter: Record<number, number>;
    if (metadata.chapters && metadata.chapters.length > 0) {
      console.log('[LibbyRip] Using BIF chapters:', metadata.chapters);
      durationByChapter = {};
      chapters = metadata.chapters.map((chapter, index) => {
        const chapterNumber = index + 1;
        const startMs = cumulative[chapter.spine] + chapter.offset * 1e3;
        console.log(
          `[LibbyRip] Chapter ${chapterNumber} "${chapter.title}": spine ${chapter.spine}, offset ${chapter.offset}s, startTime ${startMs}ms`
        );
        let endMs: number;
        if (index < metadata.chapters!.length - 1) {
          const next = metadata.chapters![index + 1];
          endMs = cumulative[next.spine] + next.offset * 1e3;
        } else {
          endMs = cumulative[cumulative.length - 1];
        }
        const duration = endMs - startMs;
        console.log(`[LibbyRip] Chapter ${chapterNumber}: endTime ${endMs}ms, duration ${duration}ms`);
        durationByChapter[chapterNumber] = duration;
        return { chapter_number: chapterNumber, title: chapter.title };
      });
    } else {
      console.log('[LibbyRip] No BIF chapters found, using spine positions as chapters');
      durationByChapter = {};
      spineMs.forEach((ms, index) => {
        durationByChapter[index + 1] = ms;
      });
      chapters = spineMs.map((_, index) => ({ chapter_number: index + 1 }));
    }
    console.log('[LibbyRip] Final durationByChapter:', durationByChapter);
    console.log('[LibbyRip] Final chapters array:', chapters);

    let coverBytes: Uint8Array | null = null;
    let coverMime: string | null = null;
    if (metadata.coverUrl) {
      try {
        const cover = await fetchCover(metadata.coverUrl, (msg) => console.log('[LibbyRip]', msg));
        coverBytes = cover.bytes;
        coverMime = cover.mime;
      } catch (e) {
        console.warn('[LibbyRip] Could not fetch cover:', e);
      }
    }

    const { tag } = buildBookId3Tag({
      book: metadata,
      displayTitle: metadata.title,
      author,
      narrator,
      seriesName: null,
      seriesIndex: null,
      chapters,
      durationByChapter,
      coverBytes,
      coverMime,
    });
    const audio = stripId3(debugFileBytes);
    const combined = concatBytes([tag, audio]);
    const blob = new Blob([combined], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = debugFile.name.replace(/\.mp3$/i, '_fixed.mp3');
    link.click();
    URL.revokeObjectURL(url);
    alert('New MP3 with BIF chapters saved!');
    debugFileBytes = null;
  } catch (e) {
    console.error('[LibbyRip] Copy chapters error:', e);
    alert('Error copying chapters: ' + (e as Error).message);
  }
}

/** Fix-all is the same rebuild: the whole tag comes from the BIF record. */
export async function fixAllMetadata(
  metadata: BookMetadata,
  author: string,
  narrator: string
): Promise<void> {
  await copyBifChaptersToMp3(metadata, author, narrator);
}
