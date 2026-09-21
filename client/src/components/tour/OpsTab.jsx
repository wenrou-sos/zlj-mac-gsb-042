import { useEffect, useMemo, useState } from 'react';
import { api, yuan } from '../../api.js';
import { useToast } from '../Toast.jsx';
import Modal from '../Modal.jsx';
import SourcesModal from '../pool/SourcesModal.jsx';
import { ConfirmBadge, Empty } from '../ui.jsx';
import { nightsBetween } from './opsUtils.js';
import { bookingAvail, availSummary } from './poolUtils.js';

// 加载全部资源池记录（计调录入时从池里选）
function useResources() {
  const [resources, setResources] = useState([]);
  useEffect(() => { api.get('/resources?status=开放').then(setResources).catch(() => {}); }, []);
  return resources;
}

// 资源池冲突浮层：服务端 409 响应中的 conflicts（日期 + 剩余量）
function ConflictNote({ err }) {
  const c = err?.data?.conflicts;
  if (!c?.length) return null;
  return (
    <div className="alert alert-red" style={{ marginTop: 12 }}>
      <strong>库存冲突（{c.length} 项）：</strong>
      <ul style={{ margin: '6px 0 0 18px' }}>
        {c.map((x, i) => (
          <li key={i} className="mono">{x.date}：需要 {x.need}，{x.reason ? x.reason : `现余 ${x.remaining}（${x.remaining - x.need >= 0 ? '' : '差 ' + (x.need - x.remaining)}）`}</li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- 实时余量徽标 ---------------- */
function AvailCell({ tour, type, booking }) {
  const avail = bookingAvail(tour, type, booking.id);
  const sum = availSummary(avail);
  if (!sum) return <span className="muted">手工</span>;
  if (sum.stopped) return <span className="badge badge-gray">资源已停售</span>;
  const cls = sum.min <= 0 ? 'text-red' : sum.min <= 3 ? 'text-red' : 'text-green';
  const label = sum.nights > 1 ? `每晚余量 ${sum.min}~${avail.reduce((m, a) => Math.max(m, a.available), -Infinity)}` : `余量 ${sum.min}`;
  return (
    <span className={cls} title={sum.nights > 1 ? avail.map(a => `${a.date}: ${a.available}`).join('\n') : ''}>
      {sum.nights > 1 ? `余 ${sum.min}${sum.min !== avail.reduce((m, a) => Math.max(m, a.available), -Infinity) ? ' 起' : ''}/晚` : `余 ${sum.min}`}
      {sum.conflictDates.length > 0 && ' ⚠️'}
    </span>
  );
}

/* ---------------- 占用状态 + 释放操作 ---------------- */
function OccStatus({ tour, type, booking, onAction }) {
  const avail = bookingAvail(tour, type, booking.id);
  const sum = availSummary(avail);
  if (booking.released) return <span className="badge badge-gray">已释放库存</span>;
  if (!avail) return <ConfirmBadge confirmed={!!booking.confirmed} />;
  return (
    <span className="badges">
      <ConfirmBadge confirmed={!!booking.confirmed} />
      {sum?.conflictDates.length > 0 && <span className="badge badge-red">库存冲突</span>}
    </span>
  );
}

/* ---------------- 航空切位 ---------------- */
function Flights({ tour, reload, resources }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [err, setErr] = useState(null);
  const [sourcesId, setSourcesId] = useState(null);
  const flightsRes = resources.filter(r => r.type === 'flight');
  const [form, setForm] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const open = () => {
    setErr(null);
    setForm({ resource_id: '', direction: '去程', flight_no: '', flight_date: tour.departure_date, route: '', seats: '', unit_price: '', confirmed: false, remarks: '' });
    setShow(true);
  };
  const pickResource = (rid) => {
    const r = flightsRes.find(x => x.id === Number(rid));
    if (!r) { set('resource_id', ''); return; }
    setForm(f => ({
      ...f, resource_id: r.id, flight_no: r.flight_no, flight_date: r.date,
      route: r.route, unit_price: r.unit_price, seats: f.seats || ''
    }));
  };

  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    try { await api.post(`/tours/${tour.id}/flights`, form); setShow(false); reload(); toast('切位记录已添加（库存已占用）', 'success'); }
    catch (e2) { setErr(e2); }
  };
  const toggle = async (f) => {
    try { await api.put('/flights/' + f.id, { confirmed: f.confirmed ? 0 : 1 }); reload(); toast(f.confirmed ? '已撤销确认（成本改按现价）' : '已确认并锁定成本快照', 'success'); }
    catch (e2) { toast(e2.message, 'error'); }
  };
  const release = async (f) => {
    if (!confirm('释放该切位占用？座位回到资源池供其他团队使用，记录保留。')) return;
    try { await api.post(`/flights/${f.id}/release`); reload(); toast('库存已释放', 'success'); } catch (e2) { toast(e2.message, 'error'); }
  };
  const reoccupy = async (f) => {
    try { await api.post(`/flights/${f.id}/reoccupy`); reload(); toast('已重新占用库存', 'success'); }
    catch (e2) { toast(e2.message + (e2.data?.conflicts?.length ? '（详见库存冲突）' : ''), 'error'); }
  };
  const del = async (f) => { if (confirm('删除该切位记录？关联占用将一并释放。')) { try { await api.del('/flights/' + f.id); reload(); } catch (e2) { toast(e2.message, 'error'); } } };

  const active = tour.flights.filter(f => !f.released);
  const totalSeats = active.reduce((s, f) => s + f.seats, 0);
  const totalCost = tour.finance.costs.flight;

  return (
    <section className="ops-section">
      <div className="ops-head">
        <h3>✈️ 航空切位 <small>池占成本 {yuan(totalCost)} · {totalSeats} 座</small></h3>
        <button className="btn btn-sm btn-primary" onClick={open}>＋ 切位</button>
      </div>
      {tour.flights.length === 0 ? <Empty text="尚未预订航空切位" /> : (
        <table className="table">
          <thead><tr><th>方向</th><th>航班号</th><th>日期</th><th>航线</th><th>座位</th><th>单价</th><th>小计</th><th>资源池余量</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {tour.flights.map(f => {
              const avail = bookingAvail(tour, 'flight', f.id);
              const occ = tour.occupancies.find(o => o.booking_type === 'flight' && o.booking_id === f.id && o.status !== '已释放');
              return (
                <tr key={f.id} className={f.released ? 'row-cancel' : ''}>
                  <td><span className="tag">{f.direction}</span></td>
                  <td className="mono"><strong>{f.flight_no}</strong></td>
                  <td className="small">{f.flight_date || '—'}</td>
                  <td className="small">{f.route || '—'}</td>
                  <td>{f.seats}</td><td>{occ ? yuan(occ.unit_price_snapshot) : yuan(f.unit_price)}{occ?.status === '已确认' && ' 🔒'}</td>
                  <td><strong>{occ ? yuan(occ.cost_amount) : yuan(f.seats * f.unit_price)}</strong></td>
                  <td><AvailCell tour={tour} type="flight" booking={f} /></td>
                  <td><OccStatus tour={tour} type="flight" booking={f} /></td>
                  <td className="nowrap">
                    {!f.released
                      ? <><button className="btn btn-xs" onClick={() => toggle(f)}>{f.confirmed ? '撤销确认' : '确认'}</button>
                        {avail && <button className="btn btn-xs" onClick={() => setSourcesId(f.resource_id)}>来源</button>}
                        <button className="btn btn-xs btn-danger-ghost" onClick={() => release(f)}>释放</button></>
                      : <button className="btn btn-xs" onClick={() => reoccupy(f)}>重新占用</button>}
                    <button className="btn btn-xs btn-danger-ghost" onClick={() => del(f)}>删</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {show && (
        <Modal title="航空切位预订" wide onClose={() => setShow(false)}
          footer={<><button className="btn" onClick={() => setShow(false)}>取消</button>
            <button className="btn btn-primary" form="flight-form" type="submit">保存并占用</button></>}>
          <form id="flight-form" onSubmit={save}>
            <div className="form-grid">
              <label className="span-3">从资源池选择航班（可选；不选则为手工切位，不占资源池）
                <select className="input" value={form.resource_id} onChange={e => pickResource(e.target.value)}>
                  <option value="">— 手工填写，不占用资源池 —</option>
                  {flightsRes.map(r => <option key={r.id} value={r.id} disabled={r.available <= 0}>
                    {r.date} {r.flight_no}（{r.route}）采购 {r.quantity} / 现余 {r.available} / {yuan(r.unit_price)}
                  </option>)}
                </select>
              </label>
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
              <label className="check-line span-3"><input type="checkbox" checked={form.confirmed} onChange={e => set('confirmed', e.target.checked)} /> 已向航司/包机商确认（确认即锁定成本快照）</label>
              <label className="span-3">备注<input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)} /></label>
            </div>
            <ConflictNote err={err} />
          </form>
        </Modal>
      )}
      {sourcesId && <SourcesModal resourceId={sourcesId} onClose={() => setSourcesId(null)} />}
    </section>
  );
}

/* ---------------- 酒店控房 ---------------- */
function Hotels({ tour, reload, resources }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [err, setErr] = useState(null);
  const [sourcesId, setSourcesId] = useState(null);
  const [form, setForm] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // 酒店资源按「酒店 + 房型」分组（取首晚做锚点）
  const groups = useMemo(() => {
    const m = new Map();
    for (const r of resources.filter(x => x.type === 'hotel')) {
      const key = r.hotel_name + '||' + r.room_type;
      if (!m.has(key)) m.set(key, {
        key, hotel_name: r.hotel_name, room_type: r.room_type, first: r,
        dates: [], minAvailable: Infinity, price: r.unit_price
      });
      const g = m.get(key);
      g.dates.push(r);
      g.minAvailable = Math.min(g.minAvailable, r.available);
    }
    return [...m.values()].map(g => ({ ...g, dates: g.dates.sort((a, b) => a.date.localeCompare(b.date)) }));
  }, [resources]);

  const open = () => {
    setErr(null);
    setForm({ group: '', hotel_name: '', room_type: '标间', rooms: '', check_in: tour.departure_date, check_out: tour.return_date || tour.departure_date, night_price: '', confirmed: false, remarks: '' });
    setShow(true);
  };
  const pickGroup = (key) => {
    const g = groups.find(x => x.key === key);
    if (!g) { setForm(f => ({ ...f, group: '' })); return; }
    setForm(f => ({
      ...f, group: g.key, hotel_name: g.hotel_name, room_type: g.room_type,
      check_in: g.first.date, night_price: g.price
    }));
  };
  // 选择日期范围内的逐晚余量预览
  const preview = useMemo(() => {
    if (!form?.group || !form.check_in || !form.check_out || form.check_out <= form.check_in) return null;
    const g = groups.find(x => x.key === form.group);
    if (!g) return null;
    const dates = [];
    const d = new Date(form.check_in + 'T00:00:00Z');
    const end = new Date(form.check_out + 'T00:00:00Z');
    while (d < end) {
      const ds = d.toISOString().slice(0, 10);
      const row = g.dates.find(x => x.date === ds);
      dates.push({ date: ds, available: row ? row.available : null, price: row ? row.unit_price : null });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return dates;
  }, [form, groups]);

  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    const g = groups.find(x => x.key === form.group);
    const body = { ...form };
    delete body.group;
    if (g) {
      const first = g.dates.find(x => x.date === form.check_in) || g.dates[0];
      body.resource_id = first.id;
      body.check_in = first.date;
      body.night_price = body.night_price === '' ? g.price : body.night_price;
    }
    try { await api.post(`/tours/${tour.id}/hotels`, body); setShow(false); reload(); toast('控房已添加（逐晚库存已占用）', 'success'); }
    catch (e2) { setErr(e2); }
  };
  const toggle = async (h) => {
    try { await api.put('/hotels/' + h.id, { confirmed: h.confirmed ? 0 : 1 }); reload(); toast(h.confirmed ? '已撤销确认' : '已确认并锁定逐晚成本快照', 'success'); }
    catch (e2) { toast(e2.message, 'error'); }
  };
  const release = async (h) => {
    if (!confirm('释放该控房占用？逐晚房量回到资源池，记录保留。')) return;
    try { await api.post(`/hotels/${h.id}/release`); reload(); toast('库存已释放', 'success'); } catch (e2) { toast(e2.message, 'error'); }
  };
  const reoccupy = async (h) => {
    try { await api.post(`/hotels/${h.id}/reoccupy`); reload(); toast('已重新占用库存', 'success'); }
    catch (e2) { toast(e2.message, 'error'); }
  };
  const del = async (h) => { if (confirm('删除该控房记录？逐晚占用将一并释放。')) { try { await api.del('/hotels/' + h.id); reload(); } catch (e2) { toast(e2.message, 'error'); } } };

  return (
    <section className="ops-section">
      <div className="ops-head">
        <h3>🏨 酒店控房 <small>按入住日期逐晚占池 · 池占成本 {yuan(tour.finance.costs.hotel)}</small></h3>
        <button className="btn btn-sm btn-primary" onClick={open}>＋ 控房</button>
      </div>
      {tour.hotels.length === 0 ? <Empty text="尚未控制酒店房间" /> : (
        <table className="table">
          <thead><tr><th>酒店</th><th>房型</th><th>间数</th><th>入住</th><th>离店</th><th>晚数</th><th>晚均价</th><th>逐晚余量</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {tour.hotels.map(h => {
              const avail = bookingAvail(tour, 'hotel', h.id);
              const sum = availSummary(avail);
              const occs = tour.occupancies.filter(o => o.booking_type === 'hotel' && o.booking_id === h.id && o.status !== '已释放');
              const poolCost = occs.reduce((s, o) => s + o.cost_amount, 0);
              const n = nightsBetween(h.check_in, h.check_out);
              return (
                <tr key={h.id} className={h.released ? 'row-cancel' : ''}>
                  <td><strong>{h.hotel_name}</strong></td><td><span className="tag">{h.room_type}</span></td>
                  <td>{h.rooms}</td><td className="small">{h.check_in}</td><td className="small">{h.check_out}</td><td>{n} 晚</td>
                  <td>{yuan(h.night_price)}</td>
                  <td>
                    {sum ? (
                      <span className={sum.min <= 0 ? 'text-red' : sum.min <= 3 ? 'text-red' : 'text-green'}
                        title={avail.map(a => `${a.date}: 余 ${a.available}`).join('\n')}>
                        {sum.conflictDates.length ? <span className="badge badge-red">{sum.conflictDates.length} 晚冲突</span> :
                          <>余 <strong>{sum.min}</strong>{avail.some(a => a.available !== sum.min) ? `~${avail.reduce((m, a) => Math.max(m, a.available), -Infinity)}` : ''} /晚</>}
                      </span>
                    ) : <span className="muted">手工</span>}
                  </td>
                  <td><OccStatus tour={tour} type="hotel" booking={h} /></td>
                  <td className="nowrap">
                    {!h.released
                      ? <><button className="btn btn-xs" onClick={() => toggle(h)}>{h.confirmed ? '撤销确认' : '确认'}</button>
                        {avail && <button className="btn btn-xs" onClick={() => setSourcesId(h.resource_id)}>来源</button>}
                        <button className="btn btn-xs btn-danger-ghost" onClick={() => release(h)}>释放</button></>
                      : <button className="btn btn-xs" onClick={() => reoccupy(h)}>重新占用</button>}
                    <button className="btn btn-xs btn-danger-ghost" onClick={() => del(h)}>删</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {show && (
        <Modal title="酒店控房" wide onClose={() => setShow(false)}
          footer={<><button className="btn" onClick={() => setShow(false)}>取消</button>
            <button className="btn btn-primary" form="hotel-form" type="submit">保存并逐晚占用</button></>}>
          <form id="hotel-form" onSubmit={save}>
            <div className="form-grid">
              <label className="span-3">从资源池选择酒店/房型（可选；不选则为手工控房）
                <select className="input" value={form.group} onChange={e => pickGroup(e.target.value)}>
                  <option value="">— 手工填写，不占用资源池 —</option>
                  {groups.map(g => <option key={g.key} value={g.key} disabled={g.minAvailable <= 0}>
                    {g.hotel_name} · {g.room_type}（{g.dates[0].date} 起 {g.dates.length} 晚，最紧余 {g.minAvailable}，{yuan(g.price)}/晚）
                  </option>)}
                </select>
              </label>
              <label className="span-2">酒店名称 *<input className="input" required value={form.hotel_name} onChange={e => set('hotel_name', e.target.value)} /></label>
              <label>房型<input className="input" value={form.room_type} onChange={e => set('room_type', e.target.value)} /></label>
              <label>间数 *<input type="number" min="1" className="input" required value={form.rooms} onChange={e => set('rooms', e.target.value)} /></label>
              <label>入住日期 *<input type="date" className="input" required value={form.check_in} onChange={e => set('check_in', e.target.value)} /></label>
              <label>离店日期 *<input type="date" className="input" required value={form.check_out} onChange={e => set('check_out', e.target.value)} /></label>
              <label>每间每晚价格<input type="number" min="0" step="0.01" className="input" value={form.night_price} onChange={e => set('night_price', e.target.value)} /></label>
              <label className="check-line span-3"><input type="checkbox" checked={form.confirmed} onChange={e => set('confirmed', e.target.checked)} /> 酒店已回传确认单（确认即逐晚锁定成本快照）</label>
              <label className="span-3">备注<input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)} /></label>
            </div>
            {preview && preview.length > 0 && (
              <div className="card" style={{ marginTop: 12, marginBottom: 0, padding: '10px 14px' }}>
                <div className="small" style={{ marginBottom: 6 }}>📅 资源池逐晚余量{form.rooms ? `（本次需 ${form.rooms} 间/晚）` : ''}：</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {preview.map(p => (
                    <span key={p.date} className={`badge ${p.available === null ? 'badge-red' : Number(form.rooms) > p.available ? 'badge-red' : p.available <= 3 ? 'badge-orange' : 'badge-green'}`}>
                      {p.date}: {p.available === null ? '无房量' : `余 ${p.available}`}{p.price ? ` · ${yuan(p.price)}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <ConflictNote err={err} />
          </form>
        </Modal>
      )}
      {sourcesId && <SourcesModal resourceId={sourcesId} onClose={() => setSourcesId(null)} />}
    </section>
  );
}

/* ---------------- 地接社 ---------------- */
function LocalServices({ tour, reload, resources }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [err, setErr] = useState(null);
  const [sourcesId, setSourcesId] = useState(null);
  const [form, setForm] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const localRes = resources.filter(r => r.type === 'local');

  const open = () => {
    setErr(null);
    setForm({ resource_id: '', agency_name: '', guide_name: '', guide_phone: '', vehicle: '', meals_plan: '', service_date: tour.departure_date, quantity: '', total_price: '', confirmed: false, remarks: '' });
    setShow(true);
  };
  const pick = (rid) => {
    const r = localRes.find(x => x.id === Number(rid));
    if (!r) { set('resource_id', ''); return; }
    const suName = r.supplier_name || '';
    setForm(f => ({
      ...f, resource_id: r.id, agency_name: suName || f.agency_name,
      service_date: r.date, total_price: r.unit_price, quantity: 1,
      vehicle: f.vehicle, remarks: f.remarks
    }));
  };
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    try { await api.post(`/tours/${tour.id}/local-services`, form); setShow(false); reload(); toast('地接安排已添加（容量已占用）', 'success'); }
    catch (e2) { setErr(e2); }
  };
  const toggle = async (s) => {
    try { await api.put('/local-services/' + s.id, { confirmed: s.confirmed ? 0 : 1 }); reload(); toast(s.confirmed ? '已撤销确认' : '已确认并锁定成本快照', 'success'); }
    catch (e2) { toast(e2.message, 'error'); }
  };
  const release = async (s) => {
    if (!confirm('释放该地接容量占用？记录保留。')) return;
    try { await api.post(`/local-services/${s.id}/release`); reload(); toast('容量已释放', 'success'); } catch (e2) { toast(e2.message, 'error'); }
  };
  const reoccupy = async (s) => {
    try { await api.post(`/local-services/${s.id}/reoccupy`); reload(); toast('已重新占用容量', 'success'); }
    catch (e2) { toast(e2.message, 'error'); }
  };
  const del = async (s) => { if (confirm('删除该地接安排？关联占用将一并释放。')) { try { await api.del('/local-services/' + s.id); reload(); } catch (e2) { toast(e2.message, 'error'); } } };

  return (
    <section className="ops-section">
      <div className="ops-head">
        <h3>🚌 地接社确认 <small>导游 / 用车 / 用餐一揽子 · 池占成本 {yuan(tour.finance.costs.local)}</small></h3>
        <button className="btn btn-sm btn-primary" onClick={open}>＋ 地接安排</button>
      </div>
      {tour.local_services.length === 0 ? <Empty text="尚未确认地接社" /> : (
        <div className="local-grid">
          {tour.local_services.map(s => {
            const avail = bookingAvail(tour, 'local', s.id);
            const sum = availSummary(avail);
            const occ = tour.occupancies.find(o => o.booking_type === 'local' && o.booking_id === s.id && o.status !== '已释放');
            return (
              <div className={`local-card ${s.confirmed ? 'confirmed' : ''} ${s.released ? 'row-cancel' : ''}`} key={s.id}>
                <div className="local-card-head">
                  <strong>{s.agency_name}</strong><OccStatus tour={tour} type="local" booking={s} />
                </div>
                <div className="local-rows">
                  <div><span>地接导游</span>{s.guide_name || '—'}{s.guide_phone && <em className="mono"> {s.guide_phone}</em>}</div>
                  <div><span>用车</span>{s.vehicle || '—'}</div>
                  <div><span>用餐</span>{s.meals_plan || '—'}</div>
                  {occ && <div><span>服务日</span><span className="mono small">{s.service_date}</span></div>}
                  <div><span>资源池</span>
                    {sum ? <span className={sum.min <= 0 ? 'text-red' : sum.min <= 3 ? 'text-red' : 'text-green'}>余 {sum.min}{sum.stopped && ' · 已停售'}</span> : <span className="muted">手工</span>}
                  </div>
                  <div><span>成本{occ?.status === '已确认' && ' 🔒'}</span><strong>{occ ? yuan(occ.cost_amount) : yuan(s.total_price)}</strong></div>
                  {s.remarks && <div><span>备注</span>{s.remarks}</div>}
                </div>
                <div className="local-actions">
                  {!s.released
                    ? <><button className="btn btn-xs" onClick={() => toggle(s)}>{s.confirmed ? '撤销确认' : '确认地接'}</button>
                      {avail && <button className="btn btn-xs" onClick={() => setSourcesId(s.resource_id)}>来源</button>}
                      <button className="btn btn-xs btn-danger-ghost" onClick={() => release(s)}>释放</button></>
                    : <button className="btn btn-xs" onClick={() => reoccupy(s)}>重新占用</button>}
                  <button className="btn btn-xs btn-danger-ghost" onClick={() => del(s)}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {show && (
        <Modal title="地接社确认" wide onClose={() => setShow(false)}
          footer={<><button className="btn" onClick={() => setShow(false)}>取消</button>
            <button className="btn btn-primary" form="local-form" type="submit">保存并占用</button></>}>
          <form id="local-form" onSubmit={save}>
            <div className="form-grid">
              <label className="span-3">从资源池选择地接服务（可选；不选则为手工地接）
                <select className="input" value={form.resource_id} onChange={e => pick(e.target.value)}>
                  <option value="">— 手工填写，不占用资源池 —</option>
                  {localRes.map(r => <option key={r.id} value={r.id} disabled={r.available <= 0}>
                    {r.date} {r.service_name}（采购 {r.quantity} / 现余 {r.available}，{yuan(r.unit_price)}/人）
                  </option>)}
                </select>
              </label>
              <label>地接社名称 *<input className="input" required value={form.agency_name} onChange={e => set('agency_name', e.target.value)} /></label>
              <label>地接导游<input className="input" value={form.guide_name} onChange={e => set('guide_name', e.target.value)} /></label>
              <label>导游电话<input className="input" value={form.guide_phone} onChange={e => set('guide_phone', e.target.value)} /></label>
              <label>服务日期 *<input type="date" className="input" required value={form.service_date || ''} onChange={e => set('service_date', e.target.value)} /></label>
              <label>占用数量（人数）*<input type="number" min="1" className="input" required value={form.quantity} onChange={e => set('quantity', e.target.value)} /></label>
              <label>地接总费用（元）<input type="number" min="0" step="0.01" className="input" value={form.total_price} onChange={e => set('total_price', e.target.value)} /></label>
              <label className="span-3">用车安排<input className="input" value={form.vehicle} onChange={e => set('vehicle', e.target.value)} placeholder="如：33座空调旅游大巴" /></label>
              <label className="span-3">用餐安排<input className="input" value={form.meals_plan} onChange={e => set('meals_plan', e.target.value)} placeholder="如：5早8正，十人一桌" /></label>
              <label className="check-line span-3"><input type="checkbox" checked={form.confirmed} onChange={e => set('confirmed', e.target.checked)} /> 地接社已确认回传（确认即锁定成本快照）</label>
              <label className="span-3">备注<input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)} /></label>
            </div>
            <ConflictNote err={err} />
          </form>
        </Modal>
      )}
      {sourcesId && <SourcesModal resourceId={sourcesId} onClose={() => setSourcesId(null)} />}
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
      <div className="ops-head"><h3>🧾 其他成本 <small>门票 / 保险 / 领队费用等（不占资源池）</small></h3></div>
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

/* ---------------- 资源池总提示 ---------------- */
function PoolConflictBanner({ tour }) {
  const conflicts = tour.pool_conflicts || [];
  if (!conflicts.length) return null;
  return (
    <div className="alert alert-red">
      <strong>🚫 资源池库存冲突（{conflicts.length} 项）：</strong>
      <ul style={{ margin: '6px 0 0 18px' }}>
        {conflicts.map((c, i) => (
          <li key={i}><span className="mono">{c.date}</span> {c.label}：{c.resource_status !== '开放' ? '资源已停售' : `现余 ${Math.max(0, c.available)}，本团占用 ${c.quantity}`}</li>
        ))}
      </ul>
      <div style={{ marginTop: 6 }}>请释放部分占用、联系供应商追加采购量，或调整团队计调。</div>
    </div>
  );
}

export default function OpsTab({ tour, reload }) {
  const resources = useResources();
  return (
    <div className="ops-tab">
      <PoolConflictBanner tour={tour} />
      <Flights tour={tour} reload={reload} resources={resources} />
      <Hotels tour={tour} reload={reload} resources={resources} />
      <LocalServices tour={tour} reload={reload} resources={resources} />
      <OtherCosts tour={tour} reload={reload} />
    </div>
  );
}
