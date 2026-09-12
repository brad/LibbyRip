import { describe, it, expect } from 'vitest';
import {
  stripId3,
  writeId3,
  chapterTitleFor,
  buildBookId3Tag,
  tagChapterMp3,
  textFrame,
  commFrame,
  apicFrame,
} from '../../src/utils/id3.js';

describe('utils/id3.ts', () => {
  // Helper to create a simple ID3 tag for testing
  function createTestId3Tag(): Uint8Array {
    const frames = [textFrame('TIT2', 'Test')];
    return writeId3(new Uint8Array([0xFF, 0xFB, 0x90, 0x00]), frames);
  }

  describe('textFrame', () => {
    it('creates text frame with UTF-16BE encoding', () => {
      const frame = textFrame('TIT2', 'Test Title');
      expect(frame.slice(0, 4)).toEqual(new TextEncoder().encode('TIT2'));
      expect(frame[10]).toBe(0x01); // UTF-16BE encoding byte
    });
  });

  describe('commFrame', () => {
    it('creates comment frame', () => {
      const frame = commFrame('Test comment', 'eng');
      expect(frame.slice(0, 4)).toEqual(new TextEncoder().encode('COMM'));
      expect(frame.slice(11, 14)).toEqual(new TextEncoder().encode('eng'));
    });
  });

  describe('apicFrame', () => {
    it('creates attached picture frame', () => {
      const cover = new Uint8Array([0xFF, 0xD8, 0xFF]);
      const frame = apicFrame(cover, 'image/jpeg');
      expect(frame.slice(0, 4)).toEqual(new TextEncoder().encode('APIC'));
      expect(frame[10]).toBe(0x01);
    });
  });

  describe('stripId3', () => {
    it('removes ID3v2 tag from start', () => {
      const tag = createTestId3Tag();
      const mp3 = new Uint8Array([0xFF, 0xFB, 0x90, 0x00]);
      const combined = new Uint8Array(tag.length + mp3.length);
      combined.set(tag);
      combined.set(mp3, tag.length);
      const result = stripId3(combined);
      // stripId3 finds the first MPEG frame, so it should return from the MPEG frame
      expect(result[0]).toBe(0xFF);
      expect(result[1]).toBe(0xFB);
    });

    it('removes ID3v1 tag from end', () => {
      const mp3 = new Uint8Array([0xFF, 0xFB, 0x90, 0x00]);
      const id3v1 = new Uint8Array(128);
      id3v1[0] = 0x54;
      id3v1[1] = 0x41;
      id3v1[2] = 0x47;
      const combined = new Uint8Array(mp3.length + id3v1.length);
      combined.set(mp3);
      combined.set(id3v1, mp3.length);
      const result = stripId3(combined);
      expect(result).toEqual(mp3);
    });

    it('returns original if no ID3 tags', () => {
      const mp3 = new Uint8Array([0xFF, 0xFB, 0x90, 0x00]);
      expect(stripId3(mp3)).toEqual(mp3);
    });

    it('finds first MPEG frame after ID3v2 and padding', () => {
      const tag = createTestId3Tag();
      const padding = new Uint8Array(10);
      const mp3 = new Uint8Array([0xFF, 0xFB, 0x90, 0x00]);
      const combined = new Uint8Array(tag.length + padding.length + mp3.length);
      combined.set(tag);
      combined.set(padding, tag.length);
      combined.set(mp3, tag.length + padding.length);
      const result = stripId3(combined);
      expect(result[0]).toBe(0xFF);
      expect(result[1]).toBe(0xFB);
    });
  });

  describe('writeId3', () => {
    it('prepends ID3 tag to MP3 data', () => {
      const mp3 = new Uint8Array([0xFF, 0xFB, 0x90, 0x00]);
      const frames = [textFrame('TIT2', 'Test')];
      const result = writeId3(mp3, frames);
      expect(result.slice(0, 3)).toEqual(new TextEncoder().encode('ID3'));
      expect(result.slice(-4)).toEqual(mp3);
    });
  });

  describe('chapterTitleFor', () => {
    it('returns opening credits for chapter 0', () => {
      expect(chapterTitleFor(0, 'Book Title')).toBe('Book Title - Opening Credits');
    });

    it('returns chapter number for others', () => {
      expect(chapterTitleFor(1, 'Book Title')).toBe('Chapter 1');
      expect(chapterTitleFor(5, 'Book Title')).toBe('Chapter 5');
    });
  });

  describe('buildBookId3Tag', () => {
    it('builds complete book tag with all frames', () => {
      const options = {
        book: {
          street_date: '2024-01-15',
          description: 'Test description',
          series: ['Series Name'],
        },
        displayTitle: 'Test Book',
        author: 'Test Author',
        narrator: 'Test Narrator',
        seriesName: 'Series Name',
        seriesIndex: 1,
        chapters: [
          { chapter_number: 1 },
          { chapter_number: 2 },
        ],
        durationByChapter: { 1: 1800000, 2: 1800000 },
        coverBytes: new Uint8Array([0xFF, 0xD8, 0xFF]),
        coverMime: 'image/jpeg',
      };

      const { tag, totalDurationMs } = buildBookId3Tag(options);
      expect(tag.slice(0, 3)).toEqual(new TextEncoder().encode('ID3'));
      expect(totalDurationMs).toBe(3600000);

      // Check for frame IDs in the tag (they're ASCII)
      const tagBytes = new TextDecoder('ascii', { fatal: false }).decode(tag);
      expect(tagBytes).toContain('TIT2');
      expect(tagBytes).toContain('TALB');
      expect(tagBytes).toContain('TPE1');
      expect(tagBytes).toContain('TPE2');
      expect(tagBytes).toContain('CHAP');
      expect(tagBytes).toContain('CTOC');
    });

    it('handles missing optional fields', () => {
      const options = {
        book: {},
        displayTitle: 'Test Book',
        author: 'Test Author',
        chapters: [{ chapter_number: 1 }],
        durationByChapter: { 1: 1800000 },
        coverBytes: null,
        coverMime: null,
      };

      const { tag } = buildBookId3Tag(options);
      const tagBytes = new TextDecoder('ascii', { fatal: false }).decode(tag);
      expect(tagBytes).toContain('TIT2');
      expect(tagBytes).toContain('TPE1');
      expect(tagBytes).not.toContain('TPE2');
      expect(tagBytes).not.toContain('APIC');
    });
  });

  describe('tagChapterMp3', () => {
    it('tags MP3 with chapter metadata', () => {
      const mp3 = new Uint8Array(100);
      mp3[0] = 0xFF; mp3[1] = 0xFB; mp3[2] = 0x90; mp3[3] = 0x00;
      const options = {
        book: { street_date: '2024' },
        displayTitle: 'Test Book',
        author: 'Test Author',
        narrator: 'Test Narrator',
        chapterNumber: 3,
        totalChapters: 10,
        durationMs: 1800000,
        coverBytes: new Uint8Array([0xFF, 0xD8, 0xFF]),
        coverMime: 'image/jpeg',
      };

      const blob = tagChapterMp3(mp3, options);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('audio/mpeg');
    });

    it('falls back to untagged on error', () => {
      const invalidMp3 = new Uint8Array([0, 0, 0]);
      const options = {
        book: {},
        displayTitle: 'Test',
        author: 'Author',
        chapterNumber: 1,
      };

      const blob = tagChapterMp3(invalidMp3, options);
      expect(blob).toBeInstanceOf(Blob);
    });
  });
});