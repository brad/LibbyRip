// ID3v2 tag parser for reading existing ID3 tags from MP3 files

export interface ParsedId3Frame {
  id: string;
  size: number;
  flags: number;
  data: Uint8Array;
}

export interface ParsedChapter {
  id: string;
  startMs: number;
  endMs: number;
  title: string;
}

export interface ParsedId3Tag {
  version: { major: number; minor: number };
  flags: number;
  size: number;
  frames: ParsedId3Frame[];
  chapters: ParsedChapter[];
  toc?: { id: string; childIds: string[]; description: string };
  metadata: {
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
  };
}

function readU32be(u8: Uint8Array, offset: number): number {
  return (u8[offset] << 24) | (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3];
}

function readSynchsafe(u8: Uint8Array, offset: number): number {
  return ((u8[offset] & 0x7f) << 21) | ((u8[offset + 1] & 0x7f) << 14) | ((u8[offset + 2] & 0x7f) << 7) | (u8[offset + 3] & 0x7f);
}

function readLatin1(u8: Uint8Array, offset: number, length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    if (u8[offset + i] === 0) break;
    result += String.fromCharCode(u8[offset + i]);
  }
  return result;
}

function readUtf16(u8: Uint8Array, offset: number, length: number): string {
  // Check for BOM
  if (length < 2) return '';
  
  const bom = (u8[offset] << 8) | u8[offset + 1];
  let littleEndian = false;
  let start = offset;
  
  if (bom === 0xfffe) {
    littleEndian = true;
    start += 2;
    length -= 2;
  } else if (bom === 0xfeff) {
    littleEndian = false;
    start += 2;
    length -= 2;
  }
  
  let result = '';
  for (let i = start; i < start + length - 1; i += 2) {
    let char = littleEndian 
      ? (u8[i + 1] << 8) | u8[i]
      : (u8[i] << 8) | u8[i + 1];
    if (char === 0) break;
    result += String.fromCharCode(char);
  }
  return result;
}

function readTextFrame(data: Uint8Array): string {
  if (data.length === 0) return '';
  const encoding = data[0];
  
  if (encoding === 0) {
    // ISO-8859-1
    return readLatin1(data, 1, data.length - 1);
  } else if (encoding === 1) {
    // UTF-16 with BOM
    return readUtf16(data, 1, data.length - 1);
  } else if (encoding === 3) {
    // UTF-8
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(data.subarray(1));
  }
  
  return readLatin1(data, 1, data.length - 1);
}

function parseChapterFrame(data: Uint8Array): ParsedChapter | null {
  // CHAP frame format:
  // Element ID (null terminated string)
  // Start time (4 bytes)
  // End time (4 bytes)
  // Start offset (4 bytes, 0xFFFFFFFF if not used)
  // End offset (4 bytes, 0xFFFFFFFF if not used)
  // Optional subframes (TIT2 for title, etc.)
  
  let offset = 0;
  
  // Read element ID
  let idEnd = offset;
  while (idEnd < data.length && data[idEnd] !== 0) idEnd++;
  const id = readLatin1(data, offset, idEnd - offset);
  offset = idEnd + 1;
  
  if (offset + 16 > data.length) return null;
  
  const startMs = readU32be(data, offset);
  offset += 4;
  const endMs = readU32be(data, offset);
  offset += 4;
  offset += 8; // Skip byte offsets
  
  let title = id;
  
  // Parse subframes to find TIT2 (title)
  while (offset + 10 < data.length) {
    const frameId = readLatin1(data, offset, 4);
    offset += 4;
    const frameSize = readU32be(data, offset);
    offset += 4;
    const frameFlags = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    
    if (offset + frameSize > data.length) break;
    
    if (frameId === 'TIT2') {
      title = readTextFrame(data.subarray(offset, offset + frameSize));
    }
    
    offset += frameSize;
  }
  
  return { id, startMs, endMs, title };
}

