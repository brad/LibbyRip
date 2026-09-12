import { describe, it, expect } from 'vitest';
import { getUrls } from '../../src/libby/urls.js';
import bifFixture from '../fixtures/bif.json';

describe('libby/urls.ts', () => {
  const bif = bifFixture as any;
  const odreadCmptParams = ['param1', 'param2', 'param3'];

  describe('getUrls', () => {
    it('generates URLs for all spool components', () => {
      const urls = getUrls(bif, odreadCmptParams);
      expect(urls).toHaveLength(3);
    });

    it('assigns correct index from spine position', () => {
      const urls = getUrls(bif, odreadCmptParams);
      expect(urls[0].index).toBe(0);
      expect(urls[1].index).toBe(1);
      expect(urls[2].index).toBe(2);
    });

    it('includes duration from component meta', () => {
      const urls = getUrls(bif, odreadCmptParams);
      expect(urls[0].duration).toBe(1000);
      expect(urls[1].duration).toBe(2000);
      expect(urls[2].duration).toBe(1500);
    });

    it('includes size from component meta', () => {
      const urls = getUrls(bif, odreadCmptParams);
      expect(urls[0].size).toBe(8000000);
      expect(urls[1].size).toBe(16000000);
      expect(urls[2].size).toBe(12000000);
    });

    it('generates correct URL format with params', () => {
      const urls = getUrls(bif, odreadCmptParams);
      for (const url of urls) {
        expect(url.url).toContain(location.origin);
        expect(url.url).toContain('test-part');
        expect(url.type).toBe('audio/mpeg');
      }
    });

    it('uses correct odreadCmptParams per spinePosition', () => {
      const urls = getUrls(bif, odreadCmptParams);
      expect(urls[0].url).toContain('param1');
      expect(urls[1].url).toContain('param2');
      expect(urls[2].url).toContain('param3');
    });

    it('returns empty array for null odreadCmptParams', () => {
      const urls = getUrls(bif, null);
      expect(urls).toEqual([]);
    });

    it('returns URLs with undefined param for empty odreadCmptParams array', () => {
      const urls = getUrls(bif, []);
      expect(urls).toHaveLength(3);
      for (const url of urls) {
        expect(url.url).toContain('undefined');
      }
    });

    it('generates unique URLs per component', () => {
      const urls = getUrls(bif, odreadCmptParams);
      const urlStrings = urls.map(u => u.url);
      const uniqueUrls = new Set(urlStrings);
      expect(uniqueUrls.size).toBe(urlStrings.length);
    });
  });
});