/**
 * Ebook UI wiring.
 *
 * Adds an "Export as EPUB" entry point alongside the audiobook buttons.
 * Ported from the TypeScript ebook pipeline, with the button
 * spinner/disabled handling from the shipped merged build. Call
 * `wireEbookButton` after a BIF is available; it appends the button to
 * the `.libregrab-ui` container (falling back to a floating button when
 * that container is absent, as on reader pages where the audiobook UI
 * is skipped).
 */

import type { BIF } from '../libby/bif.js';
import { downloadEbook, type EbookProgress, type ZipFactory } from '../libby/ebook.js';
import { ProgressDisplay } from './progress.js';

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
  button.style.cssText =
    'background: #6f42c1; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;';
  const label = button.textContent;

  button.onclick = () => {
    console.log('[LibbyRip] EPUB button clicked, isDownloading=', isDownloading());
    // Reset stuck state (if a previous attempt failed without resetting)
    if (isDownloading()) {
      console.log('[LibbyRip] Resetting stuck download state');
      setDownloading(false);
    }
    setDownloading(true);
    button.disabled = true;
    button.innerHTML = '<span class="libregrab-spinner"></span> Exporting...';
    console.log('[LibbyRip] Starting EPUB download...');
    const panel = document.querySelector<HTMLElement>('.libregrab-panel');
    const body = panel?.querySelector<HTMLElement>('.libregrab-panel-body');
    if (panel && body) {
      panel.style.display = 'flex';
      const progress = deps.makeProgress(body);
      downloadEbook(bif, progress, deps.getDownloadZip).finally(() => {
        setDownloading(false);
        button.disabled = false;
        button.textContent = label;
      });
    } else {
      // Fallback: minimal floating progress element.
      const fallback = document.createElement('div');
      fallback.className = 'libregrab-panel';
      fallback.style.cssText =
        'position: fixed; bottom: 16px; right: 16px; width: 320px; max-height: 400px; overflow-y: auto; background: rgba(0,0,0,0.85); color: white; border-radius: 8px; padding: 12px; font-family: sans-serif; font-size: 13px; z-index: 2147483647; display: flex; flex-direction: column;';
      fallback.innerHTML = '<div class="libregrab-panel-body"></div>';
      document.body.appendChild(fallback);
      const progress = deps.makeProgress(
        fallback.querySelector('.libregrab-panel-body') as HTMLElement
      );
      downloadEbook(bif, progress, deps.getDownloadZip).finally(() => {
        setDownloading(false);
        button.disabled = false;
        button.textContent = label;
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

/** True on `read.*` hostnames (Libby/OverDrive ebook readers). */
export function isEbookReader(): boolean {
  const parts = location.hostname.split('.');
  return parts.length >= 2 && parts[parts.length - 3] === 'read';
}

/**
 * Add the EPUB button for the given BIF, but only on ebook readers.
 * Progress messages go into a child div of the progress panel body.
 */
export function wireEbookButton(bif: BIF, deps: EbookUiDeps): void {
  if (!isEbookReader()) return;
  try {
    addEbookButton(bif, deps);
    console.log('[LibbyRip] Ebook button added');
  } catch (e) {
    console.error('[LibbyRip] Failed to add ebook button:', e);
  }
}

/** ProgressDisplay-backed progress surface for the EPUB download. */
export function makeEbookProgress(container: HTMLElement): EbookProgress {
  const div = document.createElement('div');
  container.appendChild(div);
  const display = new ProgressDisplay(div as HTMLDivElement);
  return {
    add: (msg: string) => display.add(msg),
    clear: () => display.clear(),
  };
}
