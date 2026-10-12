/**
 * Ebook UI wiring.
 *
 * Adds an "Export as EPUB" entry point alongside the audiobook buttons.
 * Call `addEbookButton` after the main LibbyRip UI is built; it appends a
 * button to the `.libregrab-ui` container (falling back to a floating
 * button when that container is absent).
 */

import type { BIF } from '../libby/bif.js';
import { downloadEbook, type EbookProgress, type ZipFactory } from '../libby/ebook.js';

export interface EbookUiDeps {
  getDownloadZip: ZipFactory;
  makeProgress: (container: HTMLElement) => EbookProgress;
}

function isDownloading(): boolean {
  return (window as unknown as { downloadState?: number }).downloadState !== -1;
}

function setDownloading(active: boolean): void {
  (window as unknown as { downloadState?: number }).downloadState = active ? 1 : -1;
}

export function addEbookButton(bif: BIF, deps: EbookUiDeps): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'libregrab-btn epub';
  button.textContent = 'Export as EPUB';
  button.style.background = '#6f42c1';

  button.onclick = () => {
    if (isDownloading()) return;
    setDownloading(true);
    const panel = document.querySelector<HTMLElement>('.libregrab-panel');
    const body = panel?.querySelector<HTMLElement>('.libregrab-panel-body');
    if (panel && body) {
      panel.style.display = 'flex';
      const progress = deps.makeProgress(body);
      downloadEbook(bif, progress, deps.getDownloadZip).finally(() => setDownloading(false));
    } else {
      // Fallback: minimal floating progress element.
      const fallback = document.createElement('div');
      fallback.className = 'libregrab-panel';
      fallback.style.display = 'flex';
      fallback.innerHTML = '<div class="libregrab-panel-body"></div>';
      document.body.appendChild(fallback);
      const progress = deps.makeProgress(
        fallback.querySelector('.libregrab-panel-body') as HTMLElement
      );
      downloadEbook(bif, progress, deps.getDownloadZip).finally(() => {
        setDownloading(false);
        fallback.remove();
      });
    }
  };

  const container = document.querySelector('.libregrab-ui');
  if (container) {
    container.appendChild(button);
  } else {
    button.style.position = 'fixed';
    button.style.top = '60px';
    button.style.right = '16px';
    button.style.zIndex = '2147483647';
    document.body.appendChild(button);
  }
  return button;
}
