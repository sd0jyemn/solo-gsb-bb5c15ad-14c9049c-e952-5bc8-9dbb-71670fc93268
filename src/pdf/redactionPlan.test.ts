import { describe, expect, it } from 'vitest';
import type { RedactionMap } from '../types';
import {
  COORD_TOLERANCE,
  PlanError,
  buildPlan,
  mergeRedactions,
  parsePlan,
  planToRedactionMap,
  rectsEqualWithin,
  validatePlanForDocument,
  type RedactionPlan,
} from './redactionPlan';
import { sha256Hex, sha256HexSync } from './sha256';

const HASH = 'a'.repeat(64);
const SIZES = [
  { width: 612, height: 792 },
  { width: 612, height: 792 },
];

const enc = new TextEncoder();

describe('SHA-256', () => {
  it('纯 TS 实现匹配公开测试向量', () => {
    expect(sha256HexSync(enc.encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256HexSync(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // 56 字节，跨两个分块
    expect(sha256HexSync(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256HexSync(enc.encode('a'.repeat(1_000_000)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('各种长度（含 64 字节边界）下纯 TS 实现与 WebCrypto 一致', async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);
      const expected = await sha256Hex(bytes.buffer as ArrayBuffer); // 走 crypto.subtle
      expect(sha256HexSync(bytes)).toBe(expected);
    }
  });
});

describe('buildPlan / parsePlan 往返', () => {
  it('导出时把越界框裁剪进页面、丢弃退化框，序列化后可原样解析', () => {
    const redactions: RedactionMap = {
      1: [
        { id: 'a', x1: 10, y1: 20, x2: 100, y2: 60 },
        { id: 'b', x1: -50, y1: 700, x2: 700, y2: 800 }, // 越界 -> 裁剪
        { id: 'c', x1: 500, y1: 500, x2: 500, y2: 600 }, // 零宽 -> 丢弃
      ],
      2: [{ id: 'd', x1: 1, y1: 1, x2: 2, y2: 2 }],
    };
    const plan = buildPlan(HASH, SIZES, redactions);
    expect(plan.format).toBe('pdf-redaction-plan');
    expect(plan.version).toBe(1);
    expect(plan.sourceSha256).toBe(HASH);
    expect(plan.pageSizes).toEqual(SIZES);
    expect(plan.boxes['1']).toEqual([
      { x1: 10, y1: 20, x2: 100, y2: 60 },
      { x1: 0, y1: 700, x2: 612, y2: 792 },
    ]);
    expect(plan.boxes['2']).toEqual([{ x1: 1, y1: 1, x2: 2, y2: 2 }]);

    const parsed = parsePlan(JSON.stringify(plan));
    expect(parsed).toEqual(plan);
  });

  it('页码超出 pageSizes 范围的遮盖框在导出时被忽略', () => {
    const plan = buildPlan(HASH, SIZES, { 5: [{ id: 'x', x1: 1, y1: 1, x2: 2, y2: 2 }] });
    expect(plan.boxes).toEqual({});
  });
});

/** 捕获 parsePlan 抛出的 PlanError 并断言类别 */
function expectPlanError(fn: () => unknown, kind: 'format' | 'mismatch'): PlanError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanError);
    expect((e as PlanError).kind).toBe(kind);
    return e as PlanError;
  }
  throw new Error('应当抛出 PlanError');
}

const validPlan = (): RedactionPlan => ({
  format: 'pdf-redaction-plan',
  version: 1,
  sourceSha256: HASH,
  pageSizes: SIZES.map((s) => ({ ...s })),
  boxes: { 1: [{ x1: 10, y1: 20, x2: 100, y2: 60 }] },
});

describe('parsePlan 结构校验（格式损坏）', () => {
  it('合法方案通过校验', () => {
    expect(parsePlan(JSON.stringify(validPlan()))).toEqual(validPlan());
  });

  it('非 JSON / 非对象 / 缺字段一律报格式错误', () => {
    expectPlanError(() => parsePlan('not json {'), 'format');
    expectPlanError(() => parsePlan('[]'), 'format');
    expectPlanError(() => parsePlan('42'), 'format');
    expectPlanError(() => parsePlan('{}'), 'format'); // 缺 format 标识
    expectPlanError(() => parsePlan(JSON.stringify({ ...validPlan(), format: 'other' })), 'format');
  });

  it('版本不符报格式错误', () => {
    expectPlanError(() => parsePlan(JSON.stringify({ ...validPlan(), version: 2 })), 'format');
    expectPlanError(() => parsePlan(JSON.stringify({ ...validPlan(), version: '1' })), 'format');
  });

  it('哈希缺失或不是 64 位小写十六进制报格式错误', () => {
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...validPlan(), sourceSha256: 'abc' })),
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...validPlan(), sourceSha256: 'A'.repeat(64) })),
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...validPlan(), sourceSha256: 123 })),
      'format',
    );
  });

  it('pageSizes 缺失、为空或含非正数尺寸报格式错误', () => {
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...validPlan(), pageSizes: [] })),
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...validPlan(), pageSizes: [{ width: -1, height: 5 }] })),
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...validPlan(), pageSizes: [{ width: '612', height: 792 }] })),
      'format',
    );
  });

  it('boxes 结构非法（页码越界、非数组、坐标缺失、退化矩形）报格式错误', () => {
    const plan = validPlan();
    expectPlanError(() => parsePlan(JSON.stringify({ ...plan, boxes: [] })), 'format');
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...plan, boxes: { 0: plan.boxes['1'] } })),
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...plan, boxes: { 3: plan.boxes['1'] } })), // 只有 2 页
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...plan, boxes: { 1: 'x' } })),
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...plan, boxes: { 1: [{ x1: 1, y1: 1, x2: 2 }] } })),
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...plan, boxes: { 1: [{ x1: 5, y1: 1, x2: 5, y2: 2 }] } })),
      'format',
    );
    expectPlanError(
      () => parsePlan(JSON.stringify({ ...plan, boxes: { 1: [{ x1: 9, y1: 1, x2: 2, y2: 2 }] } })),
      'format',
    );
  });
});

