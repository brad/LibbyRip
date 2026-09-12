import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  gmFetchBlob,
  fetchWithRetry,
  fetchCover,
  safeFilename,
} from '../../src/utils/fetch.js';

describe('utils/fetch.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('gmFetchBlob', () => {
    it('uses GM.xmlHttpRequest when available', async () => {
      const mockResponse = {
        status: 200,
        response: new Blob(['test data'], { type: 'audio/mpeg' }),
      };
      
      const originalGM = (globalThis as any).GM;
      (globalThis as any).GM = {
        xmlHttpRequest: vi.fn((options) => {
          options.onload(mockResponse);
        }),
      };

      const result = await gmFetchBlob('https://example.com/test.mp3');
      expect(result).toBeInstanceOf(Blob);
      expect(result.size).toBeGreaterThan(0);

      (globalThis as any).GM = originalGM;
    });

    it('rejects when GM not available', async () => {
      const originalGM = (globalThis as any).GM;
      (globalThis as any).GM = undefined;

      await expect(gmFetchBlob('https://example.com/test.mp3')).rejects.toThrow('GM.xmlHttpRequest is not available');

      (globalThis as any).GM = originalGM;
    });

    it('throws on HTTP error from GM', async () => {
      const originalGM = (globalThis as any).GM;
      (globalThis as any).GM = {
        xmlHttpRequest: vi.fn((options) => {
          options.onload({ status: 404, response: null });
        }),
      };

      await expect(gmFetchBlob('https://example.com/test.mp3')).rejects.toThrow('HTTP 404');

      (globalThis as any).GM = originalGM;
    });
  });

  describe('fetchWithRetry', () => {
    it('returns response on first success', async () => {
      const mockResponse = new Response(new Blob(['data']), { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      const result = await fetchWithRetry('https://example.com/test', {}, 'test', vi.fn());
      expect(result).toBe(mockResponse);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries on HTTP error and succeeds', async () => {
      const errorResponse = new Response(null, { status: 500 });
      const successResponse = new Response(new Blob(['data']), { status: 200 });
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(errorResponse)
        .mockResolvedValueOnce(successResponse);

      const progress = vi.fn();
      const promise = fetchWithRetry('https://example.com/test', {}, 'test', progress, 3);
      
      // Advance timers and run all pending timers
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.runAllTimersAsync();
      
      const result = await promise;
      expect(result).toBe(successResponse);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(progress).toHaveBeenCalledWith(expect.stringContaining('retry 1/3 failed for test'));
    }, 10000);

    it('throws after max attempts exceeded', async () => {
      vi.useRealTimers();
      try {
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

        const promise = fetchWithRetry('https://example.com/test', {}, 'test', vi.fn(), 3);
        
        // Handle rejection explicitly to prevent unhandled rejection
        const error = await promise.catch(e => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('HTTP 500');
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useFakeTimers();
      }
    }, 10000);
  });

  describe('fetchCover', () => {
    it('fetches cover image and returns bytes', async () => {
      const coverBlob = new Blob([new Uint8Array([0xFF, 0xD8, 0xFF])], { type: 'image/jpeg' });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(coverBlob, { status: 200 }));

      const result = await fetchCover('https://example.com/cover.jpg', vi.fn());
      expect(result.bytes).toBeInstanceOf(Uint8Array);
      expect(result.mime).toBe('image/jpeg');
    });

    it('returns null bytes on HTTP error', async () => {
      // Return a 404 response - fetchWithRetry will retry 3 times
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

      const promise = fetchCover('https://example.com/cover.jpg', vi.fn());
      
      // Advance all retry timers
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      
      const result = await promise;
      expect(result.bytes).toBeNull();
      expect(result.mime).toBeNull();
    }, 10000);

    it('calls progress callback with cover fetched message', async () => {
      const progress = vi.fn();
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(new Blob(['data']), { status: 200 }));

      await fetchCover('https://example.com/cover.jpg', progress);
      expect(progress).toHaveBeenCalledWith(expect.stringContaining('Cover image fetched'));
    });
  });

  describe('safeFilename', () => {
    it('replaces invalid characters', () => {
      expect(safeFilename('test/file.mp3')).toBe('test_file.mp3');
      expect(safeFilename('test\\file.mp3')).toBe('test_file.mp3');
      expect(safeFilename('test:file.mp3')).toBe('test_file.mp3');
      expect(safeFilename('test*file.mp3')).toBe('test_file.mp3');
      expect(safeFilename('test?file.mp3')).toBe('test_file.mp3');
      expect(safeFilename('test"file.mp3')).toBe('test_file.mp3');
      expect(safeFilename('test<file.mp3')).toBe('test_file.mp3');
      expect(safeFilename('test>file.mp3')).toBe('test_file.mp3');
      expect(safeFilename('test|file.mp3')).toBe('test_file.mp3');
    });

    it('does not replace control characters (not in regex)', () => {
      expect(safeFilename('test\u0000file.mp3')).toBe('test\u0000file.mp3');
      expect(safeFilename('test\u001Ffile.mp3')).toBe('test\u001Ffile.mp3');
      expect(safeFilename('test\u007Ffile.mp3')).toBe('test\u007Ffile.mp3');
    });

    it('does not truncate (no length limit in implementation)', () => {
      const longName = 'a'.repeat(200);
      expect(safeFilename(longName).length).toBe(200);
    });

    it('handles empty string', () => {
      expect(safeFilename('')).toBe('');
    });

    it('preserves valid characters', () => {
      expect(safeFilename('Test Book - Author.mp3')).toBe('Test Book - Author.mp3');
      expect(safeFilename('Book (1).mp3')).toBe('Book (1).mp3');
      expect(safeFilename('Book_1.mp3')).toBe('Book_1.mp3');
    });

    it('trims whitespace', () => {
      expect(safeFilename('  test.mp3  ')).toBe('test.mp3');
    });
  });
});