export interface GMXMLHttpRequestDetails {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string | object;
  binary?: boolean;
  timeout?: number;
  context?: unknown;
  responseType?: 'arraybuffer' | 'blob' | 'json' | 'text';
  overrideMimeType?: string;
  anonymous?: boolean;
  fetch?: boolean;
  username?: string;
  password?: string;
}

export interface GMXMLHttpRequestResponse {
  status: number;
  statusText: string;
  response: unknown;
  responseText: string;
  responseXML: Document | null;
  readyState: number;
  finalUrl: string;
}

function getGMXhr(): ((details: GMXMLHttpRequestDetails) => void) | null {
  const w = window as any;
  if (typeof w.GM !== 'undefined' && typeof w.GM.xmlHttpRequest === 'function') {
    return w.GM.xmlHttpRequest.bind(w.GM);
  }
  if (typeof w.GM_xmlhttpRequest === 'function') {
    return w.GM_xmlhttpRequest;
  }
  return null;
}

export function gmXhr(details: GMXMLHttpRequestDetails): Promise<GMXMLHttpRequestResponse> {
  const fn = getGMXhr();
  if (!fn) return Promise.reject(new Error('GM.xmlHttpRequest is not available'));
  return new Promise((resolve, reject) => {
    fn({
      ...details,
      onload: resolve,
      onerror: (e: any) => reject(e && e.error ? new Error(e.error) : new Error('GM.xmlHttpRequest network error')),
      ontimeout: () => reject(new Error('GM.xmlHttpRequest timed out')),
    });
  });
}

export async function gmFetchBlob(url: string): Promise<Blob> {
  const res = await gmXhr({
    method: 'GET',
    url,
    responseType: 'blob',
    anonymous: true,
  });
  if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
  if (!res.response) throw new Error('empty GM.xmlHttpRequest body');
  return res.response as Blob;
}

export async function fetchWithRetry(
  url: string,
  fetchOpts: RequestInit,
  label: string,
  progress: (msg: string) => void,
  maxAttempts = 3
): Promise<Response> {
  let lastErr: Error;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, fetchOpts);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      lastErr = e as Error;
      if (progress) progress(` retry ${attempt}/${maxAttempts} failed for ${label}: ${(e as Error).message}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr!;
}

export async function fetchCover(
  coverUrl: string,
  progress: (msg: string) => void
): Promise<{ blob: Blob | null; bytes: Uint8Array | null; mime: string | null }> {
  try {
    const coverRes = await fetchWithRetry(coverUrl, {}, 'cover image', progress);
    const blob = await coverRes.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    progress(`Cover image fetched (${blob.size} bytes) via page fetch.`);
    return { blob, bytes, mime: blob.type || 'image/jpeg' };
  } catch (e) {
    progress(`NOTE: cover image unavailable: ${(e as Error).message}`);
    return { blob: null, bytes: null, mime: null };
  }
}

export function safeFilename(title: string): string {
  return String(title || '').trim().replace(/[\\/:*?"<>|]/g, '_');
}