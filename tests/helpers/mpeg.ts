// Helper to generate synthetic MPEG frames for testing

export interface MpegFrameOptions {
  bitrate?: number;
  sampleRate?: number;
  padding?: number;
  layer?: 3;
  version?: 1;
  frameSize?: number;
}

// MPEG version constants
const MPEG_VERSIONS = { 1: 3, 2: 2, 2.5: 0 };
const LAYER_3 = 1;
const BITRATE_INDEX: Record<number, number[]> = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1], // Layer 3
};
const SAMPLE_RATE_INDEX: Record<number, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

function findBitrateIndex(version: number, bitrate: number): number {
  const table = BITRATE_INDEX[1]; // Layer 3
  return table.indexOf(bitrate);
}

function findSampleRateIndex(version: number, sampleRate: number): number {
  const table = SAMPLE_RATE_INDEX[version] || SAMPLE_RATE_INDEX[1];
  return table.indexOf(sampleRate);
}

/**
 * Creates a valid MPEG frame header (4 bytes)
 */
export function createMpegHeader(options: MpegFrameOptions = {}): Uint8Array {
  const {
    bitrate = 64,
    sampleRate = 44100,
    padding = 0,
    layer = 3,
    version = 1,
  } = options;

  const versionBits = MPEG_VERSIONS[version as keyof typeof MPEG_VERSIONS] ?? 3;
  const layerBits = layer === 3 ? LAYER_3 : 0;
  const bitrateIndex = findBitrateIndex(version, bitrate);
  const sampleRateIndex = findSampleRateIndex(version, sampleRate);

  if (bitrateIndex === -1) throw new Error(`Invalid bitrate: ${bitrate}`);
  if (sampleRateIndex === -1) throw new Error(`Invalid sample rate: ${sampleRate}`);

  const header = new Uint8Array(4);
  // Sync: 11 bits = 0x7FF
  header[0] = 0xFF;
  header[1] = 0xF0 | (versionBits << 3) | (layerBits << 1) | 1; // protection bit = 1 (no CRC)
  header[2] = (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1) | 0; // private bit
  header[3] = 0x00; // mode=stereo, modeExt=0, copyright=0, original=0, emphasis=0

  return header;
}

/**
 * Creates a minimal valid MPEG frame (header + dummy data)
 */
export function createMpegFrame(options: MpegFrameOptions = {}): Uint8Array {
  const { frameSize = 417 } = options;
  const header = createMpegHeader(options);
  const frame = new Uint8Array(frameSize);
  frame.set(header);
  // Fill rest with dummy data (silence pattern)
  for (let i = 4; i < frameSize; i++) {
    frame[i] = 0x00;
  }
  return frame;
}

/**
 * Creates a stream of MPEG frames
 */
export function createMpegStream(frameCount: number, options: MpegFrameOptions = {}): Uint8Array {
  const { frameSize = 417 } = options;
  const stream = new Uint8Array(frameCount * frameSize);
  for (let i = 0; i < frameCount; i++) {
    const frame = createMpegFrame({ ...options, frameSize });
    stream.set(frame, i * frameSize);
  }
  return stream;
}

/**
 * Creates an MPEG stream with Xing header as first frame
 */
export function createMpegStreamWithXing(
  totalFrames: number,
  totalBytes: number,
  options: MpegFrameOptions = {}
): Uint8Array {
  const { frameSize = 417 } = options;
  const xingFrame = createXingFrame(totalFrames, totalBytes, options);
  const remainingFrames = createMpegStream(totalFrames - 1, options);
  const stream = new Uint8Array(xingFrame.length + remainingFrames.length);
  stream.set(xingFrame);
  stream.set(remainingFrames, xingFrame.length);
  return stream;
}

/**
 * Creates a Xing frame (special MPEG frame with seek table)
 */
export function createXingFrame(
  totalFrames: number,
  totalBytes: number,
  options: MpegFrameOptions = {}
): Uint8Array {
  const header = createMpegHeader(options);
  const xing = new Uint8Array(4 + 120); // header + xing data
  xing.set(header);
  // Xing identifier at offset 4 (after header)
  xing.set(new TextEncoder().encode('Xing'), 4);
  // Flags: frames + bytes + toc
  const flags = new Uint8Array([0, 0, 0, 7]);
  xing.set(flags, 8);
  // Total frames (4 bytes, big endian)
  xing[12] = (totalFrames >> 24) & 0xFF;
  xing[13] = (totalFrames >> 16) & 0xFF;
  xing[14] = (totalFrames >> 8) & 0xFF;
  xing[15] = totalFrames & 0xFF;
  // Total bytes (4 bytes, big endian)
  xing[16] = (totalBytes >> 24) & 0xFF;
  xing[17] = (totalBytes >> 16) & 0xFF;
  xing[18] = (totalBytes >> 8) & 0xFF;
  xing[19] = totalBytes & 0xFF;
  // TOC (100 bytes) - simplified
  for (let i = 0; i < 100; i++) {
    xing[20 + i] = Math.floor((i / 99) * 255);
  }
  return xing;
}

/**
 * Creates an ID3v2 tag for testing
 */
export function createId3Tag(frames: Uint8Array[]): Uint8Array {
  let totalSize = 0;
  for (const frame of frames) totalSize += frame.length;
  // Synchsafe size
  const size = [
    (totalSize >> 21) & 0x7F,
    (totalSize >> 14) & 0x7F,
    (totalSize >> 7) & 0x7F,
    totalSize & 0x7F,
  ];
  const tag = new Uint8Array(10 + totalSize);
  tag[0] = 0x49; // 'I'
  tag[1] = 0x44; // 'D'
  tag[2] = 0x33; // '3'
  tag[3] = 0x03; // version
  tag[4] = 0x00; // revision
  tag[5] = 0x00; // flags
  tag.set(size, 6);
  let offset = 10;
  for (const frame of frames) {
    tag.set(frame, offset);
    offset += frame.length;
  }
  return tag;
}

/**
 * Creates a simple text frame (TIT2, TALB, etc.)
 */
export function createTextFrame(id: string, text: string): Uint8Array {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode('\u0000' + text); // UTF-16 BOM + text (simplified as UTF-8)
  const frame = new Uint8Array(10 + textBytes.length);
  frame.set(encoder.encode(id), 0);
  frame[4] = (textBytes.length >> 24) & 0xFF;
  frame[5] = (textBytes.length >> 16) & 0xFF;
  frame[6] = (textBytes.length >> 8) & 0xFF;
  frame[7] = textBytes.length & 0xFF;
  frame[8] = 0x00; // flags
  frame[9] = 0x00;
  frame.set(textBytes, 10);
  return frame;
}