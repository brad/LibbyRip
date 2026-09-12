import { describe, it, expect } from 'vitest';
import {
  parseMpegHeader,
  countMpegFrames,
  stripXingFrame,
  makeXingFrame,
} from '../../src/utils/mpeg.js';

describe('utils/mpeg.ts', () => {
  // Helper to create a valid MPEG frame (MPEG1 Layer3, 128kbps, 44.1kHz)
  // Frame header: 0xFF 0xFB 0x90 0x00
  // bitrate index = 9 (0x90 >> 4 = 9) -> 128kbps in MPEG1 Layer3 table
  function createMpegFrame(): Uint8Array {
    const frame = new Uint8Array(417);
    frame[0] = 0xFF;
    frame[1] = 0xFB; // MPEG1 Layer3, no CRC
    frame[2] = 0x90; // bitrate index 9 = 128kbps, 44.1kHz
    frame[3] = 0x00;
    return frame;
  }

  // 64kbps frame (bitrate index 5)
  function createMpegFrame64kbps(): Uint8Array {
    const frame = new Uint8Array(417);
    frame[0] = 0xFF;
    frame[1] = 0xFB;
    frame[2] = 0x50; // bitrate index 5 = 64kbps, 44.1kHz
    frame[3] = 0x00;
    return frame;
  }

  function createMpegStream(frameCount: number, frameFn = createMpegFrame): Uint8Array {
    const frames: Uint8Array[] = [];
    for (let i = 0; i < frameCount; i++) {
      frames.push(frameFn());
    }
    let total = 0;
    for (const f of frames) total += f.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const f of frames) {
      out.set(f, o);
      o += f.length;
    }
    return out;
  }

  function createXingFrame(totalFrames: number, totalBytes: number): Uint8Array {
    const proto = parseMpegHeader(createMpegFrame(), 0)!;
    return makeXingFrame(proto, totalFrames, totalBytes);
  }

  function createMpegStreamWithXing(frameCount: number, totalBytes: number): Uint8Array {
    const xingFrame = createXingFrame(frameCount, totalBytes);
    const remainingFrames = createMpegStream(frameCount - 1);
    const stream = new Uint8Array(xingFrame.length + remainingFrames.length);
    stream.set(xingFrame);
    stream.set(remainingFrames, xingFrame.length);
    return stream;
  }

  describe('parseMpegHeader', () => {
    it('parses valid MPEG frame header (128kbps)', () => {
      const frame = createMpegFrame();
      const header = parseMpegHeader(frame, 0);
      expect(header).not.toBeNull();
      expect(header!.bitrate).toBe(128000);
      expect(header!.sampleRate).toBe(44100);
      expect(header!.isMpeg1).toBe(true);
      expect(header!.frameLen).toBeGreaterThan(0);
    });

    it('parses 64kbps frame correctly', () => {
      const frame = createMpegFrame64kbps();
      const header = parseMpegHeader(frame, 0);
      expect(header).not.toBeNull();
      expect(header!.bitrate).toBe(64000);
      expect(header!.sampleRate).toBe(44100);
    });

    it('returns null for invalid sync', () => {
      const invalid = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      expect(parseMpegHeader(invalid, 0)).toBeNull();
    });

    it('returns null for insufficient data', () => {
      const short = new Uint8Array([0xFF, 0xFB]);
      expect(parseMpegHeader(short, 0)).toBeNull();
    });

    it('parses MPEG 2.5 frame (does not reject)', () => {
      const frame = new Uint8Array(417);
      frame[0] = 0xFF;
      frame[1] = 0xE3; // MPEG 2.5, Layer 3
      frame[2] = 0x90;
      frame[3] = 0x00;
      const header = parseMpegHeader(frame, 0);
      expect(header).not.toBeNull();
      expect(header!.isMpeg1).toBe(false);
    });

    it('parses Layer 2 frame (does not reject)', () => {
      const frame = new Uint8Array(417);
      frame[0] = 0xFF;
      frame[1] = 0xF3; // MPEG1 Layer 2
      frame[2] = 0x90;
      frame[3] = 0x00;
      const header = parseMpegHeader(frame, 0);
      expect(header).not.toBeNull();
    });

    it('detects Xing frame', () => {
      const xingFrame = createXingFrame(100, 41700);
      const header = parseMpegHeader(xingFrame, 0);
      expect(header).not.toBeNull();
      const xoff = 4 + header!.crc + header!.sideInfo;
      const xtag = new TextDecoder().decode(xingFrame.subarray(xoff, xoff + 4));
      expect(xtag).toBe('Xing');
    });
  });

  describe('countMpegFrames', () => {
    it('counts frames in clean stream', () => {
      const stream = createMpegStream(50);
      expect(countMpegFrames(stream)).toBe(50);
    });

    it('handles stream with Xing frame', () => {
      const stream = createMpegStreamWithXing(30, 12510);
      expect(countMpegFrames(stream)).toBe(30);
    });

    it('returns 0 for empty data', () => {
      expect(countMpegFrames(new Uint8Array(0))).toBe(0);
    });

    it('skips garbage bytes between frames', () => {
      const frame1 = createMpegFrame();
      const garbage = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
      const frame2 = createMpegFrame();
      const combined = new Uint8Array(frame1.length + garbage.length + frame2.length);
      combined.set(frame1);
      combined.set(garbage, frame1.length);
      combined.set(frame2, frame1.length + garbage.length);
      expect(countMpegFrames(combined)).toBe(2);
    });
  });

  describe('stripXingFrame', () => {
    it('removes Xing frame from stream', () => {
      const stream = createMpegStreamWithXing(10, 4170);
      const stripped = stripXingFrame(stream);
      expect(countMpegFrames(stripped)).toBe(9);
    });

    it('returns original if no Xing frame', () => {
      const stream = createMpegStream(10);
      const stripped = stripXingFrame(stream);
      expect(stripped).toEqual(stream);
    });
  });

  describe('makeXingFrame', () => {
    it('creates Xing frame with correct frame count and bytes', () => {
      const header = parseMpegHeader(createMpegFrame(), 0)!;
      const xing = makeXingFrame(header, 100, 41700);
      expect(xing.length).toBe(header.frameLen);

      const xoff = 4 + header.crc + header.sideInfo;
      const xtag = new TextDecoder().decode(xing.subarray(xoff, xoff + 4));
      expect(xtag).toBe('Xing');
    });

    it('creates consistent frame size', () => {
      const header = parseMpegHeader(createMpegFrame(), 0)!;
      const xing1 = makeXingFrame(header, 100, 41700);
      const xing2 = makeXingFrame(header, 200, 83400);
      expect(xing1.length).toBe(xing2.length);
    });
  });
});