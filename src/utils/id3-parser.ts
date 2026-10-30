/**
 * ID3v2 tag parser for the MP3 Debug tool.
 *
 * Reconstructed from the behavior of the parser in the shipped merged
 * build: reads the tag header, text frames (TIT2/TALB/TPE1/TPE2/TYER/
 * TRCK/TLEN/TCON/TCOM), COMM, CHAP chapter markers and the CTOC table of
 * contents. Frame sizes are synchsafe for v2.4+ and plain big-endian for
 * earlier versions, matching the original.
 */

export interface Id3Chapter {
  id: string;
  startMs: number;
  endMs: number;
  title: string;
}

export interface Id3Toc {
  id: string;
  childIds: string[];
  description: string;
}

export interface Id3Metadata {
  title?: string;
  album?: string;
  artist?: string;
  albumArtist?: string;
  year?: string;
  trackNumber?: string;
  duration?: number;
  genre?: string;
  composer?: string;
  comment?: string;
}

export interface ParsedId3 {
  version: { major: number; minor: number };
  flags: number;
  size: number;
  frames: Array<{ id: string; size: number; flags: number; data: Uint8Array }>;
  chapters: Id3Chapter[];
  toc?: Id3Toc;
  metadata: Id3Metadata;
}

/** Big-endian uint32. */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  );
}

/** Synchsafe uint32 (7 bits per byte). */
function readSynchsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 127) << 21) |
    ((bytes[offset + 1] & 127) << 14) |
    ((bytes[offset + 2] & 127) << 7) |
    (bytes[offset + 3] & 127)
  );
}

