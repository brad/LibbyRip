/**
 * Standalone decryptor for Libby's chapter shells.
 *
 * As of ~Oct 2026 the libbyapp.com reader serves each chapter as a shell —
 * `<head>` (styles) plus `<body><script>parent.__bif_cfc1(self,'<edata>')</script></body>`
 * — with the real content encrypted client-side. This replicates Libby's own
 * `__bif_cfc1` decryptor (bifocal "rumi" module) so downloads don't depend on
 * their globals, which they rename/break without notice.
 *
 * Pure functions of the input HTML; no Libby globals required.
 */

/** Decode a single `__bif_cfc1` edata payload to the real `<body>` HTML. */
export function decryptEdata(edata: string): string {
  // Base64 with every 4-char group's 1st and 4th characters swapped.
  const unswapped = edata.replace(/(.)(.)(.)(.)/g, '$4$2$3$1');
  return atob(unswapped);
}

/**
 * Splice a decrypted `<body>` into its chapter shell, keeping the shell's
 * `<head>` (styles). Shells without a payload (covers, title pages) pass
 * through unchanged.
 */
export function decryptChapterShell(shellHtml: string): string {
  const m =
    shellHtml.match(/parent\.__bif_cfc1\(self,'([^']+)'\)/) ||
    shellHtml.match(/parent\.__bif_cfc0\(self,'([^']+)'\)/);
  if (!m) return shellHtml;

  const isCfc1 = shellHtml.includes('__bif_cfc1');
  let decrypted: string;
  try {
    decrypted = isCfc1 ? decryptEdata(m[1]) : atob(m[1]);
  } catch (e) {
    console.warn('chapter decrypt failed, using shell as-is', e);
    return shellHtml;
  }
  if (!/^\s*<body/i.test(decrypted)) {
    console.warn('chapter decrypt produced unexpected payload, using shell as-is');
    return shellHtml;
  }
  const spliced = shellHtml.replace(/<body[^>]*>[\s\S]*<\/body>/i, () => decrypted);
  return spliced !== shellHtml ? spliced : shellHtml;
}
