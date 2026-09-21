export function StatusBadge({ status, full }) {
  const map = {
    '收客中': 'green', '已截止': 'orange', '已成团': 'blue', '已出团': 'purple', '已结束': 'gray', '已退团': 'red'
  };
  return (
    <span className="badges">
      <span className={`badge badge-${map[status] || 'gray'}`}>{status}</span>
      {full && status === '收客中' && <span className="badge badge-red">已满团·停收</span>}
    </span>
  );
}

export function ConfirmBadge({ confirmed }) {
  return <span className={`badge badge-${confirmed ? 'green' : 'orange'}`}>{confirmed ? '✓ 已确认' : '待确认'}</span>;
}

export function PageHead({ title, subtitle, children }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      <div className="page-head-actions">{children}</div>
    </div>
  );
}

export function Empty({ text = '暂无数据' }) {
  return <div className="empty">📭 {text}</div>;
}
