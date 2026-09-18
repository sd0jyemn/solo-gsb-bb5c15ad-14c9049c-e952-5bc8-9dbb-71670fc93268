import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RedactionBox, RedactionMap } from '../types';
import { uid } from '../types';

/**
 * 遮盖方案文件（JSON）：把当前文档的全部遮盖框保存到本地，或从本地恢复。
 * 方案与源 PDF 一一绑定——记录源文件 SHA-256 与各页尺寸，导入时逐项校验，
 * 任何一项不符都拒绝导入且不影响当前编辑状态。全程在浏览器本地完成。
 */

export const PLAN_FORMAT = 'pdf-redaction-plan';
export const PLAN_VERSION = 1;
/** 页尺寸比对、矩形边界校验与合并去重共用的坐标容差（点，1 点 = 1/72 英寸） */
export const COORD_TOLERANCE = 0.01;

export interface PlanPageSize {
  width: number;
  height: number;
}

export interface PlanRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RedactionPlan {
  format: typeof PLAN_FORMAT;
  version: number;
  /** 源 PDF 的 SHA-256（小写十六进制） */
  sourceSha256: string;
  /** 各页尺寸（点），下标 0 对应第 1 页；与遮盖框同为未旋转的页面坐标系 */
  pageSizes: PlanPageSize[];
  /** 页码（从 1 开始的字符串） -> 该页的遮盖框列表 */
  boxes: Record<string, PlanRect[]>;
}

/** 导入失败类别：format = 文件损坏 / 格式不符；mismatch = 方案与当前文档不匹配 */
export type PlanErrorKind = 'format' | 'mismatch';

export class PlanError extends Error {
  readonly kind: PlanErrorKind;

  constructor(kind: PlanErrorKind, message: string) {
    super(message);
    this.name = 'PlanError';
    this.kind = kind;
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

/* ---------------- 导出 ---------------- */

/**
 * 由当前编辑状态构造方案。遮盖框裁剪到页面范围内（画布拖拽可能产生略微越界的框，
 * 裁剪保证导出的方案再次导入时一定能通过边界校验）；裁剪后退化（零面积）的框丢弃。
 */
export function buildPlan(
  sourceSha256: string,
  pageSizes: PlanPageSize[],
  redactions: RedactionMap,
): RedactionPlan {
  const boxes: Record<string, PlanRect[]> = {};
  for (const [key, list] of Object.entries(redactions)) {
    const size = pageSizes[Number(key) - 1];
    if (!size || list.length === 0) continue;
    const rects: PlanRect[] = [];
    for (const b of list) {
      const r: PlanRect = {
        x1: clamp(Math.min(b.x1, b.x2), 0, size.width),
        y1: clamp(Math.min(b.y1, b.y2), 0, size.height),
        x2: clamp(Math.max(b.x1, b.x2), 0, size.width),
        y2: clamp(Math.max(b.y1, b.y2), 0, size.height),
      };
      if (r.x2 - r.x1 > 0 && r.y2 - r.y1 > 0) rects.push(r);
    }
    if (rects.length > 0) boxes[key] = rects;
  }
  return { format: PLAN_FORMAT, version: PLAN_VERSION, sourceSha256, pageSizes, boxes };
}

/** 下载方案 JSON 文件（纯本地，不经过网络） */
export function downloadPlan(plan: RedactionPlan, sourceName: string): void {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sourceName.replace(/\.pdf$/i, '') || 'document'}_遮盖方案.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- 解析与结构校验 ---------------- */

function parsePageSizes(raw: unknown): PlanPageSize[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PlanError('format', 'pageSizes 缺失或不是非空数组');
  }
  return raw.map((item, i) => {
    const s = item as Record<string, unknown> | null;
    if (
      typeof s !== 'object' ||
      s === null ||
      !isFiniteNumber(s.width) ||
      !isFiniteNumber(s.height) ||
      s.width <= 0 ||
      s.height <= 0
    ) {
      throw new PlanError('format', `第 ${i + 1} 页尺寸缺失或不是正数`);
    }
    return { width: s.width, height: s.height };
  });
}

function parseBoxes(raw: unknown, numPages: number): Record<string, PlanRect[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlanError('format', 'boxes 缺失或不是对象');
  }
  const boxes: Record<string, PlanRect[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1 || page > numPages) {
      throw new PlanError('format', `遮盖框页码「${key}」不是 1 到 ${numPages} 之间的整数`);
    }
    if (!Array.isArray(value)) {
      throw new PlanError('format', `第 ${page} 页的遮盖框不是数组`);
    }
    const rects = value.map((item, i) => {
      const r = item as Record<string, unknown> | null;
      if (
        typeof r !== 'object' ||
        r === null ||
        !isFiniteNumber(r.x1) ||
        !isFiniteNumber(r.y1) ||
        !isFiniteNumber(r.x2) ||
        !isFiniteNumber(r.y2)
      ) {
        throw new PlanError('format', `第 ${page} 页第 ${i + 1} 个遮盖框坐标缺失或不是数字`);
      }
      if (r.x1 >= r.x2 || r.y1 >= r.y2) {
        throw new PlanError('format', `第 ${page} 页第 ${i + 1} 个遮盖框不是有效矩形（要求 x1<x2 且 y1<y2）`);
      }
      return { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 };
    });
    if (rects.length > 0) boxes[key] = rects;
  }
  return boxes;
}

/**
 * 解析并做结构校验（不依赖任何文档）。解析失败抛出 kind 为 'format' 的 PlanError，
 * 表示文件损坏、被篡改或根本不是本应用导出的方案。
 */