function parseCtocFrame(data: Uint8Array): { id: string; childIds: string[]; description: string } | null {
  // CTOC frame format:
  // Element ID (null terminated)
  // Flags (1 byte)
  // Entry count (1 byte)
  // Child element IDs (null terminated strings)
  // Optional subframes
  
  let offset = 0;
  
  // Read element ID
  let idEnd = offset;
  while (idEnd < data.length && data[idEnd] !== 0) idEnd++;
  const id = readLatin1(data, offset, idEnd - offset);
  offset = idEnd + 1;
  
  if (offset + 2 > data.length) return null;
  
  const flags = data[offset];
  offset++;
  const entryCount = data[offset];
  offset++;
  
  // Read child IDs
  const childIds: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    let childIdEnd = offset;
    while (childIdEnd < data.length && data[childIdEnd] !== 0) childIdEnd++;
    childIds.push(readLatin1(data, offset, childIdEnd - offset));
    offset = childIdEnd + 1;
  }
  
  let description = '';
  
  // Parse subframes to find TIT2 (description)
  while (offset + 10 < data.length) {
    const frameId = readLatin1(data, offset, 4);
    offset += 4;
    const frameSize = readU32be(data, offset);
    offset += 4;
    offset += 2; // Skip flags
    
    if (offset + frameSize > data.length) break;
    
    if (frameId === 'TIT2') {
      description = readTextFrame(data.subarray(offset, offset + frameSize));
    }
    
    offset += frameSize;
  }
  
  return { id, childIds, description };
}

export function parseId3Tag(buffer: ArrayBuffer): ParsedId3Tag | null {
  const u8 = new Uint8Array(buffer);
  
  // Check for ID3v2 header
  if (u8.length < 10) return null;
  if (u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null; // "ID3"
  
  const majorVersion = u8[3];
  const minorVersion = u8[4];
  const flags = u8[5];
  const size = readSynchsafe(u8, 6);
  
  if (10 + size > u8.length) return null;
  
  const frames: ParsedId3Frame[] = [];
  const chapters: ParsedChapter[] = [];
  let toc: { id: string; childIds: string[]; description: string } | undefined;
  
  const metadata: ParsedId3Tag['metadata'] = {};
  
  let offset = 10;
  const tagEnd = 10 + size;
  
  // Parse frames
  while (offset + 10 < tagEnd) {
    const frameId = readLatin1(u8, offset, 4);
    if (frameId === '\0\0\0\0' || frameId.length === 0) break; // Padding
    
    offset += 4;
    const frameSize = majorVersion >= 4 ? readSynchsafe(u8, offset) : readU32be(u8, offset);
    offset += 4;
    const frameFlags = (u8[offset] << 8) | u8[offset + 1];
    offset += 2;
    
    if (offset + frameSize > tagEnd) break;
    
    const frameData = u8.subarray(offset, offset + frameSize);
    frames.push({ id: frameId, size: frameSize, flags: frameFlags, data: frameData });
    
    // Parse common text frames
    if (frameId === 'TIT2') {
      metadata.title = readTextFrame(frameData);
    } else if (frameId === 'TALB') {
      metadata.album = readTextFrame(frameData);
    } else if (frameId === 'TPE1') {
      metadata.artist = readTextFrame(frameData);
    } else if (frameId === 'TPE2') {
      metadata.albumArtist = readTextFrame(frameData);
    } else if (frameId === 'TYER') {
      metadata.year = readTextFrame(frameData);
    } else if (frameId === 'TRCK') {
      metadata.trackNumber = readTextFrame(frameData);
    } else if (frameId === 'TLEN') {
      const lenStr = readTextFrame(frameData);
      metadata.duration = parseInt(lenStr, 10);
    } else if (frameId === 'TCON') {
      metadata.genre = readTextFrame(frameData);
    } else if (frameId === 'TCOM') {
      metadata.composer = readTextFrame(frameData);
    } else if (frameId === 'COMM') {
      // Comment frame has encoding, language, short description, then text
      if (frameData.length > 4) {
        const encoding = frameData[0];
        // Skip language (3 bytes) and short description (null terminated)
        let commentOffset = 4;
        while (commentOffset < frameData.length && frameData[commentOffset] !== 0) commentOffset++;
        commentOffset++;
        if (commentOffset < frameData.length) {
          if (encoding === 0) {
            metadata.comment = readLatin1(frameData, commentOffset, frameData.length - commentOffset);
          } else if (encoding === 1) {
            metadata.comment = readUtf16(frameData, commentOffset, frameData.length - commentOffset);
          }
        }
      }
    } else if (frameId === 'CHAP') {
      const chapter = parseChapterFrame(frameData);
      if (chapter) chapters.push(chapter);
    } else if (frameId === 'CTOC') {
      const parsedToc = parseCtocFrame(frameData);
      if (parsedToc) toc = parsedToc;
    }
    
    offset += frameSize;
  }
  
  return {
    version: { major: majorVersion, minor: minorVersion },
    flags,
    size,
    frames,
    chapters,
    toc,
    metadata,
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
