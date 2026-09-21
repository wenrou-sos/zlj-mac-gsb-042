import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import { StatusBadge } from '../components/ui.jsx';
import TouristsTab from '../components/tour/TouristsTab.jsx';
import OpsTab from '../components/tour/OpsTab.jsx';
import FinanceTab from '../components/tour/FinanceTab.jsx';
import NoticeTab from '../components/tour/NoticeTab.jsx';

const TABS = [
  { key: 'tourists', label: '收客', icon: '👥' },
  { key: 'ops', label: '计调操作', icon: '🛠' },
  { key: 'finance', label: '收入/成本', icon: '💰' },
  { key: 'notice', label: '出团通知书', icon: '📄' }
];
const NEXT_STATUS = { '收客中': '已截止', '已截止': '已成团', '已成团': '已出团', '已出团': '已结束', '已结束': '收客中' };

export default function TourDetail({ id }) {
  const toast = useToast();
  const [tour, setTour] = useState(null);
  const [tab, setTab] = useState('tourists');

  const reload = useCallback(() => api.get('/tours/' + id).then(setTour).catch(e => toast(e.message, 'error')), [id]);
  useEffect(() => { reload(); }, [reload]);

  const patch = async (body, msg) => {
    try { await api.patch('/tours/' + id, body); reload(); if (msg) toast(msg, 'success'); }
    catch (e) { toast(e.message, 'error'); }
  };

  const toggleStatus = () => {
    const next = NEXT_STATUS[tour.status];
    if (!confirm(`确认将团队状态由「${tour.status}」变更为「${next}」？${next === '收客中' ? '恢复后可继续收客。' : next === '已截止' ? '截止后不能再录入游客。' : ''}`)) return;
    patch({ status: next }, '状态已更新');
  };

  const editCapacity = () => {
    const v = prompt('修改团容量（人数）：', tour.capacity);
    if (v === null) return;
    const n = Number(v);
    if (n < tour.headcount) return toast(`容量不能小于当前在团人数 ${tour.headcount}`, 'error');
    patch({ capacity: n }, '容量已更新');
  };

  if (!tour) return <div className="loading">加载中…</div>;
  const pct = Math.min(100, Math.round(tour.headcount / tour.capacity * 100));

  return (
    <div>
      <div className="detail-hero">
        <div className="detail-back"><a href="#/tours">← 团队列表</a></div>
        <div className="detail-head">
          <div>
            <div className="detail-title-row">
              <h1>{tour.product_name}</h1>
              <StatusBadge status={tour.status} full={tour.full} />
            </div>
            <div className="detail-meta">
              <span className="mono">团号 {tour.code}</span>
              <span>{tour.departure_city} → {tour.destination}</span>
              <span>{tour.days} 天 · {tour.departure_date}{tour.return_date ? ' ~ ' + tour.return_date : ''}</span>
              <span>领队：{tour.tour_leader || '未指派'}</span>
            </div>
          </div>
          <div className="detail-actions">
            <button className="btn" onClick={editCapacity}>⚙ 容量 {tour.capacity}</button>
            <button className="btn" onClick={() => {
              const v = prompt('领队姓名：', tour.tour_leader || '');
              if (v !== null) patch({ tour_leader: v }, '领队已更新');
            }}>👤 指派领队</button>
            <button className="btn btn-primary" onClick={toggleStatus}>
              {tour.status === '收客中' ? '⏸ 截止收客' : tour.status === '已结束' ? '↻ 重新收客' : `推进为「${NEXT_STATUS[tour.status]}」`}
            </button>
          </div>
        </div>
        <div className="capacity-strip">
          <div className="progress progress-lg"><div className={`progress-bar ${tour.full ? 'full' : ''}`} style={{ width: pct + '%' }} /></div>
          <span className={tour.full ? 'text-red' : ''}>
            <strong>{tour.headcount}</strong>/{tour.capacity} 人
            {tour.full ? ' · 已满团自动停收' : ` · 余 ${tour.capacity - tour.headcount} 席`}
          </span>
        </div>
      </div>

      <div className="tabs tabs-sticky">
        {TABS.map(t => <button key={t.key} className={`tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
          {t.icon} {t.label}
        </button>)}
      </div>

      {tab === 'tourists' && <TouristsTab tour={tour} reload={reload} />}
      {tab === 'ops' && <OpsTab tour={tour} reload={reload} />}
      {tab === 'finance' && <FinanceTab tour={tour} />}
      {tab === 'notice' && <NoticeTab tour={tour} />}

      {tab === 'tourists' && (
        <div className="card itinerary-card">
          <h3 className="card-title">📖 行程速览（{tour.itinerary.length} 天）</h3>
          <div className="itinerary-strip">
            {tour.itinerary.map(d => (
              <div className="iti-chip" key={d.id}>
                <strong>D{d.day_no}</strong>
                <span>{d.title || '—'}</span>
                {d.attractions && <small>🏞 {d.attractions}</small>}
                {d.meals && <small>🍽 {d.meals}</small>}
                {d.hotel && <small>🏨 {d.hotel}</small>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
