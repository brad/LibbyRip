import { describe, it, expect, vi } from 'vitest';
import {
  fallbackBlobDownload,
} from '../../src/libby/chapters.js';
import { createMpegFrame } from '../helpers/mpeg.js';

describe('libby/chapters.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fallbackBlobDownload', () => {
    it('creates zip and calls progress callbacks', async () => {
      const progress = {
        add: vi.fn(),
        clear: vi.fn(),
      };
      
      const mockZip = { blob: vi.fn().mockResolvedValue(new Blob(['zip content'])) };
      const getDownloadZip = vi.fn().mockResolvedValue(() => mockZip);

      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();

      const files = [
        { name: 'test.mp3', input: new Blob(['audio']) },
        { name: 'cover.jpg', input: new Blob(['image']) },
      ];

      await fallbackBlobDownload(files, 'test.zip', getDownloadZip, progress);

      expect(getDownloadZip).toHaveBeenCalled();
      expect(mockZip.blob).toHaveBeenCalled();
      expect(progress.add).toHaveBeenCalledWith('Using fallback download method...');
      expect(progress.add).toHaveBeenCalledWith('Generated zip file!');
      // Note: fallbackBlobDownload doesn't call progress.clear()
    });
  });

  // Note: exportChapters and createAndDownloadZip require complex mocking
  // of BIF, fetch, getDownloadZip, requestSaveFromTopFrame
  // These are better tested via integration tests
});