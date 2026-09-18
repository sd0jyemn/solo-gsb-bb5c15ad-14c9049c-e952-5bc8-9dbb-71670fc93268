import type { RedactionBox, RedactionMap } from '../types';
import { uid } from '../types';

/**
 * 遮盖方案文件（.json）格式，版本 1。
 *
 * 方案与具体源 PDF 强绑定：导入时必须通过
 *   ① 结构校验（本文件格式 / 字段类型 / 矩形定义合法）
 *   ② 文档匹配（源文件 SHA-256、页数、逐页尺寸、矩形边界）
 * 两层校验，任一项不符即拒绝且不改动现有遮盖。
 *
 * 全部处理均在浏览器本地完成，不产生任何网络请求。
 */

export const SCHEME_FORMAT = 'pdf-redaction-scheme';
export const SCHEME_VERSION = 1;
/** 合并去重的坐标容差（PDF 用户空间单位 / 点） */
export const MERGE_TOLERANCE = 0.01;

export interface SchemePage {
  /** 页码，从 1 开始 */
  page: number;
  /** 未旋转页面尺寸（点），与遮盖框坐标同一坐标系 */
  width: number;
  height: number;
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

export interface RedactionScheme {
  format: typeof SCHEME_FORMAT;
  version: typeof SCHEME_VERSION;
  /** 源 PDF 文件的 SHA-256（小写十六进制） */
  sourceHash: string;
  sourceName: string;
  numPages: number;
  /** 按页码升序，每页一条（无遮盖的页面也保留空 boxes） */
  pages: SchemePage[];
  exportedAt: string;
}

export type SchemeErrorKind = 'format' | 'mismatch';

export class SchemeError extends Error {
  readonly kind: SchemeErrorKind;
  constructor(kind: SchemeErrorKind, message: string) {
    super(message);
    this.name = 'SchemeError';
    this.kind = kind;
  }
}

/** 结构 / 格式损坏：JSON 无法解析、字段缺失或类型不符、矩形定义不合法 */
export const formatError = (message: string) => new SchemeError('format', message);
/** 文档不匹配：哈希、页数、页尺寸或矩形边界与当前文档不一致 */
export const mismatchError = (message: string) => new SchemeError('mismatch', message);

/* ------------------------------ 导出 ------------------------------ */

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * 依据当前文档构建方案对象。
 * @param pageSizes 每页未旋转尺寸（点），长度必须等于 numPages
 * @param redactions 现有遮盖（PDF 页面坐标）
 */
export function buildScheme(
  sourceHash: string,
  sourceName: string,
  numPages: number,
  pageSizes: ReadonlyArray<{ width: number; height: number }>,
  redactions: RedactionMap,
): RedactionScheme {
  const pages: SchemePage[] = [];
  for (let n = 1; n <= numPages; n += 1) {
    const { width, height } = pageSizes[n - 1];
    const boxes: SchemePage['boxes'] = [];
    for (const b of redactions[n] ?? []) {
      // 导出时归一化并夹取到页面范围内（绘制边界可能有极小越界），
      // 保证再导入时矩形边界校验必然通过。
      const x1 = Math.min(Math.max(b.x1, 0), width);
      const y1 = Math.min(Math.max(b.y1, 0), height);
      const x2 = Math.min(Math.max(b.x2, 0), width);
      const y2 = Math.min(Math.max(b.y2, 0), height);
      const loX = Math.min(x1, x2);
      const hiX = Math.max(x1, x2);
      const loY = Math.min(y1, y2);
      const hiY = Math.max(y1, y2);
      // 退化矩形（面积为 0）不写入方案
      if (hiX - loX <= 0 || hiY - loY <= 0) continue;
      boxes.push({ x1: loX, y1: loY, x2: hiX, y2: hiY });
    }
    pages.push({ page: n, width, height, boxes });
  }
  return {
    format: SCHEME_FORMAT,
    version: SCHEME_VERSION,
    sourceHash,
    sourceName,
    numPages,
    pages,
    exportedAt: new Date().toISOString(),
  };
}

export function serializeScheme(scheme: RedactionScheme): string {
  return JSON.stringify(scheme, null, 2);
}

/** 触发浏览器下载方案 JSON（纯本地） */
export function downloadScheme(scheme: RedactionScheme): void {
  const blob = new Blob([serializeScheme(scheme)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scheme.sourceName.replace(/\.pdf$/i, '') || 'document'}_遮盖方案.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------ 导入：结构校验 ------------------------------ */

const HEX_SHA256 = /^[a-f0-9]{64}$/;

function isRectObject(v: unknown): v is SchemePage['boxes'][number] {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isFiniteNumber(r.x1) &&
    isFiniteNumber(r.y1) &&
    isFiniteNumber(r.x2) &&
    isFiniteNumber(r.y2)
  );
}

/**
 * 解析并校验方案文件的结构（不涉及当前文档）。
 * JSON 语法错误、顶层结构错误、字段类型 / 取值错误、矩形坐标顺序错误等
 * 一律归类为 format（格式损坏）。
 */
export function parseScheme(jsonText: string): RedactionScheme {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw formatError('文件不是有效的 JSON，方案文件可能已损坏。');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw formatError('方案顶层结构无效，文件可能已损坏。');
  }
  const o = raw as Record<string, unknown>;

  if (o.format !== SCHEME_FORMAT) {
    throw formatError('不是本工具导出的遮盖方案文件（缺少 format 标识）。');
  }
  if (o.version !== SCHEME_VERSION) {
    if (typeof o.version === 'number') {
      throw formatError(`方案版本 ${o.version} 不受支持（支持版本 ${SCHEME_VERSION}）。`);
    }
    throw formatError('方案版本字段缺失或无效。');
  }
  if (typeof o.sourceHash !== 'string' || !HEX_SHA256.test(o.sourceHash)) {
    throw formatError('源文件哈希字段缺失或格式无效（应为 64 位十六进制 SHA-256）。');
  }
  if (typeof o.sourceName !== 'string') {
    throw formatError('源文件名字段缺失或无效。');
  }
  if (!isFiniteNumber(o.numPages) || !Number.isInteger(o.numPages) || o.numPages <= 0) {
    throw formatError('页数字段缺失或无效。');
  }
  if (typeof o.exportedAt !== 'string') {
    throw formatError('导出时间字段缺失或无效。');
  }
  if (!Array.isArray(o.pages)) {
    throw formatError('页面列表字段缺失或不是数组。');
  }

  const pages = o.pages as unknown[];
  if (pages.length !== o.numPages) {
    throw formatError(
      `页面条目数（${pages.length}）与页数（${o.numPages}）不一致，文件已损坏。`,
    );
  }

  const parsedPages: SchemePage[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw formatError(`第 ${i + 1} 页的页面记录结构无效。`);
    }
    const pg = p as Record<string, unknown>;
    if (pg.page !== i + 1) {
      throw formatError(`第 ${i + 1} 条页面记录的页码不是 ${i + 1}，文件已损坏。`);
    }
    if (!isFiniteNumber(pg.width) || pg.width <= 0 || !isFiniteNumber(pg.height) || pg.height <= 0) {
      throw formatError(`第 ${i + 1} 页的页面尺寸缺失或无效。`);
    }
    if (!Array.isArray(pg.boxes)) {
      throw formatError(`第 ${i + 1} 页的遮盖框列表缺失或不是数组。`);
    }
    const boxes: SchemePage['boxes'] = [];
    for (const br of pg.boxes as unknown[]) {
      if (!isRectObject(br)) {
        throw formatError(`第 ${i + 1} 页存在格式无效的遮盖框（坐标缺失或不是数字）。`);
      }
      if (!(br.x1 < br.x2) || !(br.y1 < br.y2)) {
        throw formatError(`第 ${i + 1} 页存在宽高为 0 或坐标颠倒的遮盖框，文件已损坏。`);
      }
      boxes.push({ x1: br.x1, y1: br.y1, x2: br.x2, y2: br.y2 });
    }
    parsedPages.push({
      page: pg.page,
      width: pg.width,
      height: pg.height,
      boxes,
    });
  }

