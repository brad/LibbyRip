import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMpegFrame, createMpegStream } from '../helpers/mpeg.js';

describe('utils/download.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function importDownload(topFrame = true) {
    // Set up window.top/self BEFORE importing
    if (topFrame) {
      Object.defineProperty(window, 'top', { value: window, configurable: true });
      Object.defineProperty(window, 'self', { value: window, configurable: true });
    } else {
      const mockTop = { postMessage: vi.fn(), origin: 'https://libbyapp.com' };
      Object.defineProperty(window, 'top', { value: mockTop, configurable: true });
      Object.defineProperty(window, 'self', { value: window, configurable: true });
    }
    return await import('../../src/utils/download.js');
  }

  describe('pickSaveFile', () => {
    it('calls showSaveFilePicker with correct options', async () => {
      const { pickSaveFile } = await importDownload(true);
      
      const mockHandle = { createWritable: vi.fn() };
      const mockPicker = vi.fn().mockResolvedValue(mockHandle);
      
      const w = window as any;
      w.showSaveFilePicker = mockPicker;

      const handle = await pickSaveFile('test.mp3', [{
        description: 'MP3 Audio',
        accept: { 'audio/mpeg': ['.mp3'] },
      }]);

      expect(mockPicker).toHaveBeenCalledWith({
        suggestedName: 'test.mp3',
        types: [{ description: 'MP3 Audio', accept: { 'audio/mpeg': ['.mp3'] } }],
      });
      expect(handle).toBe(mockHandle);
    });

    it('throws if not in top frame', async () => {
      const { pickSaveFile } = await importDownload(false);

      await expect(pickSaveFile('test.mp3', [])).rejects.toThrow('must be called from top frame');
    });
  });

  describe('requestSaveFromTopFrame', () => {
    it('saves directly in top frame via anchor click', async () => {
      const { requestSaveFromTopFrame } = await importDownload(true);
      
      const clickMock = vi.fn();
      HTMLAnchorElement.prototype.click = clickMock;
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
      
      const blob = new Blob(['test'], { type: 'audio/mpeg' });
      await requestSaveFromTopFrame(blob, 'test.mp3', 'audio/mpeg');
      
      expect(clickMock).toHaveBeenCalled();
      expect(URL.createObjectURL).toHaveBeenCalled();
    });

    it('posts message in iframe context', async () => {
      const { requestSaveFromTopFrame } = await importDownload(false);
      
      Object.defineProperty(document, 'referrer', { value: 'https://libbyapp.com/', configurable: true });

      const blob = new Blob(['test'], { type: 'audio/mpeg' });
      await requestSaveFromTopFrame(blob, 'test.mp3', 'audio/mpeg');
      
      expect(window.top.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LIBREGRAB_SAVE_REQUEST',
          filename: 'test.mp3',
          mimeType: 'audio/mpeg',
        }),
        'https://libbyapp.com',
        expect.any(Array)
      );
    });
  });

  describe('buildAudiobookSingleMp3', () => {
    it('function exists and has correct signature', async () => {
      const { buildAudiobookSingleMp3 } = await importDownload(true);
      expect(typeof buildAudiobookSingleMp3).toBe('function');
    });
  });
});