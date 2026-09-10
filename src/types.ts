export interface Creator {
  name: string;
  role: string;
}

export interface Chapter {
  title: string;
  spine: number;
  offset: number;
}

export interface URLInfo {
  url: string;
  index: number;
  duration: number;
  size: number;
  type: string;
}

export interface BookMetadata {
  title: string;
  description: string;
  coverUrl: string;
  creator: Creator[];
  spine: Array<{
    duration: number;
    type: string;
    bitrate: number;
  }>;
  chapters?: Chapter[];
}

export interface SaveHandle {
  name: string;
  createWritable(): Promise<WritableStream>;
  createSyncAccessHandle(): Promise<never>;
}

export interface ProxySaveHandle {
  name: string;
  createWritable(): Promise<{
    write(data: Uint8Array | ArrayBuffer | Blob): Promise<void>;
    close(): Promise<void>;
    seek(position: number): Promise<void>;
    abort(): Promise<void>;
  }>;
  createSyncAccessHandle(): Promise<never>;
}

export const LIBREGRAB_SAVE_REQUEST = 'LIBREGRAB_SAVE_REQUEST';
export const LIBREGRAB_SAVE_RESULT = 'LIBREGRAB_SAVE_RESULT';
export const LIBREGRAB_PICK_REQUEST = 'LIBREGRAB_PICK_REQUEST';
export const LIBREGRAB_PICK_RESULT = 'LIBREGRAB_PICK_RESULT';
export const LIBREGRAB_WRITE_CHUNK = 'LIBREGRAB_WRITE_CHUNK';
export const LIBREGRAB_WRITE_ACK = 'LIBREGRAB_WRITE_ACK';
export const LIBREGRAB_WRITE_CLOSE = 'LIBREGRAB_WRITE_CLOSE';
export const LIBREGRAB_WRITE_CLOSE_ACK = 'LIBREGRAB_WRITE_CLOSE_ACK';
export const LIBREGRAB_WRITE_SEEK = 'LIBREGRAB_WRITE_SEEK';
export const LIBREGRAB_WRITE_SEEK_ACK = 'LIBREGRAB_WRITE_SEEK_ACK';

export interface SaveRequestMessage {
  type: typeof LIBREGRAB_SAVE_REQUEST;
  requestId: string;
  filename: string;
  mimeType: string;
  arrayBuffer: ArrayBuffer;
}

export interface SaveResultMessage {
  type: typeof LIBREGRAB_SAVE_RESULT;
  requestId: string;
  ok: boolean;
}

export interface PickRequestMessage {
  type: typeof LIBREGRAB_PICK_REQUEST;
  requestId: string;
  filename: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}

export interface PickResultMessage {
  type: typeof LIBREGRAB_PICK_RESULT;
  requestId: string;
  ok: boolean;
  name?: string;
  cancelled?: boolean;
  error?: { name?: string; message?: string };
}

export interface WriteChunkMessage {
  type: typeof LIBREGRAB_WRITE_CHUNK;
  requestId: string;
  seq: number;
  arrayBuffer: ArrayBuffer;
}

export interface WriteAckMessage {
  type: typeof LIBREGRAB_WRITE_ACK;
  requestId: string;
  seq: number;
  ok: boolean;
  error?: { name?: string; message?: string };
}

export interface WriteCloseMessage {
  type: typeof LIBREGRAB_WRITE_CLOSE;
  requestId: string;
}

export interface WriteCloseAckMessage {
  type: typeof LIBREGRAB_WRITE_CLOSE_ACK;
  requestId: string;
  ok: boolean;
  name?: string;
  error?: { name?: string; message?: string };
}

export interface WriteSeekMessage {
  type: typeof LIBREGRAB_WRITE_SEEK;
  requestId: string;
  position: number;
}

export interface WriteSeekAckMessage {
  type: typeof LIBREGRAB_WRITE_SEEK_ACK;
  requestId: string;
  ok: boolean;
  error?: { name?: string; message?: string };
}

export type MessageData =
  | SaveRequestMessage
  | SaveResultMessage
  | PickRequestMessage
  | PickResultMessage
  | WriteChunkMessage
  | WriteAckMessage
  | WriteCloseMessage
  | WriteCloseAckMessage
  | WriteSeekMessage
  | WriteSeekAckMessage;