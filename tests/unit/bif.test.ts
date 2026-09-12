import { describe, it, expect, vi } from 'vitest';
import {
  getMetadata,
  getAuthorString,
  getNarratorString,
  createMetadata,
  type BIF,
} from '../../src/libby/bif.js';
import bifFixture from '../fixtures/bif.json';

describe('libby/bif.ts', () => {
  // Create a BIF with the querySelector function that returns an object with getAttribute
  const bif = {
    ...bifFixture,
    root: {
      querySelector: (selector: string) => {
        if (selector === 'image') {
          return { getAttribute: (name: string) => name === 'href' ? bifFixture.root.querySelectorResult.href : null };
        }
        return null;
      },
    },
  } as unknown as BIF;

  describe('getMetadata', () => {
    it('extracts title from map', () => {
      const meta = getMetadata(bif);
      expect(meta.title).toBe('Test Title');
    });

    it('extracts description from map', () => {
      const meta = getMetadata(bif);
      expect(meta.description).toBe('Test description for unit testing.');
    });

    it('extracts author from creators', () => {
      const meta = getMetadata(bif);
      expect(meta.creator).toEqual([
        { name: 'Test Author', role: 'author' },
        { name: 'Test Narrator', role: 'narrator' }
      ]);
    });

    it('extracts cover URL from root', () => {
      const meta = getMetadata(bif);
      expect(meta.coverUrl).toBe('https://example.com/cover.jpg');
    });

    it('extracts spine info', () => {
      const meta = getMetadata(bif);
      expect(meta.spine).toHaveLength(3);
      expect(meta.spine[0]).toEqual({
        duration: 1000,
        type: 'audio/mpeg',
        bitrate: 64,
      });
    });

    it('extracts chapters from nav.toc', () => {
      const meta = getMetadata(bif);
      expect(meta.chapters).toHaveLength(4);
      expect(meta.chapters![0]).toEqual({ title: 'Chapter 1', spine: 0, offset: 0 });
      expect(meta.chapters![1]).toEqual({ title: 'Chapter 2', spine: 0, offset: 500 });
      expect(meta.chapters![2]).toEqual({ title: 'Chapter 3', spine: 1, offset: 0 });
      expect(meta.chapters![3]).toEqual({ title: 'Chapter 4', spine: 2, offset: 200 });
    });

    it('handles missing optional fields', () => {
      const minimalBif = {
        map: {
          title: { main: 'Minimal Book' },
          creator: [{ name: 'Author', role: 'author' }],
          spine: [{ 'audio-duration': 100, 'media-type': 'audio/mpeg', 'audio-bitrate': 64, '-odread-original-path': 'test.mp3' }],
        },
        root: {
          querySelector: () => null,
        },
        objects: { spool: { components: [] } },
      } as unknown as BIF;
      const meta = getMetadata(minimalBif);
      expect(meta.title).toBe('Minimal Book');
      expect(meta.description).toBeUndefined();
      expect(meta.coverUrl).toBeNull();
      expect(meta.chapters).toBeUndefined();
    });
  });

  describe('getAuthorString', () => {
    it('returns author name', () => {
      expect(getAuthorString(bif)).toBe('Test Author');
    });

    it('returns empty string if no author', () => {
      const noAuthorBif = {
        map: { creator: [{ name: 'Narrator', role: 'narrator' }], title: { main: 'Test' }, spine: [] },
        root: { querySelector: () => null },
        objects: { spool: { components: [] } },
      } as unknown as BIF;
      expect(getAuthorString(noAuthorBif)).toBe('');
    });

    it('joins multiple authors with comma', () => {
      const multiBif = {
        map: {
          creator: [
            { name: 'Author 1', role: 'author' },
            { name: 'Author 2', role: 'author' },
          ],
          title: { main: 'Test' },
          spine: [],
        },
        root: { querySelector: () => null },
        objects: { spool: { components: [] } },
      } as unknown as BIF;
      expect(getAuthorString(multiBif)).toBe('Author 1, Author 2');
    });
  });

  describe('getNarratorString', () => {
    it('returns narrator name', () => {
      expect(getNarratorString(bif)).toBe('Test Narrator');
    });

    it('returns empty string if no narrator', () => {
      const noNarratorBif = {
        map: { creator: [{ name: 'Author', role: 'author' }], title: { main: 'Test' }, spine: [] },
        root: { querySelector: () => null },
        objects: { spool: { components: [] } },
      } as unknown as BIF;
      expect(getNarratorString(noNarratorBif)).toBe('');
    });

    it('joins multiple narrators with comma', () => {
      const multiBif = {
        map: {
          creator: [
            { name: 'Author', role: 'author' },
            { name: 'Narrator 1', role: 'narrator' },
            { name: 'Narrator 2', role: 'narrator' },
          ],
          title: { main: 'Test' },
          spine: [],
        },
        root: { querySelector: () => null },
        objects: { spool: { components: [] } },
      } as unknown as BIF;
      expect(getNarratorString(multiBif)).toBe('Narrator 1, Narrator 2');
    });
  });

  describe('createMetadata', () => {
    it('creates metadata files for ZIP', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['cover data'], { type: 'image/jpeg' })),
      });

      const files = await createMetadata(bif, mockFetch);

      expect(files.length).toBe(2);
      const coverFile = files.find(f => f.name === 'metadata/cover.jpg');
      expect(coverFile).toBeDefined();
      expect(coverFile!.input).toBeInstanceOf(Blob);
    });

    it('includes JSON metadata file', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['cover data'], { type: 'image/jpeg' })),
      });

      const files = await createMetadata(bif, mockFetch);
      const jsonFile = files.find(f => f.name === 'metadata/metadata.json');
      expect(jsonFile).toBeDefined();

      // input is a string (JSON), not a Blob
      const jsonContent = jsonFile!.input as string;
      const meta = JSON.parse(jsonContent);
      expect(meta.title).toBe('Test Title');
      expect(meta.creator).toHaveLength(2);
      expect(meta.spine).toHaveLength(3);
      expect(meta.chapters).toHaveLength(4);
    });

    it('handles fetch errors gracefully', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(createMetadata(bif, mockFetch)).rejects.toThrow('Network error');
    });
  });
});