/** Latin-1 string of up to `length` bytes, stopping at the first NUL. */
function readLatin1(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length && bytes[offset + i] !== 0; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

/**
 * UTF-16 string: honors a BOM (FF FE = little-endian, FE FF =
 * big-endian); without a BOM defaults to big-endian. Stops at a NUL
 * code unit.
 */
function readUtf16(bytes: Uint8Array, offset: number, length: number): string {
  if (length < 2) return '';
  const first = (bytes[offset] << 8) | bytes[offset + 1];
  let littleEndian = false;
  let start = offset;
  if (first === 0xfffe) {
    littleEndian = true;
    start += 2;
    length -= 2;
  } else if (first === 0xfeff) {
    start += 2;
    length -= 2;
  }
  let out = '';
  for (let i = start; i < start + length - 1; i += 2) {
    const code = littleEndian
      ? (bytes[i + 1] << 8) | bytes[i]
      : (bytes[i] << 8) | bytes[i + 1];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Decode a text frame payload: first byte is the encoding (0 latin-1,
 * 1 UTF-16 with BOM, 3 UTF-8). Any other encoding value falls back to
 * latin-1, as in the original parser.
 */
function decodeTextFrame(data: Uint8Array): string {
  if (data.length === 0) return '';
  const encoding = data[0];
  if (encoding === 0) return readLatin1(data, 1, data.length - 1);
  if (encoding === 1) return readUtf16(data, 1, data.length - 1);
  if (encoding === 3) return new TextDecoder('utf-8').decode(data.subarray(1));
  return readLatin1(data, 1, data.length - 1);
}

/** Parse one CHAP frame: id, start/end times, 8 skipped offset bytes, TIT2 title. */
function parseChapterFrame(data: Uint8Array): Id3Chapter | null {
  let offset = 0;
  let end = offset;
  for (; end < data.length && data[end] !== 0; end++) {
    // scan for the NUL terminator
  }
  const id = readLatin1(data, offset, end - offset);
  offset = end + 1;
  if (offset + 16 > data.length) return null;
  const startMs = readUint32BE(data, offset);
  offset += 4;
  const endMs = readUint32BE(data, offset);
  offset += 4;
  offset += 8;
  let title = id;
  for (; offset + 10 < data.length; ) {
    const frameId = readLatin1(data, offset, 4);
    offset += 4;
    const frameSize = readUint32BE(data, offset);
    offset += 4;
    offset += 2; // flags
    if (offset + frameSize > data.length) break;
    if (frameId === 'TIT2') title = decodeTextFrame(data.subarray(offset, offset + frameSize));
    offset += frameSize;
  }
  return { id, startMs, endMs, title };
}

/** Parse one CTOC frame: id, flags, child ids, TIT2 description. */
function parseTocFrame(data: Uint8Array): Id3Toc | null {
  let offset = 0;
  let end = offset;
  for (; end < data.length && data[end] !== 0; end++) {
    // scan for the NUL terminator
  }
  const id = readLatin1(data, offset, end - offset);
  offset = end + 1;
  if (offset + 2 > data.length) return null;
  offset++; // flags
  const entryCount = data[offset];
  offset++;
  const childIds: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    let p = offset;
    for (; p < data.length && data[p] !== 0; p++) {
      // scan for the NUL terminator
    }
    childIds.push(readLatin1(data, offset, p - offset));
    offset = p + 1;
  }
  let description = '';
  for (; offset + 10 < data.length; ) {
    const frameId = readLatin1(data, offset, 4);
    offset += 4;
    const frameSize = readUint32BE(data, offset);
    offset += 4;
    offset += 2; // flags
    if (offset + frameSize > data.length) break;
    if (frameId === 'TIT2') description = decodeTextFrame(data.subarray(offset, offset + frameSize));
    offset += frameSize;
  }
  return { id, childIds, description };
}

/**
 * Parse the ID3v2 tag at the start of an MP3 file. Returns null when
 * the bytes hold no parseable tag. Only the first megabyte or so of a
 * file is needed: the tag lives at the very start.
 */
export function parseId3Tag(arrayBuffer: ArrayBuffer): ParsedId3 | null {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 10 || bytes[0] !== 73 || bytes[1] !== 68 || bytes[2] !== 51) {
    return null;
  }
  const major = bytes[3];
  const minor = bytes[4];
  const flags = bytes[5];
  const size = readSynchsafe(bytes, 6);
  if (10 + size > bytes.length) return null;

  const frames: ParsedId3['frames'] = [];
  const chapters: Id3Chapter[] = [];
  let toc: Id3Toc | undefined;
  const metadata: Id3Metadata = {};
  let offset = 10;
  const end = 10 + size;
  for (; offset + 10 < end; ) {
    const id = readLatin1(bytes, offset, 4);
    if (id === '\0\0\0\0' || id.length === 0) break;
    offset += 4;
    const frameSize = major >= 4 ? readSynchsafe(bytes, offset) : readUint32BE(bytes, offset);
    offset += 4;
    const frameFlags = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    if (offset + frameSize > end) break;
    const data = bytes.subarray(offset, offset + frameSize);
    frames.push({ id, size: frameSize, flags: frameFlags, data });
    if (id === 'TIT2') metadata.title = decodeTextFrame(data);
    else if (id === 'TALB') metadata.album = decodeTextFrame(data);
    else if (id === 'TPE1') metadata.artist = decodeTextFrame(data);
    else if (id === 'TPE2') metadata.albumArtist = decodeTextFrame(data);
    else if (id === 'TYER') metadata.year = decodeTextFrame(data);
    else if (id === 'TRCK') metadata.trackNumber = decodeTextFrame(data);
    else if (id === 'TLEN') {
      metadata.duration = parseInt(decodeTextFrame(data), 10);
    } else if (id === 'TCON') metadata.genre = decodeTextFrame(data);
    else if (id === 'TCOM') metadata.composer = decodeTextFrame(data);
    else if (id === 'COMM') {
      if (data.length > 4) {
        const encoding = data[0];
        let textOffset = 4;
        if (encoding === 1 || encoding === 2) {
          for (; textOffset + 1 < data.length && !(data[textOffset] === 0 && data[textOffset + 1] === 0); ) {
            textOffset += 2;
          }
          textOffset += 2;
        } else {
          for (; textOffset < data.length && data[textOffset] !== 0; textOffset++) {
            // scan past the short description
          }
          textOffset++;
        }
        if (textOffset < data.length) {
          if (encoding === 0) metadata.comment = readLatin1(data, textOffset, data.length - textOffset);
          else if (encoding === 1 || encoding === 2) {
            metadata.comment = readUtf16(data, textOffset, data.length - textOffset);
          } else if (encoding === 3) {
            metadata.comment = new TextDecoder('utf-8').decode(data.subarray(textOffset));
          }
        }
      }
    } else if (id === 'CHAP') {
      const chapter = parseChapterFrame(data);
      if (chapter) chapters.push(chapter);
    } else if (id === 'CTOC') {
      const parsed = parseTocFrame(data);
      if (parsed) toc = parsed;
    }
    offset += frameSize;
  }
  return { version: { major, minor }, flags, size, frames, chapters, toc, metadata };
}
