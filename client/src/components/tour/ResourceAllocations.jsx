import { useEffect, useMemo, useState } from 'react';
import { api, yuan } from '../../api.js';
import { useToast } from '../Toast.jsx';
import Modal from '../Modal.jsx';
import { Empty } from '../ui.jsx';

const TYPE_ICON = { 航班: '✈️', 酒店: '🏨', 地接: '🚌' };

function AllocStatusBadge({ status }) {
  const map = { 待确认: 'orange', 已确认: 'green', 已释放: 'gray' };
  return <span className={`badge badge-${map[status] || 'gray'}`}>
    {status === '待确认' ? '⏳ 待确认' : status === '已确认' ? '✓ 已确认·快照已锁' : '已释放'}
  </span>;
}

function dayTone(d, qty) {
  if (d.available <= 0) return 'st-zero';
  if (d.available / qty <= 0.2) return 'st-low';
  return 'st-ok';
}

/* ---------------- 占用弹窗 ---------------- */
function AllocateModal({ tour, onClose, saved }) {
  const toast = useToast();
  const [resources, setResources] = useState([]);
  const [type, setType] = useState('航班');
  const [rid, setRid] = useState('');
  const [qty, setQty] = useState('');
  const [dates, setDates] = useState({ start_date: tour.departure_date, end_date: tour.return_date || tour.departure_date });
  const [remarks, setRemarks] = useState('');
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get('/resources?type=' + type + '&status=在售').then(setResources)
    .catch(e => toast(e.message, 'error'));
  useEffect(load, [type]);
  useEffect(() => { if (rid) api.get('/resources/' + rid).then(setDetail).catch(() => {}); else setDetail(null); }, [rid]);

  const chosen = resources.find(r => String(r.id) === String(rid));
  useEffect(() => {
    if (chosen) setDates(d => ({
      start_date: chosen.type === '酒店' ? chosen.service_date : chosen.service_date,
      end_date: chosen.type === '酒店' ? (chosen.end_date || d.end_date) : d.end_date
    }));
  }, [rid]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/allocations', {
        resource_id: Number(rid), tour_id: tour.id, qty: Number(qty),
        start_date: dates.start_date,
        end_date: type === '酒店' ? dates.end_date : undefined,
        remarks, create_booking: 1
      });
      toast('已从资源池占用（待确认），计调记录已生成', 'success');
      saved(); onClose();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Modal wide title="📦 从供应商资源池占用库存" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" form="alloc-form" type="submit" disabled={busy}>{busy ? '提交中…' : '占用（待确认）'}</button></>}>
      <form id="alloc-form" onSubmit={submit}>
        <div className="form-grid">
          <label>资源类型
            <select className="input" value={type} onChange={e => { setType(e.target.value); setRid(''); }}>
              <option>航班</option><option>酒店</option><option>地接</option>
            </select>
          </label>
          <label className="span-2">选择资源 *
            <select className="input" required value={rid} onChange={e => setRid(e.target.value)}>
              <option value="">请选择（仅显示在售）</option>
              {resources.map(r => {
                const u = r.type === '航班' ? '座' : r.type === '酒店' ? '间' : '团';
                return <option key={r.id} value={r.id} disabled={r.availability.available <= 0}>
                  {r.name}{r.sub_name ? '·' + r.sub_name : ''}（{r.supplier_name}，{r.service_date}
                  {r.end_date ? '~' + r.end_date : ''}，余 {r.availability.available}/{r.qty}{u}）
                </option>;
              })}
            </select>
          </label>
          <label>占用数量 *
            <input type="number" min="1" step="1" className="input" required value={qty}
              onChange={e => setQty(e.target.value)}
              placeholder={type === '航班' ? '座位数' : type === '酒店' ? '间数（每日）' : '团数'} />
          </label>
          {type === '酒店' ? (<>
            <label>入住日期 *<input type="date" className="input" required value={dates.start_date}
              min={chosen?.service_date} max={chosen?.end_date}
              onChange={e => setDates(d => ({ ...d, start_date: e.target.value }))} /></label>
            <label>离店日期 *<input type="date" className="input" required value={dates.end_date}
              min={chosen?.service_date} max={chosen?.end_date}
              onChange={e => setDates(d => ({ ...d, end_date: e.target.value }))} /></label>
          </>) : (
            <label className="span-2">服务日期
              <input type="date" className="input" value={dates.start_date} disabled />
            </label>
          )}
          <label className="span-3">备注<input className="input" value={remarks} onChange={e => setRemarks(e.target.value)} /></label>
        </div>
      </form>

      {detail && (
        <div className="pool-preview">
          <div className="pool-preview-head">
            <strong>{TYPE_ICON[detail.type]} {detail.name}{detail.sub_name ? ' · ' + detail.sub_name : ''}</strong>
            <span className="small">供应商 {detail.supplier.name} · 采购价 {yuan(detail.unit_price)}
              {detail.type === '酒店' ? '/间夜' : detail.type === '航班' ? '/座' : '/团'}</span>
          </div>
          <div className="stock-days">
            {detail.availability.daily.map(d => (
              <div key={d.date} className={`stock-day ${dayTone(d, detail.qty)}`}>
                <div className="stock-date">{d.date.slice(5)}</div>
                <div className="stock-num">{d.available}<small>/{d.qty}</small></div>
                <div className="stock-bar"><i style={{ width: Math.min(100, d.held / d.qty * 100) + '%' }} /></div>
                <div className="stock-held">待{d.pending} 确{d.confirmed}</div>
              </div>
            ))}
          </div>
          {qty > 0 && (() => {
            const qn = Number(qty);
            const dates2 = detail.type === '酒店'
              ? detail.availability.daily.filter(d => d.date >= dates.start_date && d.date < dates.end_date)
              : detail.availability.daily;
            const bad = dates2.filter(d => qn > d.available);
            if (bad.length) return (
              <div className="alert alert-red">⚠️ 库存冲突：
                {bad.map(d => `${d.date} 仅余 ${d.available}（需 ${qn}，缺 ${qn - d.available}）`).join('、')}
              </div>
            );
            return <div className="alert alert-orange">✔ 当前选择可占用：{dates2.map(d => d.date).join('、') || '请选择有效日期'}</div>;
          })()}
        </div>
      )}
    </Modal>
  );
}