  return {
    format: SCHEME_FORMAT,
    version: SCHEME_VERSION,
    sourceHash: o.sourceHash,
    sourceName: o.sourceName,
    numPages: o.numPages,
    pages: parsedPages,
    exportedAt: o.exportedAt,
  };
}

/* ------------------------------ 导入：文档匹配 ------------------------------ */

/**
 * 结构合法的方案与当前文档逐项比对：
 * 哈希 → 页数 → 每页尺寸 → 每个矩形是否落在对应页面范围内。
 * 任一不符归类为 mismatch（文档不匹配），与“格式损坏”区分。
 */
export function validateSchemeMatch(
  scheme: RedactionScheme,
  currentHash: string,
  pageSizes: ReadonlyArray<{ width: number; height: number }>,
): void {
  if (scheme.sourceHash.toLowerCase() !== currentHash.toLowerCase()) {
    throw mismatchError(
      scheme.sourceName
        ? `方案是为另一个 PDF（${scheme.sourceName}）制作的，源文件哈希与当前文档不一致。`
        : '方案的源文件哈希与当前 PDF 不一致，无法导入。',
    );
  }

  if (pageSizes.length !== scheme.numPages) {
    throw mismatchError(
      `页数不一致：方案为 ${scheme.numPages} 页，当前文档为 ${pageSizes.length} 页。`,
    );
  }

  for (let i = 0; i < scheme.pages.length; i += 1) {
    const sp = scheme.pages[i];
    const cp = pageSizes[i];
    if (cp.width !== sp.width || cp.height !== sp.height) {
      throw mismatchError(
        `第 ${sp.page} 页尺寸不一致：方案为 ${formatSize(sp.width, sp.height)}，` +
          `当前文档为 ${formatSize(cp.width, cp.height)}，不是同一份 PDF。`,
      );
    }
    for (const b of sp.boxes) {
      const outside =
        b.x1 < 0 || b.y1 < 0 || b.x2 > sp.width + MERGE_TOLERANCE || b.y2 > sp.height + MERGE_TOLERANCE;
      if (outside) {
        throw mismatchError(
          `第 ${sp.page} 页存在超出页面边界的遮盖框，方案与当前文档不匹配。`,
        );
      }
    }
  }
}

