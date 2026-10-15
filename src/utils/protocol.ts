/**
 * Acoustic Data Transfer Protocol & CRC32
 * Implementation of custom acoustic packet framing, CRC32 verification,
 * and chunk assembly for Quiet.js cable-64k transfer.
 */

// IEEE 802.3 CRC32 Table (polynomial 0xEDB88320)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Computes standard IEEE 802.3 CRC-32 for an array of bytes.
 */
export function calculateCRC32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export const PROTOCOL_CONSTANTS = {
  MAGIC_NUMBER: 0xDEADBEEF,
  HEADER_SIZE: 78,
  CHUNK_HEADER_SIZE: 2,
  CHUNK_PAYLOAD_SIZE: 1024,
  CHUNK_CRC_SIZE: 4,
  CHUNK_TOTAL_SIZE: 1030, // 2 + 1024 + 4
  FILENAME_MAX_BYTES: 64,
};

export interface HeaderPacket {
  magic: number;
  filename: string;
  fileSize: number;
  totalChunks: number;
  fileCrc: number;
}

export interface DataChunkPacket {
  seq: number;
  payload: Uint8Array;
  crc32: number;
  isValid: boolean;
}

/**
 * Creates a 78-byte Header packet.
 */
export function buildHeaderPacket(
  filename: string,
  fileSize: number,
  totalChunks: number,
  fileCrc: number
): Uint8Array {
  const buffer = new Uint8Array(PROTOCOL_CONSTANTS.HEADER_SIZE);
  const view = new DataView(buffer.buffer);

  // [0-3] 4 Bytes: Magic 0xDEADBEEF
  view.setUint32(0, PROTOCOL_CONSTANTS.MAGIC_NUMBER, false);

  // [4-67] 64 Bytes: Filename UTF-8 (null-padded)
  const encodedName = new TextEncoder().encode(filename);
  const nameBytesToCopy = Math.min(encodedName.length, PROTOCOL_CONSTANTS.FILENAME_MAX_BYTES);
  buffer.set(encodedName.subarray(0, nameBytesToCopy), 4);
  // Pad remaining bytes with 0
  for (let i = 4 + nameBytesToCopy; i < 68; i++) {
    buffer[i] = 0;
  }

  // [68-71] 4 Bytes: File total size (Uint32)
  view.setUint32(68, fileSize >>> 0, false);

  // [72-73] 2 Bytes: Total chunks (Uint16)
  view.setUint16(72, totalChunks, false);

  // [74-77] 4 Bytes: File global CRC32 (Uint32)
  view.setUint32(74, fileCrc >>> 0, false);

  return buffer;
}

/**
 * Parses and validates a 78-byte Header packet.
 */
export function parseHeaderPacket(buffer: Uint8Array): HeaderPacket | null {
  if (buffer.length !== PROTOCOL_CONSTANTS.HEADER_SIZE) {
    return null;
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = view.getUint32(0, false) >>> 0;
  if (magic !== PROTOCOL_CONSTANTS.MAGIC_NUMBER) {
    return null;
  }

  // Extract filename up to first null byte
  const nameSlice = buffer.subarray(4, 68);
  let nullIdx = nameSlice.indexOf(0);
  if (nullIdx === -1) nullIdx = nameSlice.length;
  const filename = new TextDecoder('utf-8').decode(nameSlice.subarray(0, nullIdx));

  const fileSize = view.getUint32(68, false) >>> 0;
  const totalChunks = view.getUint16(72, false);
  const fileCrc = view.getUint32(74, false) >>> 0;

  return {
    magic,
    filename: filename || 'received_file.bin',
    fileSize,
    totalChunks,
    fileCrc,
  };
}

/**
 * Creates a 1030-byte Data Chunk packet.
 */
export function buildDataChunkPacket(seq: number, rawPayload: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(PROTOCOL_CONSTANTS.CHUNK_TOTAL_SIZE);
  const view = new DataView(buffer.buffer);

  // [0-1] 2 Bytes: Chunk sequence (Uint16)
  view.setUint16(0, seq, false);

  // [2-1025] 1024 Bytes: Payload (padded with 0 if shorter)
  const bytesToCopy = Math.min(rawPayload.length, PROTOCOL_CONSTANTS.CHUNK_PAYLOAD_SIZE);
  buffer.set(rawPayload.subarray(0, bytesToCopy), 2);
  // Pad with 0
  for (let i = 2 + bytesToCopy; i < 1026; i++) {
    buffer[i] = 0;
  }

  // [1026-1029] 4 Bytes: CRC32 of the 1024-byte payload area
  const payloadSlice = buffer.subarray(2, 1026);
  const chunkCrc = calculateCRC32(payloadSlice);
  view.setUint32(1026, chunkCrc >>> 0, false);

  return buffer;
}

/**
 * Parses a 1030-byte Data Chunk packet and verifies its CRC32.
 */
export function parseDataChunkPacket(buffer: Uint8Array): DataChunkPacket | null {
  if (buffer.length !== PROTOCOL_CONSTANTS.CHUNK_TOTAL_SIZE) {
    return null;
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const seq = view.getUint16(0, false);
  const payload = buffer.slice(2, 1026);
  const receivedCrc = view.getUint32(1026, false) >>> 0;

  const computedCrc = calculateCRC32(payload);
  const isValid = computedCrc === receivedCrc;

  return {
    seq,
    payload,
    crc32: receivedCrc,
    isValid,
  };
}

/**
 * Slices a complete file into header and data chunk packets.
 */
export function packFileToAcousticPackets(filename: string, fileBytes: Uint8Array): {
  header: Uint8Array;
  chunks: Uint8Array[];
  fileCrc: number;
  totalChunks: number;
} {
  const fileSize = fileBytes.length;
  const chunkSize = PROTOCOL_CONSTANTS.CHUNK_PAYLOAD_SIZE;
  const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
  const fileCrc = calculateCRC32(fileBytes);

  const header = buildHeaderPacket(filename, fileSize, totalChunks, fileCrc);
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileSize);
    const slice = fileBytes.subarray(start, end);
    const chunkPacket = buildDataChunkPacket(i, slice);
    chunks.push(chunkPacket);
  }

  return { header, chunks, fileCrc, totalChunks };
}

