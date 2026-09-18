import { describe, expect, it } from 'vitest';
import { sha256BytesPure, sha256Hex } from './sha256';

const toBytes = (s: string) => new TextEncoder().encode(s);
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const KNOWN_VECTORS: Array<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];

describe('纯 JS SHA-256 回退实现', () => {
  for (const [input, expected] of KNOWN_VECTORS) {
    it(`摘要正确：${input === '' ? '空串' : `长度 ${input.length}`}`, () => {
      expect(toHex(sha256BytesPure(toBytes(input)))).toBe(expected);
    });
  }

  it('跨 64 字节块边界的长输入正确（填充恰为一块与跨两块）', () => {
    // 56 字节：追加 0x80 后恰填满一块；120 字节：长度字段落到第二块
    expect(toHex(sha256BytesPure(toBytes('a'.repeat(56))))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
    expect(toHex(sha256BytesPure(toBytes('a'.repeat(120))))).toBe(
      '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c',
    );
  });
});

describe('sha256Hex（统一入口）', () => {
  for (const [input, expected] of KNOWN_VECTORS) {
    it(`与标准向量一致：${input === '' ? '空串' : `长度 ${input.length}`}`, async () => {
      expect(await sha256Hex(toBytes(input))).toBe(expected);
    });
  }

  it('接受 ArrayBuffer 输入（File.arrayBuffer() 的形态）', async () => {
    const buf = toBytes('abc').buffer;
    expect(await sha256Hex(buf)).toBe(KNOWN_VECTORS[1][1]);
  });
});
