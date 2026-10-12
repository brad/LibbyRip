import type { BIF } from './bif.js';
import type { URLInfo } from '../types.js';

export function getUrls(BIF: BIF, odreadCmptParams: string[] | null): URLInfo[] {
  const ret: URLInfo[] = [];
  if (!odreadCmptParams) return ret;
  for (const spine of BIF.objects.spool.components) {
    const data: URLInfo = {
      url: location.origin + '/' + spine.meta.path + '?' + odreadCmptParams[spine.spinePosition],
      index: spine.meta['-odread-spine-position'],
      duration: spine.meta['audio-duration'],
      size: spine.meta['-odread-file-bytes'],
      type: spine.meta['media-type'],
    };
    ret.push(data);
  }
  return ret;
}