describe('validatePlanForDocument 文档匹配校验', () => {
  const doc = { sha256: HASH, pageSizes: SIZES };

  it('哈希、页数、尺寸、边界全部一致时通过', () => {
    expect(() => validatePlanForDocument(validPlan(), doc)).not.toThrow();
  });

  it('源文件哈希不一致 -> 文档不匹配', () => {
    const e = expectPlanError(
      () => validatePlanForDocument(validPlan(), { ...doc, sha256: 'b'.repeat(64) }),
      'mismatch',
    );
    expect(e.message).toContain('SHA-256');
  });

  it('页数不一致 -> 文档不匹配', () => {
    const e = expectPlanError(
      () => validatePlanForDocument(validPlan(), { ...doc, pageSizes: [SIZES[0]] }),
      'mismatch',
    );
    expect(e.message).toContain('页数');
  });

  it('某页尺寸超出容差 -> 文档不匹配；容差内（0.01 点）放行', () => {
    const bigger = [
      { width: 612, height: 792 },
      { width: 612.5, height: 792 },
    ];
    const e = expectPlanError(
      () => validatePlanForDocument(validPlan(), { ...doc, pageSizes: bigger }),
      'mismatch',
    );
    expect(e.message).toContain('第 2 页尺寸');

    const within = [
      { width: 612, height: 792 },
      { width: 612 + COORD_TOLERANCE, height: 792 - COORD_TOLERANCE },
    ];
    expect(() => validatePlanForDocument(validPlan(), { ...doc, pageSizes: within })).not.toThrow();
  });

  it('遮盖框超出页面边界 -> 文档不匹配；边界上或容差内放行', () => {
    const out = validPlan();
    out.boxes = { 2: [{ x1: 10, y1: 10, x2: 612.5, y2: 60 }] };
    const e = expectPlanError(() => validatePlanForDocument(out, doc), 'mismatch');
    expect(e.message).toContain('超出页面边界');

    const onEdge = validPlan();
    onEdge.boxes = { 2: [{ x1: 0, y1: 0, x2: 612, y2: 792 }] };
    expect(() => validatePlanForDocument(onEdge, doc)).not.toThrow();

    const slight = validPlan();
    slight.boxes = { 2: [{ x1: -COORD_TOLERANCE, y1: 0, x2: 612 + COORD_TOLERANCE, y2: 792 }] };
    expect(() => validatePlanForDocument(slight, doc)).not.toThrow();
  });
});

