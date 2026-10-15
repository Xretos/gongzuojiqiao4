import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCRC32,
  buildHeaderPacket,
  parseHeaderPacket,
  buildDataChunkPacket,
  parseDataChunkPacket,
  packFileToAcousticPackets,
  AcousticReceiverSession,
  PROTOCOL_CONSTANTS,
} from './protocol.ts';

test('CRC32 standard test vector "123456789" matches 0xCBF43926', () => {
  const input = new TextEncoder().encode('123456789');
  const crc = calculateCRC32(input);
  assert.equal(crc, 0xCBF43926);
});

test('Header packet builds exactly 78 bytes and parses accurately', () => {
  const filename = 'test_firmware_v1.bin';
  const fileSize = 2050; // Needs 3 chunks: 1024 + 1024 + 2
  const totalChunks = 3;
  const fileCrc = 0xA1B2C3D4;

  const packet = buildHeaderPacket(filename, fileSize, totalChunks, fileCrc);
  assert.equal(packet.length, PROTOCOL_CONSTANTS.HEADER_SIZE);
  assert.equal(packet.length, 78);

  const parsed = parseHeaderPacket(packet);
  assert.notEqual(parsed, null);
  assert.equal(parsed!.magic, PROTOCOL_CONSTANTS.MAGIC_NUMBER);
  assert.equal(parsed!.filename, filename);
  assert.equal(parsed!.fileSize, fileSize);
  assert.equal(parsed!.totalChunks, totalChunks);
  assert.equal(parsed!.fileCrc, fileCrc);
});

test('Header packet rejects non-78 bytes or wrong magic number', () => {
  const badLen = new Uint8Array(77);
  assert.equal(parseHeaderPacket(badLen), null);

  const packet = buildHeaderPacket('file.txt', 100, 1, 1234);
  packet[0] = 0x00; // corrupt magic number
  assert.equal(parseHeaderPacket(packet), null);
});

test('Data chunk packet builds 1030 bytes and validates CRC32', () => {
  const seq = 42;
  const rawPayload = new Uint8Array(500);
  for (let i = 0; i < 500; i++) rawPayload[i] = (i * 7) & 0xFF;

  const chunk = buildDataChunkPacket(seq, rawPayload);
  assert.equal(chunk.length, PROTOCOL_CONSTANTS.CHUNK_TOTAL_SIZE);
  assert.equal(chunk.length, 1030);

  const parsed = parseDataChunkPacket(chunk);
  assert.notEqual(parsed, null);
  assert.equal(parsed!.seq, seq);
  assert.equal(parsed!.payload.length, PROTOCOL_CONSTANTS.CHUNK_PAYLOAD_SIZE);
  assert.equal(parsed!.isValid, true);

  // Corrupt one byte of payload
  chunk[50] = (chunk[50] ^ 0xFF);
  const corrupted = parseDataChunkPacket(chunk);
  assert.notEqual(corrupted, null);
  assert.equal(corrupted!.isValid, false);
});

test('End-to-end file packing, reception session, reassembly and CRC verification', () => {
  const originalData = new Uint8Array(3500);
  for (let i = 0; i < 3500; i++) {
    originalData[i] = (i ^ 0x5A) & 0xFF;
  }
  const filename = 'sample_acoustic_audio.wav';

  const { header, chunks, fileCrc, totalChunks } = packFileToAcousticPackets(filename, originalData);
  assert.equal(totalChunks, 4); // ceil(3500 / 1024) = 4

  const session = new AcousticReceiverSession();
  let completedFile: Uint8Array | null = null;
  let isVerified = false;

  session.onFileCompleted = (fileData, fname, isValid) => {
    completedFile = fileData;
    isVerified = isValid;
    assert.equal(fname, filename);
  };

  // Process header
  session.processRawFrame(header);
  assert.equal(session.getStats().status, 'header_received');
  assert.equal(session.getStats().totalChunks, 4);

  // Process chunks out of order: 2, 0, 3, 1
  session.processRawFrame(chunks[2]);
  session.processRawFrame(chunks[0]);
  session.processRawFrame(chunks[3]);
  session.processRawFrame(chunks[1]);

  assert.equal(session.getStats().status, 'completed');
  assert.equal(session.getStats().receivedChunksCount, 4);
  assert.equal(session.getStats().crcErrorCount, 0);
  assert.equal(isVerified, true);
  assert.notEqual(completedFile, null);
  assert.equal(completedFile!.length, originalData.length);
  assert.deepEqual(completedFile, originalData);
});

test('Session tracks CRC errors and frame errors correctly', () => {
  const session = new AcousticReceiverSession();
  
  // Corrupt packet length
  session.processRawFrame(new Uint8Array(200));
  assert.equal(session.getStats().crcErrorCount, 1);

  // Send header
  const header = buildHeaderPacket('doc.pdf', 1000, 1, 0x11223344);
  session.processRawFrame(header);

  // Send chunk with corrupted CRC
  const chunk = buildDataChunkPacket(0, new Uint8Array(500));
  chunk[1027] ^= 0x55; // alter CRC byte
  session.processRawFrame(chunk);

  assert.equal(session.getStats().crcErrorCount, 2);
  assert.equal(session.getStats().receivedChunksCount, 0);
});
