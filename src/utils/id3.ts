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

function u32be(n: number): Uint8Array {
  n >>>= 0;
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function writeU32be(u8: Uint8Array, offset: number, n: number): void {
  n >>>= 0;
  u8[offset] = (n >>> 24) & 0xff;
  u8[offset + 1] = (n >>> 16) & 0xff;
  u8[offset + 2] = (n >>> 8) & 0xff;
  u8[offset + 3] = n & 0xff;
}

function synchsafe(n: number): Uint8Array {
  n >>>= 0;
  return new Uint8Array([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}

function latin1(str: string): Uint8Array {
  const s = String(str ?? '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function utf16beBom(str: string): Uint8Array {
  const s = String(str ?? '');
  const out = new Uint8Array(2 + s.length * 2 + 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = (c >> 8) & 0xff;
    out[3 + i * 2] = c & 0xff;
  }
  return out;
}

function id3Frame(id: string, payload: Uint8Array): Uint8Array {
  return concatBytes([latin1(id), u32be(payload.length), new Uint8Array([0, 0]), payload]);
}

export function textFrame(id: string, text: string): Uint8Array {
  return id3Frame(id, concatBytes([new Uint8Array([1]), utf16beBom(text)]));
}

export function commFrame(text: string, language = 'eng'): Uint8Array {
  return id3Frame('COMM', concatBytes([
    new Uint8Array([1]),
    latin1(language.slice(0, 3).padEnd(3, ' ')),
    utf16beBom(''),
    utf16beBom(String(text ?? '')),
  ]));
}

export function apicFrame(coverBytes: Uint8Array, mime: string): Uint8Array {
  return id3Frame('APIC', concatBytes([
    new Uint8Array([1]),
    latin1(mime || 'image/jpeg'),
    new Uint8Array([0, 3]),
    utf16beBom('Cover'),
    coverBytes,
  ]));
}

function chapFrame(id: string, startMs: number, endMs: number, title: string): Uint8Array {
  return id3Frame('CHAP', concatBytes([
    latin1(id),
    new Uint8Array([0]),
    u32be(startMs),
    u32be(endMs),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    textFrame('TIT2', title),
  ]));
}

function ctocFrame(id: string, childIds: string[], description: string): Uint8Array {
  const kids: Uint8Array[] = [];
  for (const cid of childIds) {
    kids.push(latin1(cid));
    kids.push(new Uint8Array([0]));
  }
  return id3Frame('CTOC', concatBytes([
    latin1(id),
    new Uint8Array([0, 0x03, childIds.length & 0xff]),
    concatBytes(kids),
    textFrame('TIT2', description),
  ]));
}

function buildId3Tag(frames: Uint8Array[]): Uint8Array {
  const body = concatBytes(frames);
  return concatBytes([latin1('ID3'), new Uint8Array([0x03, 0x00, 0x00]), synchsafe(body.length), body]);
}

export function stripId3(buf: Uint8Array | ArrayBuffer): Uint8Array {
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

export function writeId3(mp3Buffer: Uint8Array | ArrayBuffer, frames: Uint8Array[]): Uint8Array {
  return concatBytes([buildId3Tag(frames), stripId3(mp3Buffer)]);
}

export function chapterTitleFor(chapterNumber: number, displayTitle: string): string {
  return chapterNumber === 0 ? `${displayTitle} - Opening Credits` : `Chapter ${chapterNumber}`;
}

export interface BuildBookId3TagOptions {
  book: { street_date?: string; description?: string; series?: string[] };
  displayTitle: string;
  author: string;
  narrator?: string;
  seriesName?: string | null;
  seriesIndex?: number | null;
  chapters: Array<{ chapter_number: number }>;
  durationByChapter: Record<number, number>;
  coverBytes?: Uint8Array | null;
  coverMime?: string | null;
}

export function buildBookId3Tag(options: BuildBookId3TagOptions): { tag: Uint8Array; totalDurationMs: number } {
  const { book, displayTitle, author, narrator, seriesName, seriesIndex, chapters, durationByChapter, coverBytes, coverMime } = options;
  let cursor = 0;
  const chapFrames: Uint8Array[] = [];
  const childIds: string[] = [];
  chapters.forEach((ch, i) => {
    const dur = Number(durationByChapter[ch.chapter_number]) || 0;
    const start = cursor;
    const end = cursor + dur;
    const cid = i === chapters.length - 1 ? 'last' : `ch${i + 1}`;
    childIds.push(cid);
    chapFrames.push(chapFrame(cid, start, end, chapterTitleFor(ch.chapter_number, displayTitle)));
    cursor = end;
  });

  const frames: Uint8Array[] = [
    textFrame('TIT2', displayTitle),
    textFrame('TALB', displayTitle),
    textFrame('TPE1', author),
    textFrame('TRCK', '1/1'),
    textFrame('TCON', 'Audiobook'),
    textFrame('TSSE', 'LibreGRAB'),
  ];
  if (narrator) {
    frames.push(textFrame('TPE2', narrator));
    frames.push(textFrame('TCOM', narrator));
  }
  if (seriesIndex) frames.push(textFrame('TPOS', String(seriesIndex)));
  if (seriesName) frames.push(textFrame('TXXX', { description: 'Series', value: seriesName }));
  if (book.street_date) {
    const yearMatch = String(book.street_date).match(/^(\d{4})/);
    if (yearMatch) frames.push(textFrame('TYER', yearMatch[1]));
  }
  if (cursor) frames.push(textFrame('TLEN', String(Math.round(cursor))));
  if (book.description) frames.push(commFrame(book.description));
  frames.push(commFrame('Audiobook exported by LibreGRAB from Libby.', 'eng'));
  if (coverBytes && coverBytes.length) frames.push(apicFrame(coverBytes, coverMime!));
  if (childIds.length) {
    frames.push(ctocFrame('toc', childIds, 'Table of Contents'));
    frames.push(...chapFrames);
  }
  return { tag: buildId3Tag(frames), totalDurationMs: cursor };
}

export interface TagChapterMp3Options {
  book: { street_date?: string; description?: string; series?: string[] };
  displayTitle: string;
  author: string;
  narrator?: string;
  seriesName?: string | null;
  seriesIndex?: number | null;
  chapterNumber: number;
  totalChapters?: number;
  durationMs?: number;
  coverBytes?: Uint8Array | null;
  coverMime?: string | null;
  progress?: (msg: string) => void;
}

export function tagChapterMp3(arrayBuffer: ArrayBuffer, options: TagChapterMp3Options): Blob {
  const { book, displayTitle, author, narrator, seriesName, seriesIndex, chapterNumber, totalChapters, durationMs, coverBytes, coverMime, progress } = options;
  try {
    const frames: Uint8Array[] = [
      textFrame('TIT2', chapterTitleFor(chapterNumber, displayTitle)),
      textFrame('TALB', displayTitle),
      textFrame('TPE1', author),
      textFrame('TRCK', totalChapters ? `${chapterNumber}/${totalChapters}` : String(chapterNumber)),
      textFrame('TCON', 'Audiobook'),
      textFrame('TSSE', 'LibreGRAB'),
    ];
    if (narrator) {
      frames.push(textFrame('TPE2', narrator));
      frames.push(textFrame('TCOM', narrator));
    }
    if (seriesIndex) frames.push(textFrame('TPOS', String(seriesIndex)));
    if (seriesName) frames.push(textFrame('TXXX', { description: 'Series', value: seriesName }));
    if (book.street_date) {
      const yearMatch = String(book.street_date).match(/^(\d{4})/);
      if (yearMatch) frames.push(textFrame('TYER', yearMatch[1]));
    }
    if (durationMs) frames.push(textFrame('TLEN', String(Math.round(durationMs))));
    if (coverBytes && coverBytes.length) frames.push(apicFrame(coverBytes, coverMime!));
    if (book.description) frames.push(commFrame(book.description));
    frames.push(commFrame('Audiobook exported by LibreGRAB from Libby.', 'eng'));
    return new Blob([writeId3(arrayBuffer, frames)], { type: 'audio/mpeg' });
  } catch (e) {
    if (progress) progress(`  NOTE: ID3 tagging failed for chapter ${chapterNumber} (file kept untagged): ${(e as Error).message}`);
    return new Blob([arrayBuffer], { type: 'audio/mpeg' });
  }
}