/* ---------------- 团队占用列表 ---------------- */
export default function ResourceAllocations({ tour, reload }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const allocs = tour.allocations || [];
  const active = allocs.filter(a => a.status !== '已释放');
  const released = allocs.filter(a => a.status === '已释放');

  // 当前团队占用与实时余量的冲突诊断（如资源被调减导致超卖）。
  // d.available 已扣除本占用自身：为负即超卖；+a.qty 还原为不含本团的余量。
  const conflicts = useMemo(() => {
    const out = [];
    for (const a of active) {
      if (!a.availability) continue;
      const bad = a.availability.filter(d => d.available < 0)
        .map(d => ({ ...d, free_except_self: d.available + a.qty }));
      if (bad.length) out.push({ a, bad });
    }
    return out;
  }, [tour]);

  const act = async (a, action, label) => {
    try {
      await api.post('/allocations/' + a.id + '/' + action,
        action === 'release' ? { reason: '计调释放：' + (a.remarks || '') } : undefined);
      toast(label || '操作成功', 'success');
      reload();
    } catch (e) {
      // 确认时的库存冲突：展示剩余量与日期
      if (e.message) toast(e.message, 'error');
    }
  };
  const update = async (a) => {
    const qty = prompt(`修改「${a.resource_name}」占用数量（原 ${a.qty}，仅待确认可改）：`, a.qty);
    if (qty === null) return;
    try {
      const body = { qty: Number(qty) };
      if (a.resource_type === '酒店') {
        const s = prompt('入住日期：', a.start_date); if (s === null) return;
        const e = prompt('离店日期：', a.end_date); if (e === null) return;
        body.start_date = s; body.end_date = e;
      }
      await api.put('/allocations/' + a.id, body);
      toast('占用已修改', 'success'); reload();
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <section className="ops-section pool-section">
      <div className="ops-head">
        <h3>📦 供应商资源池占用 <small>实时余量 · 占用来源 · 冲突控制 · 确认锁定成本</small></h3>
        <button className="btn btn-sm btn-primary" onClick={() => setShow(true)}>＋ 资源池占位</button>
      </div>

      {conflicts.length > 0 && (
        <div className="alert alert-red">
          {conflicts.map(({ a, bad }) => (
            <div key={a.id}>⚠️ <strong>{a.resource_name}</strong>（{a.status}）当前库存超卖：
              {bad.map(d => `${d.date} 除本团外余量 ${d.free_except_self}，本团占用 ${a.qty}`).join('、')}
              ；请释放部分占用或联系供应商增补采购。</div>
          ))}
        </div>
      )}

      {active.length === 0 ? <Empty text="尚未从资源池占位（下方手工计调不受影响，可继续直接录入）" /> : (
        <table className="table">
          <thead><tr>
            <th>类型</th><th>资源 / 供应商</th><th>占用</th><th>日期</th><th>实时余量</th><th>单价</th><th>锁定成本</th><th>状态</th><th></th>
          </tr></thead>
          <tbody>
            {active.map(a => {
              // 还原为「不含本占用」的可占用余量，供计调判断是否超卖
              const freeDays = (a.availability || []).map(d => d.available + a.qty);
              const minAvail = freeDays.length ? Math.min(...freeDays) : null;
              const oversold = minAvail !== null && minAvail < a.qty;
              const unit = a.resource_type === '酒店' ? '间' : a.resource_type === '航班' ? '座' : '团';
              return (
                <tr key={a.id} className={a.status === '已释放' ? 'row-cancel' : ''}>
                  <td><span className="tag">{TYPE_ICON[a.resource_type]} {a.resource_type}</span></td>
                  <td>
                    <strong>{a.resource_name}</strong>{a.resource_sub ? <small> · {a.resource_sub}</small> : ''}
                    <div className="small">{a.supplier_name}</div>
                  </td>
                  <td><strong>{a.qty}</strong> {unit}</td>
                  <td className="small mono">{a.start_date}{a.end_date ? ' ~ ' + a.end_date : ''}</td>
                  <td>
                    {minAvail === null ? '—' : (
                      <span className={oversold ? 'text-red' : 'text-green'}>
                        余 <strong>{minAvail}</strong>
                        {a.availability?.length > 1 && <small>（{a.availability.length} 天最小值·不含本团）</small>}
                      </span>
                    )}
                  </td>
                  <td className="small">
                    {a.status === '已确认'
                      ? <span title="成本快照：供应商后续调价不影响本团">🔒 {yuan(a.price_snapshot)}</span>
                      : <span>{yuan(a.resource_price)}<small>（未锁）</small></span>}
                  </td>
                  <td>{a.cost_snapshot != null ? <strong>{yuan(a.cost_snapshot)}</strong> : <span className="muted">确认后锁定</span>}</td>
                  <td><AllocStatusBadge status={a.status} /></td>
                  <td className="nowrap">
                    {a.status === '待确认' && <>
                      <button className="btn btn-xs btn-primary" onClick={() => act(a, 'confirm', '已确认，成本快照已锁定')}>确认</button>
                      <button className="btn btn-xs" onClick={() => update(a)}>改</button>
                    </>}
                    <button className="btn btn-xs btn-danger-ghost"
                      onClick={() => { if (confirm('释放该占用？联动计调记录将删除，库存恢复。')) act(a, 'release', '占用已释放'); }}>
                      释放
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {released.length > 0 && (
        <details className="released-box">
          <summary>已释放记录（{released.length}，审计留痕）</summary>
          <table className="table">
            <tbody>
              {released.map(a => (
                <tr key={a.id} className="row-cancel">
                  <td>{TYPE_ICON[a.resource_type]} {a.resource_name}</td>
                  <td>{a.qty}</td>
                  <td className="small mono">{a.start_date}{a.end_date ? '~' + a.end_date : ''}</td>
                  <td><AllocStatusBadge status={a.status} /></td>
                  <td className="small">{a.released_at} {a.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="pool-tip">
        💡 占用流程：占位（<b>待确认</b>，已扣减余量并生成计调记录）→ 供应商确认后点「确认」（按当时采购价<b>锁定成本快照</b>）→ 无需使用时「释放」（删除联动计调记录、归还库存）。
        下方原有手工录入的计调记录保持兼容，不受资源池约束。
      </div>

      {show && <AllocateModal tour={tour} onClose={() => setShow(false)} saved={reload} />}
    </section>
  );
}