export interface ReceiverStats {
  status: 'idle' | 'listening' | 'header_received' | 'receiving' | 'completed' | 'error';
  filename: string | null;
  fileSize: number;
  totalChunks: number;
  receivedChunksCount: number;
  crcErrorCount: number;
  totalPacketsReceived: number;
  currentKbps: number;
  averageKbps: number;
  progressPercent: number;
  isCrcVerified: boolean | null;
  receivedBytes: number;
}

/**
 * Manages an acoustic data reception session.
 */
export class AcousticReceiverSession {
  private header: HeaderPacket | null = null;
  private chunks: Map<number, Uint8Array> = new Map();
  private crcErrorCount = 0;
  private totalPacketsReceived = 0;
  private status: ReceiverStats['status'] = 'listening';
  private startTime: number | null = null;
  private lastChunkTime: number | null = null;
  private bytesReceivedSinceLastWindow = 0;
  private lastWindowTime = performance.now();
  private currentKbps = 0;

  public onHeaderReceived?: (header: HeaderPacket) => void;
  public onChunkReceived?: (chunk: DataChunkPacket, stats: ReceiverStats) => void;
  public onCrcError?: (seq: number | null, computed: number, expected: number) => void;
  public onFileCompleted?: (fileData: Uint8Array, filename: string, isCrcValid: boolean) => void;
  public onError?: (message: string) => void;
  public onStatsUpdate?: (stats: ReceiverStats) => void;

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.header = null;
    this.chunks.clear();
    this.crcErrorCount = 0;
    this.totalPacketsReceived = 0;
    this.status = 'listening';
    this.startTime = null;
    this.lastChunkTime = null;
    this.bytesReceivedSinceLastWindow = 0;
    this.lastWindowTime = performance.now();
    this.currentKbps = 0;
    this.emitStats();
  }

  /**
   * Processes a raw ArrayBuffer received from Quiet.js.
   */
  public processRawFrame(buffer: ArrayBuffer | Uint8Array): void {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.totalPacketsReceived++;

    const now = performance.now();
    if (!this.startTime) {
      this.startTime = now;
    }

    // Rolling bitrate calculation
    this.bytesReceivedSinceLastWindow += bytes.byteLength;
    const windowElapsedSec = (now - this.lastWindowTime) / 1000;
    if (windowElapsedSec >= 0.5) {
      this.currentKbps = Math.round(((this.bytesReceivedSinceLastWindow * 8) / 1000) / windowElapsedSec);
      this.bytesReceivedSinceLastWindow = 0;
      this.lastWindowTime = now;
    }

    // 1. Check if packet is Header (78 bytes)
    if (bytes.length === PROTOCOL_CONSTANTS.HEADER_SIZE) {
      const header = parseHeaderPacket(bytes);
      if (header) {
        // If we are currently idle or listening, or starting a new transmission
        this.header = header;
        this.chunks.clear();
        this.status = 'header_received';
        if (this.onHeaderReceived) {
          this.onHeaderReceived(header);
        }
        this.emitStats();
        return;
      }
    }

    // 2. Check if packet is Data Chunk (1030 bytes)
    if (bytes.length === PROTOCOL_CONSTANTS.CHUNK_TOTAL_SIZE) {
      const chunk = parseDataChunkPacket(bytes);
      if (!chunk) {
        this.crcErrorCount++;
        if (this.onError) this.onError('Failed to parse 1030-byte chunk format');
        this.emitStats();
        return;
      }

      if (!chunk.isValid) {
        this.crcErrorCount++;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const expected = view.getUint32(1026, false) >>> 0;
        const computed = calculateCRC32(chunk.payload);
        if (this.onCrcError) {
          this.onCrcError(chunk.seq, computed, expected);
        }
        this.emitStats();
        return;
      }

      // Valid chunk!
      this.status = 'receiving';
      this.lastChunkTime = now;
      this.chunks.set(chunk.seq, chunk.payload);

      if (this.onChunkReceived) {
        this.onChunkReceived(chunk, this.getStats());
      }

      // Check if all chunks received
      if (this.header && this.chunks.size >= this.header.totalChunks) {
        this.finalizeFile();
      } else {
        this.emitStats();
      }
      return;
    }

    // Unknown or invalid packet size
    this.crcErrorCount++;
    if (this.onError) {
      this.onError(`Received unknown frame size: ${bytes.length} bytes (expected 78 or 1030)`);
    }
    this.emitStats();
  }

  /**
   * Assembles all chunks, cuts off zero-padding to match fileSize, and verifies file CRC32.
   */
  public finalizeFile(): { fileData: Uint8Array; filename: string; isCrcValid: boolean } | null {
    if (!this.header) {
      return null;
    }

    const { totalChunks, fileSize, filename, fileCrc } = this.header;
    const fullBuffer = new Uint8Array(totalChunks * PROTOCOL_CONSTANTS.CHUNK_PAYLOAD_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const chunkData = this.chunks.get(i);
      if (!chunkData) {
        // Missing a chunk
        return null;
      }
      fullBuffer.set(chunkData, i * PROTOCOL_CONSTANTS.CHUNK_PAYLOAD_SIZE);
    }

    // Truncate to exact fileSize
    const finalFileData = fullBuffer.slice(0, fileSize);
    const computedFileCrc = calculateCRC32(finalFileData);
    const isCrcValid = computedFileCrc === fileCrc;

    this.status = 'completed';
    this.emitStats();

    if (this.onFileCompleted) {
      this.onFileCompleted(finalFileData, filename, isCrcValid);
    }

    return { fileData: finalFileData, filename, isCrcValid };
  }

  public getStats(): ReceiverStats {
    const totalChunks = this.header ? this.header.totalChunks : 0;
    const receivedCount = this.chunks.size;
    const progress = totalChunks > 0 ? Math.min(100, (receivedCount / totalChunks) * 100) : 0;

    let averageKbps = 0;
    if (this.startTime && this.lastChunkTime && this.lastChunkTime > this.startTime) {
      const elapsedSec = (this.lastChunkTime - this.startTime) / 1000;
      const totalBytes = receivedCount * PROTOCOL_CONSTANTS.CHUNK_PAYLOAD_SIZE;
      averageKbps = Math.round(((totalBytes * 8) / 1000) / elapsedSec);
    }

    return {
      status: this.status,
      filename: this.header ? this.header.filename : null,
      fileSize: this.header ? this.header.fileSize : 0,
      totalChunks,
      receivedChunksCount: receivedCount,
      crcErrorCount: this.crcErrorCount,
      totalPacketsReceived: this.totalPacketsReceived,
      currentKbps: this.currentKbps,
      averageKbps,
      progressPercent: Math.round(progress * 10) / 10,
      isCrcVerified: this.status === 'completed' ? true : null,
      receivedBytes: receivedCount * PROTOCOL_CONSTANTS.CHUNK_PAYLOAD_SIZE,
    };
  }

  public getChunkMap(): boolean[] {
    if (!this.header) return [];
    const map = new Array(this.header.totalChunks).fill(false);
    for (const seq of this.chunks.keys()) {
      if (seq < map.length) map[seq] = true;
    }
    return map;
  }

  private emitStats(): void {
    if (this.onStatsUpdate) {
      this.onStatsUpdate(this.getStats());
    }
  }
}
