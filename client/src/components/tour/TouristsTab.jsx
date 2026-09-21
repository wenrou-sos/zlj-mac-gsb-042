import { useState } from 'react';
import { api, yuan } from '../../api.js';
import { useToast } from '../Toast.jsx';
import Modal from '../Modal.jsx';
import { Empty } from '../ui.jsx';

const ROOM_TYPES = ['双人房', '三人房', '儿童不占床'];

export default function TouristsTab({ tour, reload }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(blank(tour));

  const priceMap = { 双人房: tour.price_double, 三人房: tour.price_triple, 儿童不占床: tour.price_child };
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function blank(t) {
    return { name: '', id_card: '', phone: '', room_type: '双人房', special_needs: '', price: '' };
  }

  const submit = async (e) => {
    e.preventDefault();
    const body = { ...form, price: form.price === '' ? priceMap[form.room_type] : Number(form.price) };
    try {
      await api.post(`/tours/${tour.id}/tourists`, body);
      toast('报名成功', 'success');
      setForm(blank(tour)); setShow(false); reload();
    } catch (err) { toast(err.message, 'error'); }
  };

  const setStatus = async (tr, status) => {
    if (status === '已退团' && !confirm(`确认将 ${tr.name} 标记为退团？退团后释放名额。`)) return;
    try { await api.patch('/tourists/' + tr.id, { status }); reload(); toast('状态已更新', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const remove = async (tr) => {
    if (!confirm(`确认删除游客 ${tr.name} 的报名记录？`)) return;
    await api.del('/tourists/' + tr.id); reload();
  };

  const active = tour.tourists.filter(t => t.status !== '已退团');
  const revenue = active.reduce((s, t) => s + t.price, 0);
  const roomCount = { 双人房: 0, 三人房: 0, 儿童不占床: 0 };
  active.forEach(t => roomCount[t.room_type]++);

  return (
    <div>
      <div className="subhead">
        <div className="quick-stats">
          <span>已收 <strong className={tour.full ? 'text-red' : 'text-green'}>{active.length}</strong>/{tour.capacity} 人</span>
          <span>余位 <strong>{Math.max(0, tour.capacity - active.length)}</strong></span>
          <span>双人房 {roomCount['双人房']} 人 · 三人房 {roomCount['三人房']} 人 · 儿童 {roomCount['儿童不占床']} 人</span>
          <span>报名费收入 <strong className="text-green">{yuan(revenue)}</strong></span>
        </div>
        <button className="btn btn-primary" disabled={tour.status !== '收客中' || tour.full}
          onClick={() => setShow(true)}>
          {tour.status !== '收客中' ? `已${tour.status}·停收` : tour.full ? '满团·已自动停收' : '＋ 录入游客'}
        </button>
      </div>

      {tour.full && tour.status === '收客中' && (
        <div className="alert alert-red">🚫 本团已达容量上限，系统已自动停止收客。如需扩容请在「概览」中修改容量。</div>
      )}
      {tour.status !== '收客中' && (
        <div className="alert alert-orange">⏸ 团队状态为「{tour.status}」，当前不可录入新游客。</div>
      )}

      {tour.tourists.length === 0 ? <Empty text="还没有游客报名，点击「录入游客」开始收客" /> : (
        <table className="table">
          <thead><tr><th>#</th><th>姓名</th><th>身份证号</th><th>联系方式</th><th>房型</th><th>报价</th><th>特殊需求</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {tour.tourists.map((t, i) => (
              <tr key={t.id} className={t.status === '已退团' ? 'row-cancel' : ''}>
                <td>{i + 1}</td>
                <td><strong>{t.name}</strong></td>
                <td className="mono small">{t.id_card}</td>
                <td className="small">{t.phone || '—'}</td>
                <td><span className="tag">{t.room_type}</span></td>
                <td>{yuan(t.price)}</td>
                <td>{t.special_needs ? <span className="need">{t.special_needs}</span> : '—'}</td>
                <td><span className={`badge badge-${t.status === '已退团' ? 'red' : 'green'}`}>{t.status}</span></td>
                <td className="nowrap">
                  {t.status !== '已退团'
                    ? <button className="btn btn-xs btn-danger-ghost" onClick={() => setStatus(t, '已退团')}>退团</button>
                    : <span className="muted">已释放名额</span>}
                  <button className="btn btn-xs" onClick={() => remove(t)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {show && (
        <Modal title="录入游客报名" onClose={() => setShow(false)}
          footer={<><button className="btn" onClick={() => setShow(false)}>取消</button>
            <button className="btn btn-primary" form="tourist-form" type="submit">确认报名</button></>}>
          <form id="tourist-form" onSubmit={submit}>
            <div className="form-grid">
              <label>姓名 *<input className="input" required value={form.name} onChange={e => set('name', e.target.value)} /></label>
              <label>身份证号 *<input className="input mono" required maxLength="18" placeholder="18位，含校验位" value={form.id_card} onChange={e => set('id_card', e.target.value)} /></label>
              <label>手机号<input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="11位手机号" /></label>
              <label>房型 *
                <select className="input" value={form.room_type} onChange={e => { set('room_type', e.target.value); set('price', ''); }}>
                  {ROOM_TYPES.map(r => <option key={r}>{r}</option>)}
                </select>
              </label>
              <label className="span-2">实收团费（留空取产品标准价 {yuan(priceMap[form.room_type])}）
                <input className="input" type="number" min="0" step="0.01" value={form.price} onChange={e => set('price', e.target.value)} />
              </label>
              <label className="span-3">特殊需求（素食 / 轮椅 / 过敏等）
                <input className="input" value={form.special_needs} onChange={e => set('special_needs', e.target.value)} placeholder="如：全程素食；轮椅需无障碍通道" />
              </label>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
