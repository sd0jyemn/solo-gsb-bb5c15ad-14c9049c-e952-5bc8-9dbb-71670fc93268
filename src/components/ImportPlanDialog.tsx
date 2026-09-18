import { useEffect } from 'react';

interface Props {
  /** 方案中包含的遮盖框数量 */
  boxCount: number;
  /** 当前文档已有的遮盖框数量 */
  currentCount: number;
  onReplace(): void;
  onMerge(): void;
  onCancel(): void;
}

/** 方案校验通过后的确认对话框：选择「替换」或「合并」，整次导入记为一条撤销记录 */
export function ImportPlanDialog(props: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="modal-backdrop" onClick={props.onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="导入遮盖方案"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>导入遮盖方案</h2>
        <p>
          方案校验通过，与当前文档匹配，包含 <strong>{props.boxCount}</strong> 处遮盖框；
          当前文档已有 {props.currentCount} 处遮盖。
        </p>
        <p className="modal-dim">
          「替换」将清除现有全部遮盖；「合并」在现有基础上追加，同页坐标相同（容差 0.01
          点）的框自动去重。两种方式都只会产生一条撤销记录。
        </p>
        <div className="modal-actions">
          <button onClick={props.onCancel}>取消</button>
          <button className="danger" onClick={props.onReplace}>
            替换当前遮盖
          </button>
          <button className="primary" onClick={props.onMerge}>
            合并到当前遮盖
          </button>
        </div>
      </div>
    </div>
  );
}
