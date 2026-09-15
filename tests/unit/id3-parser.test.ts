import { describe, it, expect } from 'vitest';
import { parseId3Tag, formatDuration } from '../../src/utils/id3-parser.js';

describe('utils/id3-parser.ts', () => {
  function createId3v2Tag(frames: Uint8Array[]): Uint8Array {
    const frameData = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0));
    let offset = 0;
    for (const f of frames) {
      frameData.set(f, offset);
      offset += f.length;
    }
    const size = frameData.length;
    const header = new Uint8Array(10);
    header[0] = 0x49; // 'I'
    header[1] = 0x44; // 'D'
    header[2] = 0x33; // '3'
    header[3] = 0x03; // version 3
    header[4] = 0x00; // revision 0
    header[5] = 0x00; // flags
    // Synchsafe size
    header[6] = (size >> 21) & 0x7F;
    header[7] = (size >> 14) & 0x7F;
    header[8] = (size >> 7) & 0x7F;
    header[9] = size & 0x7F;
    const tag = new Uint8Array(10 + size);
    tag.set(header);
    tag.set(frameData, 10);
    return tag;
  }

  function createTextFrame(id: string, text: string): Uint8Array {
    // Create proper UTF-16BE with BOM
    const textBytes = new Uint8Array(2 + text.length * 2);
    textBytes[0] = 0xFE; // BOM
    textBytes[1] = 0xFF;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      textBytes[2 + i * 2] = (char >> 8) & 0xFF;
      textBytes[2 + i * 2 + 1] = char & 0xFF;
    }
    const payload = new Uint8Array(1 + textBytes.length);
    payload[0] = 0x01; // UTF-16BE encoding
    payload.set(textBytes, 1);
    const frame = new Uint8Array(10 + payload.length);
    new TextEncoder().encode(id).forEach((b, i) => frame[i] = b);
    frame[4] = (payload.length >> 24) & 0xFF;
    frame[5] = (payload.length >> 16) & 0xFF;
    frame[6] = (payload.length >> 8) & 0xFF;
    frame[7] = payload.length & 0xFF;
    frame[8] = 0x00;
    frame[9] = 0x00;
    frame.set(payload, 10);
    return frame;
  }

  function createCommFrame(text: string, language = 'eng'): Uint8Array {
    const encoder = new TextEncoder();
    const textBytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      textBytes[i * 2] = (char >> 8) & 0xFF;
      textBytes[i * 2 + 1] = char & 0xFF;
    }
    const langBytes = encoder.encode(language.padEnd(3, ' ').slice(0, 3));
    const payload = new Uint8Array(1 + langBytes.length + 2 + textBytes.length);
    payload[0] = 0x01; // UTF-16BE
    payload.set(langBytes, 1);
    payload[4] = 0x00; // short description null (2 bytes for UTF-16)
    payload[5] = 0x00;
    payload.set(textBytes, 6);
    const frame = new Uint8Array(10 + payload.length);
    new TextEncoder().encode('COMM').forEach((b, i) => frame[i] = b);
    frame[4] = (payload.length >> 24) & 0xFF;
    frame[5] = (payload.length >> 16) & 0xFF;
    frame[6] = (payload.length >> 8) & 0xFF;
    frame[7] = payload.length & 0xFF;
    frame[8] = 0x00;
    frame[9] = 0x00;
    frame.set(payload, 10);
    return frame;
  }

  describe('parseId3Tag', () => {
    it('returns null for non-ID3 data', () => {
      const mp3 = new Uint8Array([0xFF, 0xFB, 0x90, 0x00]);
      expect(parseId3Tag(mp3.buffer)).toBeNull();
    });

    it('parses ID3v2.3 tag with text frames', () => {
      const tag = createId3v2Tag([
        createTextFrame('TIT2', 'Test Title'),
        createTextFrame('TPE1', 'Test Artist'),
        createTextFrame('TALB', 'Test Album'),
      ]);
      const result = parseId3Tag(tag.buffer);
      expect(result).not.toBeNull();
      expect(result!.metadata.title).toBe('Test Title');
      expect(result!.metadata.artist).toBe('Test Artist');
      expect(result!.metadata.album).toBe('Test Album');
      expect(result!.version.major).toBe(3);
    });

    it('parses COMM frame', () => {
      const tag = createId3v2Tag([createCommFrame('Test comment')]);
      const result = parseId3Tag(tag.buffer);
      expect(result).not.toBeNull();
      expect(result!.metadata.comment).toBe('Test comment');
    });

    it('handles missing optional fields', () => {
      const tag = createId3v2Tag([createTextFrame('TIT2', 'Only Title')]);
      const result = parseId3Tag(tag.buffer);
      expect(result).not.toBeNull();
      expect(result!.metadata.title).toBe('Only Title');
      expect(result!.metadata.artist).toBeUndefined();
      expect(result!.metadata.album).toBeUndefined();
    });
  });

  describe('formatDuration', () => {
    it('formats milliseconds to H:MM:SS', () => {
      expect(formatDuration(3661000)).toBe('1:01:01');
      expect(formatDuration(7200000)).toBe('2:00:00');
    });

    it('formats milliseconds to M:SS when under 1 hour', () => {
      expect(formatDuration(125000)).toBe('2:05');
      expect(formatDuration(60000)).toBe('1:00');
      expect(formatDuration(5000)).toBe('0:05');
    });
  });
});