describe('planToRedactionMap', () => {
  it('实例化时分配新 id 并把容差内的轻微越界裁剪进页面', () => {
    const plan = validPlan();
    plan.boxes = { 1: [{ x1: -0.005, y1: 10, x2: 612.005, y2: 60 }] };
    const map = planToRedactionMap(plan);
    const boxes = map[1];
    expect(boxes).toHaveLength(1);
    expect(boxes[0].id).toBeTruthy();
    expect(boxes[0]).toMatchObject({ x1: 0, y1: 10, x2: 612, y2: 60 });
  });
});

describe('mergeRedactions 按页及坐标容差 0.01 去重', () => {
  const box = (id: string, x1: number, y1: number, x2: number, y2: number) => ({
    id,
    x1,
    y1,
    x2,
    y2,
  });

  it('容差内视为重复跳过，容差外保留；按页独立判断', () => {
    const base: RedactionMap = { 1: [box('a', 10, 10, 100, 50)] };
    const incoming: RedactionMap = {
      1: [
        box('b', 10.005, 9.995, 100.005, 49.995), // 容差内 -> 跳过
        box('c', 10.05, 10, 100, 50), // 超出容差 -> 新增
      ],
      2: [box('d', 10, 10, 100, 50)], // 不同页，坐标相同也算新框
    };
    const { merged, added, skipped } = mergeRedactions(base, incoming);
    expect(added).toBe(2);
    expect(skipped).toBe(1);
    expect(merged[1].map((b) => b.id)).toEqual(['a', 'c']);
    expect(merged[2].map((b) => b.id)).toEqual(['d']);
    // 不改动入参
    expect(base[1].map((b) => b.id)).toEqual(['a']);
  });

  it('恰好在容差边界（0.01）上视为重复', () => {
    expect(
      rectsEqualWithin(
        { x1: 10, y1: 10, x2: 100, y2: 50 },
        { x1: 10 + COORD_TOLERANCE, y1: 10, x2: 100, y2: 50 },
        COORD_TOLERANCE,
      ),
    ).toBe(true);
    expect(
      rectsEqualWithin(
        { x1: 10, y1: 10, x2: 100, y2: 50 },
        { x1: 10 + COORD_TOLERANCE + 0.001, y1: 10, x2: 100, y2: 50 },
        COORD_TOLERANCE,
      ),
    ).toBe(false);
  });

  it('方案文件内部的重复框在合并时同样被去重', () => {
    const incoming: RedactionMap = {
      1: [box('a', 10, 10, 100, 50), box('b', 10, 10, 100, 50)],
    };
    const { merged, added, skipped } = mergeRedactions({}, incoming);
    expect(added).toBe(1);
    expect(skipped).toBe(1);
    expect(merged[1]).toHaveLength(1);
  });

  it('全部重复时不产生任何新增', () => {
    const base: RedactionMap = { 1: [box('a', 10, 10, 100, 50)] };
    const { merged, added, skipped } = mergeRedactions(base, {
      1: [box('b', 10, 10, 100, 50)],
    });
    expect(added).toBe(0);
    expect(skipped).toBe(1);
    expect(merged[1]).toHaveLength(1);
  });
});
