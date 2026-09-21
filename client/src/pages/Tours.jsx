import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { StatusBadge } from '../components/ui.jsx';

const TABS = ['全部', '收客中', '已截止', '已成团', '已出团', '已结束'];

export default function Tours() {
  const [list, setList] = useState([]);
  const [tab, setTab] = useState('全部');
  const [q, setQ] = useState('');

  const load = () => {
    const qs = new URLSearchParams();
    if (tab !== '全部') qs.set('status', tab);
    if (q) qs.set('q', q);
    api.get('/tours?' + qs.toString()).then(setList);
  };
  useEffect(load, [tab]);

  const remove = async (t) => {
    if (!confirm(`确认删除团队「${t.code}」？游客与计调资料将一并删除。`)) return;
    try { await api.del('/tours/' + t.id); load(); } catch (e) { alert(e.message); }
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>团队收客</h1><p>按团管理收客进度、计调资源、成本与通知书</p></div>
        <a className="btn btn-primary" href="#/tours/new">＋ 创建团队</a>
      </div>

      <div className="tabs">
        {TABS.map(t => <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div className="toolbar">
        <input className="input" placeholder="搜索团号 / 线路 / 目的地" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
        <button className="btn" onClick={load}>搜索</button>
      </div>

      <div className="card">
        {list.length === 0 ? <div className="empty">📭 暂无团队</div> : (
          <table className="table">
            <thead><tr>
              <th>团号</th><th>线路</th><th>出发日期</th><th>容量/已收</th><th>进度</th><th>领队</th><th>状态</th><th></th>
            </tr></thead>
            <tbody>
              {list.map(t => {
                const pct = Math.min(100, Math.round(t.headcount / t.capacity * 100));
                return (
                  <tr key={t.id}>
                    <td className="mono">{t.code}</td>
                    <td>{t.product_name}<br /><small>{t.departure_city} → {t.destination}</small></td>
                    <td className="nowrap">{t.departure_date}{t.return_date && <> ~ {t.return_date}</>}</td>
                    <td>{t.capacity} / <strong className={t.full ? 'text-red' : 'text-green'}>{t.headcount}</strong></td>
                    <td style={{ minWidth: 150 }}>
                      <div className="progress"><div className={`progress-bar ${t.full ? 'full' : ''}`} style={{ width: pct + '%' }} /></div>
                      <small>{pct}%</small>
                    </td>
                    <td>{t.tour_leader || '—'}</td>
                    <td><StatusBadge status={t.status} full={t.full} /></td>
                    <td className="nowrap">
                      <a className="btn btn-sm btn-primary" href={`#/tours/${t.id}`}>操作</a>
                      <button className="btn btn-sm btn-danger-ghost" onClick={() => remove(t)}>删除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
