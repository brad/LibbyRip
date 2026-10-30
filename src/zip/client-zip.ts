declare global {
  // client-zip's downloadZip returns a Response: .blob() for the whole
  // file, .body for streaming it. The body is what the EPUB download
  // streams to disk; it is null when the stream is unavailable.
  var downloadZip: (files: Array<{ name: string; input: Blob | Uint8Array | string }>) => Promise<{ blob: () => Promise<Blob>; body?: ReadableStream<Uint8Array> | null }>;
}

export async function getDownloadZip(): Promise<(files: Array<{ name: string; input: Blob | Uint8Array | string }>) => Promise<{ blob: () => Promise<Blob>; body?: ReadableStream<Uint8Array> | null }>> {
  const page = pageWindow();
  if (page.downloadZip) return page.downloadZip;
  if (window.__libregrabClientZipReady) return window.__libregrabClientZipReady;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/client-zip@2.5.0/worker.js';
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return page.downloadZip;
}

function pageWindow(): Window & typeof globalThis {
  return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
}