import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';
import { Empty } from '../ui.jsx';

export default function NoticeTab({ tour }) {
  const toast = useToast();
  const [content, setContent] = useState('');
  const [generating, setGenerating] = useState(false);
  const [notices, setNotices] = useState([]);
  const [view, setView] = useState(null);

  const loadList = () => api.get(`/tours/${tour.id}/notices`).then(setNotices);
  useEffect(loadList, []);

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await api.post(`/tours/${tour.id}/notices/generate`, {});
      setContent(r.content);
      toast('已按行程与计调安排生成，请核对后保存发送', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setGenerating(false); }
  };

  const save = async () => {
    if (!content.trim()) return toast('通知书内容为空', 'error');
    try { await api.post(`/tours/${tour.id}/notices`, { content }); setContent(''); loadList(); toast('通知书已存档', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  };

  const send = async (n) => {
    if (!confirm(`确认向 ${tour.headcount} 位在团游客发送此通知书？（系统将经短信/邮件网关下发）`)) return;
    try { await api.post(`/notices/${n.id}/send`, {}); loadList(); toast(`已发送至 ${tour.headcount} 位游客`, 'success'); }
    catch (e) { toast(e.message, 'error'); }
  };

  const openView = async (n) => {
    const full = await api.get('/notices/' + n.id);
    setView(full);
  };

  return (
    <div className="notice-tab">
      <div className="ops-head">
        <h3>📄 出团通知书 <small>自动汇总行程、航班、酒店、地接与游客特殊需求</small></h3>
        <button className="btn btn-primary" disabled={generating} onClick={generate}>
          {generating ? '生成中…' : '⚙️ 自动生成通知书'}
        </button>
      </div>

      {content && (
        <div className="card notice-editor">
          <textarea className="notice-textarea" rows={20} value={content} onChange={e => setContent(e.target.value)} />
          <div className="form-actions">
            <button className="btn" onClick={() => setContent('')}>放弃</button>
            <button className="btn btn-primary" onClick={save}>存档（稍后发送）</button>
          </div>
        </div>
      )}

      <h3 className="card-title" style={{ marginTop: 16 }}>发送记录</h3>
      {notices.length === 0 ? <Empty text="暂无通知书，点击上方按钮自动生成" /> : (
        <table className="table">
          <thead><tr><th>#</th><th>生成时间</th><th>发送状态</th><th>发送时间</th><th>接收人数</th><th>操作</th></tr></thead>
          <tbody>
            {notices.map(n => (
              <tr key={n.id}>
                <td>{n.id}</td>
                <td className="small">{n.created_at}</td>
                <td><span className={`badge badge-${n.sent ? 'green' : 'gray'}`}>{n.sent ? '已发送' : '未发送'}</span></td>
                <td className="small">{n.sent_at || '—'}</td>
                <td>{n.sent ? `${n.recipient_count} 人` : '—'}</td>
                <td className="nowrap">
                  <button className="btn btn-xs" onClick={() => openView(n)}>查看/打印</button>
                  {!n.sent && <button className="btn btn-xs btn-primary" onClick={() => send(n)}>发送给游客</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view && (
        <div className="modal-mask" onMouseDown={e => e.target === e.currentTarget && setView(null)}>
          <div className="modal modal-wide">
            <div className="modal-head">
              <h3>出团通知书预览</h3>
              <button className="btn-icon" onClick={() => setView(null)}>✕</button>
            </div>
            <div className="modal-body">
              <pre className="notice-print">{view.content}</pre>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setView(null)}>关闭</button>
              <button className="btn btn-primary" onClick={() => window.print()}>🖨 打印 / 另存PDF</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
