import type { RedactionScheme } from '../pdf/scheme';
import { countSchemeBoxes } from '../pdf/scheme';

interface Props {
  scheme: RedactionScheme;
  currentBoxCount: number;
  onReplace(): void;
  onMerge(): void;
  onCancel(): void;
}

/**
 * 方案通过结构 + 文档匹配双重校验后弹出：让用户选择“替换”或“合并”。
 * 在用户做出选择前不会改动任何现有遮盖；取消则完全保持现状。
 */
export function ImportDialog({ scheme, currentBoxCount, onReplace, onMerge, onCancel }: Props) {
  const incoming = countSchemeBoxes(scheme);
  return (
    <div className="modal-overlay" onPointerDown={onCancel}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>导入遮盖方案</h2>
        <p className="modal-text">
          方案已通过全部校验（源文件哈希、页数、逐页尺寸、矩形边界）。
          方案来自 <strong>{scheme.sourceName || '未命名 PDF'}</strong>，
          共 {scheme.numPages} 页、{incoming} 处遮盖框；
          当前文档已有 {currentBoxCount} 处遮盖。
        </p>
        <p className="modal-text dim">
          “替换”会用方案覆盖当前全部遮盖；“合并”会保留现有遮盖并追加方案内容
          （按页及 0.01 点坐标容差去重）。整次导入只产生一条撤销记录。
        </p>
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="danger-outline" onClick={onReplace} title="丢弃当前遮盖，改用导入的方案">
            替换
          </button>
          <button className="primary" onClick={onMerge} title="保留现有遮盖，追加方案中不重复的遮盖框">
            合并
          </button>
        </div>
      </div>
    </div>
  );
}