const formatSize = (w: number, h: number) => `${trimNum(w)} × ${trimNum(h)} 点`;
const trimNum = (n: number) => `${Math.round(n * 100) / 100}`;

/* ------------------------------ 应用方案 ------------------------------ */

/** “替换”：方案即新的全部遮盖（每页生成全新 id），一次提交即可撤销 */
export function schemeToRedactionMap(scheme: RedactionScheme): RedactionMap {
  const map: RedactionMap = {};
  for (const p of scheme.pages) {
    if (p.boxes.length === 0) continue;
    map[p.page] = p.boxes.map<RedactionBox>((b) => ({ id: uid(), ...b }));
  }
  return map;
}

/**
 * “合并”：保留现有遮盖，追加方案中的遮盖；
 * 按页去重：与同页任一已有矩形在四个坐标上的差值都不超过 MERGE_TOLERANCE（0.01 点）
 * 即视为重复并跳过（方案内部彼此重复的矩形也一并去重）。
 */
export function mergeScheme(
  base: RedactionMap,
  scheme: RedactionScheme,
): { map: RedactionMap; added: number; skipped: number } {
  const map: RedactionMap = {};
  // 每页已保留的矩形（现有 + 本次新增），用于容差去重
  const rectsByPage = new Map<number, SchemePage['boxes']>();
  let added = 0;
  let skipped = 0;

  for (const key of Object.keys(base)) {
    const n = Number(key);
    const boxes = base[n] ?? [];
    map[n] = boxes.map((b) => ({ ...b }));
    rectsByPage.set(n, boxes.map((b) => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 })));
  }

  const sameWithinTolerance = (
    a: SchemePage['boxes'][number],
    b: SchemePage['boxes'][number],
  ): boolean =>
    Math.abs(a.x1 - b.x1) <= MERGE_TOLERANCE &&
    Math.abs(a.y1 - b.y1) <= MERGE_TOLERANCE &&
    Math.abs(a.x2 - b.x2) <= MERGE_TOLERANCE &&
    Math.abs(a.y2 - b.y2) <= MERGE_TOLERANCE;

  for (const sp of scheme.pages) {
    const known = rectsByPage.get(sp.page) ?? [];
    const list = map[sp.page] ?? [];
    for (const b of sp.boxes) {
      if (known.some((k) => sameWithinTolerance(k, b))) {
        skipped += 1;
        continue;
      }
      known.push(b);
      list.push({ id: uid(), ...b });
      added += 1;
    }
    if (list.length > 0) {
      map[sp.page] = list;
      rectsByPage.set(sp.page, known);
    }
  }

  return { map, added, skipped };
}

/** 方案中遮盖框总数（用于导入确认提示） */
export function countSchemeBoxes(scheme: RedactionScheme): number {
  return scheme.pages.reduce((sum, p) => sum + p.boxes.length, 0);
}