export function parsePlan(text: string): RedactionPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PlanError('format', '不是有效的 JSON 文件');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlanError('format', '顶层必须是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== PLAN_FORMAT) {
    throw new PlanError('format', '缺少方案标识（format 字段），可能不是本应用导出的遮盖方案');
  }
  if (obj.version !== PLAN_VERSION) {
    throw new PlanError(
      'format',
      `不支持的方案版本 ${JSON.stringify(obj.version)}（当前应用支持版本 ${PLAN_VERSION}）`,
    );
  }
  if (typeof obj.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(obj.sourceSha256)) {
    throw new PlanError('format', '源文件 SHA-256 缺失或不是 64 位小写十六进制');
  }
  const pageSizes = parsePageSizes(obj.pageSizes);
  const boxes = parseBoxes(obj.boxes, pageSizes.length);
  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    sourceSha256: obj.sourceSha256,
    pageSizes,
    boxes,
  };
}

/* ---------------- 与当前文档比对 ---------------- */

export interface DocumentShape {
  /** 当前打开的源文件 SHA-256（小写十六进制） */
  sha256: string;
  pageSizes: PlanPageSize[];
}

/**
 * 校验方案是否对应当前文档：源文件哈希、页数、每页尺寸、每个矩形的页面边界。
 * 任一项不符抛出 kind 为 'mismatch' 的 PlanError，调用方应保持现状、不做任何改动。
 */
export function validatePlanForDocument(plan: RedactionPlan, doc: DocumentShape): void {
  if (plan.sourceSha256 !== doc.sha256) {
    throw new PlanError('mismatch', '方案对应的源文件与当前打开的 PDF 不同（SHA-256 不一致）');
  }
  if (plan.pageSizes.length !== doc.pageSizes.length) {
    throw new PlanError(
      'mismatch',
      `页数不一致：方案 ${plan.pageSizes.length} 页，当前文档 ${doc.pageSizes.length} 页`,
    );
  }
  for (let i = 0; i < plan.pageSizes.length; i += 1) {
    const a = plan.pageSizes[i];
    const b = doc.pageSizes[i];
    if (
      Math.abs(a.width - b.width) > COORD_TOLERANCE ||
      Math.abs(a.height - b.height) > COORD_TOLERANCE
    ) {
      throw new PlanError(
        'mismatch',
        `第 ${i + 1} 页尺寸不一致：方案 ${a.width}×${a.height}，当前文档 ${b.width}×${b.height}`,
      );
    }
  }
  for (const [key, rects] of Object.entries(plan.boxes)) {
    const page = Number(key);
    const size = doc.pageSizes[page - 1];
    for (let i = 0; i < rects.length; i += 1) {
      const r = rects[i];
      if (
        r.x1 < -COORD_TOLERANCE ||
        r.y1 < -COORD_TOLERANCE ||
        r.x2 > size.width + COORD_TOLERANCE ||
        r.y2 > size.height + COORD_TOLERANCE
      ) {
        throw new PlanError(
          'mismatch',
          `第 ${page} 页第 ${i + 1} 个遮盖框超出页面边界（${size.width}×${size.height}）`,
        );
      }
    }
  }
}

/** 读取文档各页尺寸（未旋转的页面坐标系，与遮盖框坐标一致） */
export async function collectPageSizes(pdf: PDFDocumentProxy): Promise<PlanPageSize[]> {
  const sizes: PlanPageSize[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    sizes.push({ width: viewport.width, height: viewport.height });
  }
  return sizes;
}

/* ---------------- 应用到编辑状态 ---------------- */

/** 把方案中的遮盖框实例化为编辑状态（分配新 id，并裁剪进页面范围） */
export function planToRedactionMap(plan: RedactionPlan): RedactionMap {
  const map: RedactionMap = {};
  for (const [key, rects] of Object.entries(plan.boxes)) {
    const page = Number(key);
    const size = plan.pageSizes[page - 1];
    const list: RedactionBox[] = rects.map((r) => ({
      id: uid(),
      x1: clamp(r.x1, 0, size.width),
      y1: clamp(r.y1, 0, size.height),
      x2: clamp(r.x2, 0, size.width),
      y2: clamp(r.y2, 0, size.height),
    }));
    if (list.length > 0) map[page] = list;
  }
  return map;
}

/** 两个矩形四个坐标分量都在容差内视为同一个框 */
export function rectsEqualWithin(a: PlanRect, b: PlanRect, tolerance: number): boolean {
  return (
    Math.abs(a.x1 - b.x1) <= tolerance &&
    Math.abs(a.y1 - b.y1) <= tolerance &&
    Math.abs(a.x2 - b.x2) <= tolerance &&
    Math.abs(a.y2 - b.y2) <= tolerance
  );
}

export interface MergeResult {
  merged: RedactionMap;
  /** 实际新增的框数 */
  added: number;
  /** 因与现有（或同批已并入的）框坐标相同而跳过的框数 */
  skipped: number;
}

/**
 * 合并：在现有遮盖基础上追加方案中的框，按页及坐标容差 0.01 去重。
 * 返回全新的 RedactionMap，调用方一次提交即可把整次导入记为一条撤销记录。
 */
export function mergeRedactions(
  base: RedactionMap,
  incoming: RedactionMap,
  tolerance: number = COORD_TOLERANCE,
): MergeResult {
  const merged: RedactionMap = { ...base };
  let added = 0;
  let skipped = 0;
  for (const [key, boxes] of Object.entries(incoming)) {
    const page = Number(key);
    const list = [...(merged[page] ?? [])];
    for (const box of boxes) {
      if (list.some((b) => rectsEqualWithin(b, box, tolerance))) {
        skipped += 1;
        continue;
      }
      list.push(box);
      added += 1;
    }
    if (list.length > 0) merged[page] = list;
  }
  return { merged, added, skipped };
}
