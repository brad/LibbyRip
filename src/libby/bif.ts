export let odreadCmptParams: string[] | null = null;

const oldParse = JSON.parse;
JSON.parse = function (...args: unknown[]): unknown {
  const ret = oldParse.apply(this, args);
  if (typeof ret === 'object' && ret !== null && 'b' in ret && typeof ret.b === 'object' && ret.b !== null && '-odread-cmpt-params' in ret.b) {
    odreadCmptParams = Array.from((ret.b as Record<string, unknown>)['-odread-cmpt-params'] as Iterable<string>);
  }
  return ret;
};

export interface BIFMap {
  title: { main: string };
  description?: string;
  creator: Array<{ name: string; role: string }>;
  spine: Array<{ 'audio-duration': number; 'media-type': string; 'audio-bitrate': number; '-odread-original-path': string }>;
  series?: string[];
  nav?: { toc: Array<{ title: string; path: string }> };
}

export interface BIFRoot {
  querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null;
}

export interface BIF {
  map: BIFMap;
  root: BIFRoot;
  objects: {
    spool: {
      components: Array<{
        meta: {
          path: string;
          '-odread-spine-position': number;
          'audio-duration': number;
          '-odread-file-bytes': number;
          'media-type': string;
        };
        spinePosition: number;
      }>;
    };
  };
}

export function getAuthorString(BIF: BIF): string {
  return BIF.map.creator.filter((creator) => creator.role === 'author').map((creator) => creator.name).join(', ');
}

export function getNarratorString(BIF: BIF): string {
  return BIF.map.creator.filter((creator) => creator.role === 'narrator').map((creator) => creator.name).join(', ');
}

export interface BookMetadata {
  title: string;
  description: string | undefined;
  coverUrl: string | null;
  creator: Array<{ name: string; role: string }>;
  spine: Array<{ duration: number; type: string; bitrate: number }>;
  chapters?: Array<{ title: string; spine: number; offset: number }>;
}

export function getMetadata(BIF: BIF): BookMetadata {
  const spineToIndex = BIF.map.spine.map((x) => x['-odread-original-path']);
  const coverEl = BIF.root.querySelector('image');
  const coverUrl = coverEl ? coverEl.getAttribute('href') : null;
  const metadata: BookMetadata = {
    title: BIF.map.title.main,
    description: BIF.map.description,
    coverUrl,
    creator: BIF.map.creator,
    spine: BIF.map.spine.map((x) => ({
      duration: x['audio-duration'],
      type: x['media-type'],
      bitrate: x['audio-bitrate'],
    })),
  };
  if (BIF.map.nav?.toc) {
    metadata.chapters = BIF.map.nav.toc.map((rChap) => ({
      title: rChap.title,
      spine: spineToIndex.indexOf(rChap.path.split('#')[0]),
      offset: 1 * (rChap.path.split('#')[1] | 0),
    }));
  }
  return metadata;
}

export interface MetadataFile {
  name: string;
  input: Blob | string;
}

export async function createMetadata(BIF: BIF, fetchFn: (url: string) => Promise<Response>): Promise<MetadataFile[]> {
  const metadata = getMetadata(BIF);
  const response = await fetchFn(metadata.coverUrl!);
  const blob = await response.blob();
  const csplit = metadata.coverUrl!.split('.');
  return [
    {
      name: 'metadata/cover.' + csplit[csplit.length - 1],
      input: blob,
    },
    {
      name: 'metadata/metadata.json',
      input: JSON.stringify(metadata, null, 2),
    },
  ];
}