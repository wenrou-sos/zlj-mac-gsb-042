import { useState } from 'react';
import { api, yuan } from '../../api.js';
import { useToast } from '../Toast.jsx';
import Modal from '../Modal.jsx';
import { ConfirmBadge, Empty } from '../ui.jsx';
import { nightsBetween } from './opsUtils.js';

/* ---------------- 航空切位 ---------------- */
function Flights({ tour, reload }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ direction: '去程', flight_no: '', flight_date: tour.departure_date, route: '', seats: '', unit_price: '', confirmed: false, remarks: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    try { await api.post(`/tours/${tour.id}/flights`, form); setShow(false); reload(); toast('切位记录已添加', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  };
  const toggle = async (f) => { await api.put('/flights/' + f.id, { confirmed: f.confirmed ? 0 : 1 }); reload(); };
  const del = async (f) => { if (confirm('删除该切位记录？')) { await api.del('/flights/' + f.id); reload(); } };
  const totalSeats = tour.flights.reduce((s, f) => s + f.seats, 0);
  const totalCost = tour.flights.reduce((s, f) => s + f.seats * f.unit_price, 0);

  return (
    <section className="ops-section">
      <div className="ops-head">
        <h3>✈️ 航空切位 <small>共 {totalSeats} 座 · {yuan(totalCost)}</small></h3>
        <button className="btn btn-sm btn-primary" onClick={() => setShow(true)}>＋ 切位</button>
      </div>
      {tour.flights.length === 0 ? <Empty text="尚未预订航空切位" /> : (
        <table className="table">
          <thead><tr><th>方向</th><th>航班号</th><th>日期</th><th>航线</th><th>座位</th><th>切位价</th><th>小计</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {tour.flights.map(f => (
              <tr key={f.id}>
                <td><span className="tag">{f.direction}</span></td>
                <td className="mono"><strong>{f.flight_no}</strong></td>
                <td className="small">{f.flight_date || '—'}</td>
                <td className="small">{f.route || '—'}</td>
                <td>{f.seats}</td><td>{yuan(f.unit_price)}</td>
                <td><strong>{yuan(f.seats * f.unit_price)}</strong></td>
                <td><ConfirmBadge confirmed={!!f.confirmed} /></td>
                <td className="nowrap"><button className="btn btn-xs" onClick={() => toggle(f)}>{f.confirmed ? '撤销确认' : '确认'}</button>
                  <button className="btn btn-xs btn-danger-ghost" onClick={() => del(f)}>删</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {show && (
        <Modal title="航空切位预订" onClose={() => setShow(false)}
          footer={<><button className="btn" onClick={() => setShow(false)}>取消</button>
            <button className="btn btn-primary" form="flight-form" type="submit">保存</button></>}>
          <form id="flight-form" onSubmit={save}>
            <div className="form-grid">
              <label>方向
                <select className="input" value={form.direction} onChange={e => set('direction', e.target.value)}>
                  <option>去程</option><option>回程</option><option>联程</option>
                </select>
              </label>
              <label>航班号 *<input className="input mono" required value={form.flight_no} onChange={e => set('flight_no', e.target.value)} placeholder="如 MU5802" /></label>
              <label>航班日期<input type="date" className="input" value={form.flight_date || ''} onChange={e => set('flight_date', e.target.value)} /></label>
              <label>航线<input className="input" value={form.route} onChange={e => set('route', e.target.value)} placeholder="上海虹桥 → 昆明长水" /></label>
              <label>切位座位数 *<input type="number" min="1" className="input" required value={form.seats} onChange={e => set('seats', e.target.value)} /></label>
              <label>切位单价（元/座）<input type="number" min="0" step="0.01" className="input" value={form.unit_price} onChange={e => set('unit_price', e.target.value)} /></label>
              <label className="check-line span-3"><input type="checkbox" checked={form.confirmed} onChange={e => set('confirmed', e.target.checked)} /> 已向航司/包机商确认切位</label>
              <label className="span-3">备注<input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)} /></label>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

/* ---------------- 酒店控房 ---------------- */
function Hotels({ tour, reload }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ hotel_name: '', room_type: '标间', rooms: '', check_in: tour.departure_date, check_out: tour.return_date || tour.departure_date, night_price: '', confirmed: false, remarks: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    try { await api.post(`/tours/${tour.id}/hotels`, form); setShow(false); reload(); toast('控房记录已添加', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  };
  const toggle = async (h) => { await api.put('/hotels/' + h.id, { confirmed: h.confirmed ? 0 : 1 }); reload(); };
  const del = async (h) => { if (confirm('删除该控房记录？')) { await api.del('/hotels/' + h.id); reload(); } };
  const total = tour.hotels.reduce((s, h) => s + h.rooms * h.night_price * nightsBetween(h.check_in, h.check_out), 0);

  return (
    <section className="ops-section">
      <div className="ops-head">
        <h3>🏨 酒店控房 <small>合计 {yuan(total)}</small></h3>
        <button className="btn btn-sm btn-primary" onClick={() => setShow(true)}>＋ 控房</button>
      </div>
      {tour.hotels.length === 0 ? <Empty text="尚未控制酒店房间" /> : (
        <table className="table">
          <thead><tr><th>酒店</th><th>房型</th><th>间数</th><th>入住</th><th>离店</th><th>晚数</th><th>晚均价</th><th>小计</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {tour.hotels.map(h => {
              const n = nightsBetween(h.check_in, h.check_out);
              return (
                <tr key={h.id}>
                  <td><strong>{h.hotel_name}</strong></td><td><span className="tag">{h.room_type}</span></td>
                  <td>{h.rooms}</td><td className="small">{h.check_in}</td><td className="small">{h.check_out}</td>
                  <td>{n} 晚</td><td>{yuan(h.night_price)}</td>
                  <td><strong>{yuan(h.rooms * h.night_price * n)}</strong></td>
                  <td><ConfirmBadge confirmed={!!h.confirmed} /></td>
                  <td className="nowrap"><button className="btn btn-xs" onClick={() => toggle(h)}>{h.confirmed ? '撤销确认' : '确认'}</button>
                    <button className="btn btn-xs btn-danger-ghost" onClick={() => del(h)}>删</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {show && (
        <Modal title="酒店控房" onClose={() => setShow(false)}
          footer={<><button className="btn" onClick={() => setShow(false)}>取消</button>
            <button className="btn btn-primary" form="hotel-form" type="submit">保存</button></>}>
          <form id="hotel-form" onSubmit={save}>
            <div className="form-grid">
              <label className="span-2">酒店名称 *<input className="input" required value={form.hotel_name} onChange={e => set('hotel_name', e.target.value)} /></label>
              <label>房型<input className="input" value={form.room_type} onChange={e => set('room_type', e.target.value)} placeholder="标间/大床/三人间" /></label>
              <label>间数 *<input type="number" min="1" className="input" required value={form.rooms} onChange={e => set('rooms', e.target.value)} /></label>
              <label>入住日期 *<input type="date" className="input" required value={form.check_in} onChange={e => set('check_in', e.target.value)} /></label>
              <label>离店日期 *<input type="date" className="input" required value={form.check_out} onChange={e => set('check_out', e.target.value)} /></label>
              <label>每间每晚价格<input type="number" min="0" step="0.01" className="input" value={form.night_price} onChange={e => set('night_price', e.target.value)} /></label>
              <label className="check-line span-3"><input type="checkbox" checked={form.confirmed} onChange={e => set('confirmed', e.target.checked)} /> 酒店已回传确认单</label>
              <label className="span-3">备注<input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)} /></label>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

/* ---------------- 地接社 ---------------- */
function LocalServices({ tour, reload }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ agency_name: '', guide_name: '', guide_phone: '', vehicle: '', meals_plan: '', total_price: '', confirmed: false, remarks: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    try { await api.post(`/tours/${tour.id}/local-services`, form); setShow(false); reload(); toast('地接安排已添加', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  };
  const toggle = async (s) => { await api.put('/local-services/' + s.id, { confirmed: s.confirmed ? 0 : 1 }); reload(); };
  const del = async (s) => { if (confirm('删除该地接安排？')) { await api.del('/local-services/' + s.id); reload(); } };

  return (
    <section className="ops-section">
      <div className="ops-head">
        <h3>🚌 地接社确认 <small>导游 / 用车 / 用餐一揽子</small></h3>
        <button className="btn btn-sm btn-primary" onClick={() => setShow(true)}>＋ 地接安排</button>
      </div>
      {tour.local_services.length === 0 ? <Empty text="尚未确认地接社" /> : (
        <div className="local-grid">
          {tour.local_services.map(s => (
            <div className={`local-card ${s.confirmed ? 'confirmed' : ''}`} key={s.id}>
              <div className="local-card-head">
                <strong>{s.agency_name}</strong><ConfirmBadge confirmed={!!s.confirmed} />
              </div>
              <div className="local-rows">
                <div><span>地接导游</span>{s.guide_name || '—'}{s.guide_phone && <em className="mono"> {s.guide_phone}</em>}</div>
                <div><span>用车</span>{s.vehicle || '—'}</div>
                <div><span>用餐</span>{s.meals_plan || '—'}</div>
                <div><span>地接费用</span><strong>{yuan(s.total_price)}</strong></div>
                {s.remarks && <div><span>备注</span>{s.remarks}</div>}
              </div>
              <div className="local-actions">
                <button className="btn btn-xs" onClick={() => toggle(s)}>{s.confirmed ? '撤销确认' : '确认地接'}</button>
                <button className="btn btn-xs btn-danger-ghost" onClick={() => del(s)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {show && (
        <Modal title="地接社确认" wide onClose={() => setShow(false)}
          footer={<><button className="btn" onClick={() => setShow(false)}>取消</button>
            <button className="btn btn-primary" form="local-form" type="submit">保存</button></>}>
          <form id="local-form" onSubmit={save}>
            <div className="form-grid">
              <label>地接社名称 *<input className="input" required value={form.agency_name} onChange={e => set('agency_name', e.target.value)} /></label>
              <label>地接导游<input className="input" value={form.guide_name} onChange={e => set('guide_name', e.target.value)} /></label>
              <label>导游电话<input className="input" value={form.guide_phone} onChange={e => set('guide_phone', e.target.value)} /></label>
              <label className="span-2">用车安排<input className="input" value={form.vehicle} onChange={e => set('vehicle', e.target.value)} placeholder="如：33座空调旅游大巴，司机张师傅 138..." /></label>
              <label className="span-2">用餐安排<input className="input" value={form.meals_plan} onChange={e => set('meals_plan', e.target.value)} placeholder="如：5早8正，十人一桌，25元/正" /></label>
              <label>地接总费用（元）<input type="number" min="0" step="0.01" className="input" value={form.total_price} onChange={e => set('total_price', e.target.value)} /></label>
              <label className="check-line span-3"><input type="checkbox" checked={form.confirmed} onChange={e => set('confirmed', e.target.checked)} /> 地接社已确认回传</label>
              <label className="span-3">备注<input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)} /></label>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

/* ---------------- 其他成本 ---------------- */
function OtherCosts({ tour, reload }) {
  const toast = useToast();
  const [form, setForm] = useState({ item: '', amount: '', remarks: '' });
  const add = async (e) => {
    e.preventDefault();
    if (!form.item.trim()) return;
    try { await api.post(`/tours/${tour.id}/other-costs`, form); setForm({ item: '', amount: '', remarks: '' }); reload(); toast('已添加', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  };
  const del = async (o) => { await api.del('/other-costs/' + o.id); reload(); };

  return (
    <section className="ops-section">
      <div className="ops-head"><h3>🧾 其他成本 <small>门票 / 保险 / 领队费用等</small></h3></div>
      <form className="inline-form" onSubmit={add}>
        <input className="input" placeholder="费用项目（如 景区门票、旅游意外险）" value={form.item} onChange={e => setForm(f => ({ ...f, item: e.target.value }))} />
        <input className="input" style={{ maxWidth: 140 }} type="number" min="0" step="0.01" placeholder="金额" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
        <input className="input" placeholder="备注" value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
        <button className="btn btn-primary">＋ 添加</button>
      </form>
      {tour.other_costs.length > 0 && (
        <table className="table">
          <thead><tr><th>项目</th><th>金额</th><th>备注</th><th></th></tr></thead>
          <tbody>
            {tour.other_costs.map(o => (
              <tr key={o.id}><td>{o.item}</td><td>{yuan(o.amount)}</td><td className="small">{o.remarks || '—'}</td>
                <td><button className="btn btn-xs btn-danger-ghost" onClick={() => del(o)}>删</button></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function OpsTab({ tour, reload }) {
  return (
    <div className="ops-tab">
      <Flights tour={tour} reload={reload} />
      <Hotels tour={tour} reload={reload} />
      <LocalServices tour={tour} reload={reload} />
      <OtherCosts tour={tour} reload={reload} />
    </div>
  );
}
