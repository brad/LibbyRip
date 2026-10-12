const BITRATE_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SR_MPEG1 = [44100, 48000, 32000];
const SR_MPEG2 = [22050, 24000, 16000];
const SR_MPEG25 = [11025, 12000, 8000];

export interface MpegHeader {
  frameLen: number;
  sampleRate: number;
  bitrate: number;
  channels: number;
  isMpeg1: boolean;
  sideInfo: number;
  crc: number;
  headerBytes: Uint8Array;
}

function asciiAt(u8: Uint8Array, offset: number, n: number): string {
  if (offset + n > u8.length) return '';
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(u8[offset + i]);
  return s;
}

export function parseMpegHeader(u8: Uint8Array, offset: number): MpegHeader | null {
  if (offset + 4 > u8.length) return null;
  if (u8[offset] !== 0xff || (u8[offset + 1] & 0xe0) !== 0xe0) return null;
  const b1 = u8[offset + 1];
  const b2 = u8[offset + 2];
  const b3 = u8[offset + 3];
  const ver = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  const prot = b1 & 1;
  const brIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 3;
  const padding = (b2 >> 1) & 1;
  const chMode = (b3 >> 6) & 3;
  if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const isMpeg1 = ver === 3;
  const isMpeg25 = ver === 0;
  const bitrate = (isMpeg1 ? BITRATE_MPEG1_L3 : BITRATE_MPEG2_L3)[brIdx] * 1000;
  const sampleRate = isMpeg1 ? SR_MPEG1[srIdx] : (isMpeg25 ? SR_MPEG25[srIdx] : SR_MPEG2[srIdx]);
  if (!bitrate || !sampleRate) return null;
  const coeff = isMpeg1 ? 144 : 72;
  const frameLen = Math.floor((coeff * bitrate) / sampleRate) + padding;
  if (frameLen < 4) return null;
  const channels = chMode === 3 ? 1 : 2;
  const sideInfo = isMpeg1 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);
  const crc = prot === 0 ? 2 : 0;
  return {
    frameLen,
    sampleRate,
    bitrate,
    channels,
    isMpeg1,
    sideInfo,
    crc,
    headerBytes: u8.subarray(offset, offset + 4),
  };
}

export function countMpegFrames(u8: Uint8Array): number {
  let i = 0;
  let count = 0;
  while (i + 4 <= u8.length) {
    const h = parseMpegHeader(u8, i);
    if (!h || i + h.frameLen > u8.length) {
      i++;
      continue;
    }
    count++;
    i += h.frameLen;
  }
  return count;
}

function xingPayloadOffset(header: MpegHeader): number {
  return 4 + header.crc + header.sideInfo;
}

function leadingSpecialFrameLen(u8: Uint8Array): number {
  const h = parseMpegHeader(u8, 0);
  if (!h || h.frameLen > u8.length) return 0;
  const xoff = xingPayloadOffset(h);
  const xtag = asciiAt(u8, xoff, 4);
  if (xtag === 'Xing' || xtag === 'Info') return h.frameLen;
  if (asciiAt(u8, 36, 4) === 'VBRI') return h.frameLen;
  return 0;
}

export function stripXingFrame(u8: Uint8Array): Uint8Array {
  const n = leadingSpecialFrameLen(u8);
  return n ? u8.subarray(n) : u8;
}

export function makeXingFrame(proto: MpegHeader, frames: number, bytes: number): Uint8Array {
  const frame = new Uint8Array(proto.frameLen);
  frame.set(proto.headerBytes, 0);
  const off = xingPayloadOffset(proto);
  if (off + 16 + 100 > frame.length) {
    throw new Error(`MPEG frame too small to hold a Xing header (need ${off + 116}, have ${frame.length})`);
  }
  frame[off] = 0x58;
  frame[off + 1] = 0x69;
  frame[off + 2] = 0x6e;
  frame[off + 3] = 0x67;
  writeU32be(frame, off + 4, 0x00000007);
  writeU32be(frame, off + 8, frames >>> 0);
  writeU32be(frame, off + 12, bytes >>> 0);
  for (let i = 0; i < 100; i++) {
    frame[off + 16 + i] = Math.min(255, Math.round((i / 99) * 255));
  }
  return frame;
}

function writeU32be(u8: Uint8Array, offset: number, n: number): void {
  n >>>= 0;
  u8[offset] = (n >>> 24) & 0xff;
  u8[offset + 1] = (n >>> 16) & 0xff;
  u8[offset + 2] = (n >>> 8) & 0xff;
  u8[offset + 3] = n & 0xff;
}