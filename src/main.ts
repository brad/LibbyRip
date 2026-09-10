const clientZipReadyCode = `
window.__libregrabClientZipReady = new Promise((resolve, reject) => {
    window.__libregrabResolveClientZip = resolve;
    window.__libregrabRejectClientZip = reject;
});
`;

import pageContextCode from 'virtual:page-context-code';

console.log('[LibbyRip] Injecting mainCode');

const zipScript = document.createElement('script');
zipScript.src = 'https://unpkg.com/client-zip@2.5.0/worker.js';
zipScript.onload = () => {
  window.__libregrabResolveClientZip?.((window as any).downloadZip);
};
zipScript.onerror = () => {
  window.__libregrabRejectClientZip?.(new Error('client-zip failed to load'));
};
document.head.appendChild(zipScript);

const script = document.createElement('script');
script.textContent = pageContextCode;
(document.documentElement || document.head || document.body).appendChild(script);
script.remove();