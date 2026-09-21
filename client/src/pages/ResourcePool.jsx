import { useEffect, useMemo, useState } from 'react';
import { api, yuan } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import { PageHead, Empty, ConfirmBadge } from '../components/ui.jsx';

const TYPES = ['航班', '酒店', '地接'];
const TYPE_ICON = { 航班: '✈️', 酒店: '🏨', 地接: '🚌' };

function availTone(d) {
  if (d.available <= 0) return 'st-zero';
  const ratio = d.available / d.qty;
  if (ratio <= 0.2) return 'st-low';
  return 'st-ok';
}

/* ---------------- 资源编辑弹窗 ---------------- */
function ResourceModal({ suppliers, initial, onClose, saved }) {
  const toast = useToast();
  const [form, setForm] = useState(initial || {
    supplier_id: '', type: '航班', name: '', sub_name: '', route: '', direction: '去程',
    service_date: '', end_date: '', qty: '', unit_price: '', status: '在售', remarks: ''
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isHotel = form.type === '酒店';

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (initial) await api.put('/resources/' + initial.id, form);
      else await api.post('/resources', form);
      toast(initial ? '采购资源已更新' : '采购资源已入库', 'success');
      saved(); onClose();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <Modal wide title={initial ? '编辑采购资源' : '新增采购资源（入库）'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" form="res-form" type="submit">保存</button></>}>
      <form id="res-form" onSubmit={submit}>
        <div className="form-grid">
          <label>资源类型 *
            <select className="input" value={form.type} disabled={!!initial}
              onChange={e => set('type', e.target.value)}>
              {TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label>供应商 *
            <select className="input" required value={form.supplier_id} onChange={e => set('supplier_id', e.target.value)}>
              <option value="">请选择</option>
              {suppliers.filter(s => !form.type || s.type === form.type).map(s =>
                <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>状态
            <select className="input" value={form.status} onChange={e => set('status', e.target.value)}>
              <option>在售</option><option>停售</option>
            </select>
          </label>
          <label className="span-2">
            {form.type === '航班' ? '航班号 *' : form.type === '酒店' ? '酒店名称 *' : '地接产品名 *'}
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)}
              placeholder={form.type === '航班' ? '如 CZ3869' : form.type === '酒店' ? '如 三亚亚特兰蒂斯酒店' : '如 三亚5日地接打包'} />
          </label>
          <label>{form.type === '酒店' ? '房型' : form.type === '航班' ? '方向' : '补充信息'}
            {form.type === '航班' ? (
              <select className="input" value={form.direction} onChange={e => set('direction', e.target.value)}>
                <option>去程</option><option>回程</option><option>联程</option>
              </select>
            ) : (
              <input className="input" value={form.sub_name} onChange={e => set('sub_name', e.target.value)}
                placeholder={form.type === '酒店' ? '如 海景双床房' : ''} />
            )}
          </label>
          {form.type !== '地接' && (
            <label className="span-2">{form.type === '航班' ? '航线' : '规格说明'}
              <input className="input" value={form.route} onChange={e => set('route', e.target.value)}
                placeholder={form.type === '航班' ? '杭州萧山 → 三亚凤凰' : ''} />
            </label>
          )}
          <label>{isHotel ? '入住起始日 *' : '服务日期 *'}
            <input type="date" className="input" required value={form.service_date}
              onChange={e => set('service_date', e.target.value)} />
          </label>
          {isHotel && (
            <label>离店日期 *
              <input type="date" className="input" required value={form.end_date || ''}
                onChange={e => set('end_date', e.target.value)} />
            </label>
          )}
          <label>采购数量 *
            <input type="number" min="1" step="1" className="input" required value={form.qty}
              onChange={e => set('qty', e.target.value)}
              placeholder={form.type === '航班' ? '座位数' : form.type === '酒店' ? '每日房量（间）' : '接待容量（团）'} />
          </label>
          <label>采购单价 *
            <input type="number" min="0" step="0.01" className="input" required value={form.unit_price}
              onChange={e => set('unit_price', e.target.value)}
              placeholder={form.type === '航班' ? '元/座' : form.type === '酒店' ? '元/间夜' : '元/团'} />
          </label>
          <label className="span-3">备注<input className="input" value={form.remarks}
            onChange={e => set('remarks', e.target.value)} /></label>
        </div>
        <div className="price-hint" style={{ marginTop: 14 }}>
          {isHotel
            ? '📌 酒店按入住日期逐日控房：采购数量为每日房量，团队占用入住日（不含离店日）每天扣减。'
            : '📌 团队计调从资源池占位后先为「待确认」，确认时锁定当时采购单价作为成本快照；之后调整采购价不影响已确认团队毛利。'}
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- 资源明细（余量/占用来源） ---------------- */
function DetailModal({ resource, onClose, changed }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const load = () => api.get('/resources/' + resource.id).then(setData).catch(e => toast(e.message, 'error'));
  useEffect(load, [resource.id]);

  const release = async (s) => {
    if (!confirm(`确认释放 ${s.tour_code} 对该资源的 ${s.qty} ${data.type === '航班' ? '座' : data.type === '酒店' ? '间' : '团'}占用？\n联动生成的计调记录将一并删除。`)) return;
    try {
      await api.post('/allocations/' + s.allocation_id + '/release', { reason: '资源池页面手工释放' });
      toast('占用已释放，库存恢复', 'success'); load(); changed();
    } catch (e) { toast(e.message, 'error'); }
  };
  const confirm = async (s) => {
    try {
      await api.post('/allocations/' + s.allocation_id + '/confirm');
      toast('已确认并锁定成本快照', 'success'); load(); changed();
    } catch (e) { toast(e.message, 'error'); }
  };

  if (!data) return null;
  const unit = data.type === '航班' ? '座' : data.type === '酒店' ? '间' : '团';

  return (
    <Modal wide title={`${TYPE_ICON[data.type]} ${data.name}${data.sub_name ? ' · ' + data.sub_name : ''}`} onClose={onClose}>
      <div className="pool-detail-meta">
        <span>供应商：<strong>{data.supplier.name}</strong></span>
        <span>采购量：<strong>{data.qty} {unit}</strong></span>
        <span>采购价：<strong>{yuan(data.unit_price)}</strong></span>
        <span>{data.service_date}{data.end_date ? ' ~ ' + data.end_date : ''}</span>
        <span className={`badge badge-${data.status === '在售' ? 'green' : 'gray'}`}>{data.status}</span>
      </div>

      <h4 className="pool-sub">逐日库存（已扣除待确认 + 已确认占用）</h4>
      <div className="stock-days">
        {data.availability.daily.map(d => (
          <div key={d.date} className={`stock-day ${availTone(d)}`}>
            <div className="stock-date">{d.date.slice(5)}</div>
            <div className="stock-num">{d.available}<small>/{d.qty}</small></div>
            <div className="stock-bar"><i style={{ width: Math.min(100, d.held / d.qty * 100) + '%' }} /></div>
            <div className="stock-held">{d.held > 0 ? `占 ${d.held}` : '空闲'}</div>
          </div>
        ))}
      </div>

      <h4 className="pool-sub">占用来源（{data.availability.sources.length}）</h4>
      {data.availability.sources.length === 0 ? <Empty text="暂无团队占用" /> : (
        <table className="table">
          <thead><tr><th>团队</th><th>数量</th><th>占用日期</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {data.availability.sources.map(s => (
              <tr key={s.allocation_id}>
                <td><a href={`#/tours/${s.tour_id}`} className="mono">{s.tour_code}</a><br /><small>{s.tour_name}</small></td>
                <td><strong>{s.qty}</strong> {unit}</td>
                <td className="small">{s.start_date}{s.end_date ? ' ~ ' + s.end_date : ''}</td>
                <td><ConfirmBadge confirmed={s.status === '已确认'} /></td>
                <td className="nowrap">
                  {s.status === '待确认' && <button className="btn btn-xs btn-primary" onClick={() => confirm(s)}>确认</button>}
                  <button className="btn btn-xs btn-danger-ghost" onClick={() => release(s)}>释放</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/* ---------------- 主页面 ---------------- */
export default function ResourcePool() {
  const toast = useToast();
  const [tab, setTab] = useState('resources');
  const [resources, setResources] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [supModal, setSupModal] = useState(null);

  const loadResources = () => {
    const qs = new URLSearchParams();
    if (typeFilter) qs.set('type', typeFilter);
    if (q.trim()) qs.set('q', q.trim());
    api.get('/resources?' + qs.toString()).then(setResources).catch(e => toast(e.message, 'error'));
  };
  const loadSuppliers = () => api.get('/suppliers').then(setSuppliers).catch(e => toast(e.message, 'error'));
  useEffect(() => { loadResources(); }, [typeFilter, q]);
  useEffect(() => { loadSuppliers(); }, []);

  const delResource = async (r) => {
    if (!confirm(`删除资源「${r.name}」？\n将自动释放其下全部有效占用（${r.availability.held} ${r.type === '航班' ? '座' : r.type === '酒店' ? '间' : '团'}），且不可恢复。`)) return;
    try {
      const res = await api.del('/resources/' + r.id);
      toast(`资源已删除，释放 ${res.released} 条占用`, 'success');
      loadResources();
    } catch (e) { toast(e.message, 'error'); }
  };

  const saveSupplier = async (e) => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(e.target));
      if (supModal?.id) await api.put('/suppliers/' + supModal.id, body);
      else await api.post('/suppliers', body);
      toast('供应商已保存', 'success'); setSupModal(null); loadSuppliers();
    } catch (err) { toast(err.message, 'error'); }
  };
  const delSupplier = async (s) => {
    if (!confirm(`删除供应商「${s.name}」？`)) return;
    try { await api.del('/suppliers/' + s.id); toast('已删除', 'success'); loadSuppliers(); }
    catch (e) { toast(e.message, 'error'); }
  };

  const stats = useMemo(() => ({
    total: resources.length,
    tight: resources.filter(r => r.availability.available === 0).length,
    low: resources.filter(r => r.availability.available > 0 && r.availability.available / r.availability.daily[0].qty <= 0.2).length,
    pending: resources.reduce((s, r) => s + r.availability.pending, 0)
  }), [resources]);

  return (
    <div>
      <PageHead title="供应商资源池" subtitle="统一维护航班座位 / 酒店每日房量 / 地接容量，团队占用实时扣减、冲突可控、成本可溯">
        <button className="btn" onClick={() => setTab(tab === 'resources' ? 'suppliers' : 'resources')}>
          {tab === 'resources' ? '🧑‍💼 管理供应商' : '📦 返回资源'}
        </button>
        {tab === 'resources' && (
          <button className="btn btn-primary" onClick={() => setModal({})}>＋ 采购入库</button>
        )}
        {tab === 'suppliers' && (
          <button className="btn btn-primary" onClick={() => setSupModal({})}>＋ 新增供应商</button>
        )}
      </PageHead>

      {tab === 'resources' ? (<>
        <div className="stat-grid">
          <div className="stat-card stat-teal"><div className="stat-icon">📦</div>
            <div><div className="stat-num">{stats.total}</div><div className="stat-label">在售/全部采购资源</div></div></div>
          <div className="stat-card stat-orange"><div className="stat-icon">⏳</div>
            <div><div className="stat-num">{stats.pending}</div><div className="stat-label">待确认占用（件）</div></div></div>
          <div className="stat-card stat-green"><div className="stat-icon">📉</div>
            <div><div className="stat-num">{stats.low}</div><div className="stat-label">余量紧张（≤20%）</div></div></div>
          <div className="stat-card stat-orange"><div className="stat-icon">🚫</div>
            <div><div className="stat-num">{stats.tight}</div><div className="stat-label">已售罄资源</div></div></div>
        </div>

        <div className="toolbar">
          <input className="input" placeholder="搜索航班号 / 酒店 / 地接产品 / 供应商"
            value={q} onChange={e => setQ(e.target.value)} />
          <div className="tabs" style={{ marginBottom: 0 }}>
            <button className={`tab ${!typeFilter ? 'on' : ''}`} onClick={() => setTypeFilter('')}>全部</button>
            {TYPES.map(t => <button key={t} className={`tab ${typeFilter === t ? 'on' : ''}`} onClick={() => setTypeFilter(t)}>
              {TYPE_ICON[t]} {t}
            </button>)}
          </div>
        </div>

        {resources.length === 0 ? <div className="card"><Empty text="暂无采购资源，点击「采购入库」添加" /></div> : (
          <div className="pool-grid">
            {resources.map(r => {
              const av = r.availability;
              const worst = av.daily.reduce((m, d) => Math.min(m, d.available / d.qty), 1);
              const soldout = av.available === 0;
              const unit = r.type === '航班' ? '座' : r.type === '酒店' ? '间' : '团';
              return (
                <div className={`pool-card ${soldout ? 'is-soldout' : worst <= 0.2 ? 'is-tight' : ''}`} key={r.id}>
                  <div className="pool-card-top">
                    <div>
                      <span className="tag">{TYPE_ICON[r.type]} {r.type}</span>
                      <span className={`badge badge-${r.status === '在售' ? 'green' : 'gray'}`}>{r.status}</span>
                    </div>
                    <div className="row-gap">
                      <button className="btn btn-xs" onClick={() => setDetail(r)}>余量/来源</button>
                      <button className="btn btn-xs" onClick={() => setModal(r)}>编辑</button>
                      <button className="btn btn-xs btn-danger-ghost" onClick={() => delResource(r)}>删</button>
                    </div>
                  </div>
                  <h3>{r.name}{r.sub_name ? <small> · {r.sub_name}</small> : ''}</h3>
                  <div className="small">{r.supplier_name}{r.route ? ` · ${r.route}` : ''}</div>
                  <div className="small mono">{r.service_date}{r.end_date ? ' ~ ' + r.end_date : ''}</div>
                  <div className={`pool-avail ${soldout ? 'text-red' : worst <= 0.2 ? 'text-red' : 'text-green'}`}>
                    <strong>{av.available}</strong> / {r.qty} {unit}
                    <small> 实时余量（待确认 {av.pending} · 已确认 {av.confirmed}）</small>
                  </div>
                  {r.type === '酒店' && (
                    <div className="mini-days">
                      {av.daily.map(d => <i key={d.date} title={`${d.date} 余 ${d.available}`} className={availTone(d)} />)}
                    </div>
                  )}
                  <div className="pool-price">采购 {yuan(r.unit_price)}<small> / {r.type === '航班' ? '座' : r.type === '酒店' ? '间夜' : '团'}</small></div>
                </div>
              );
            })}
          </div>
        )}
      </>) : (
        <div className="card">
          <table className="table">
            <thead><tr><th>供应商</th><th>类型</th><th>联系人</th><th>电话</th><th>状态</th><th>资源数</th><th>备注</th><th></th></tr></thead>
            <tbody>
              {suppliers.map(s => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong></td>
                  <td><span className="tag">{TYPE_ICON[s.type]} {s.type}</span></td>
                  <td>{s.contact || '—'}</td>
                  <td className="mono small">{s.phone || '—'}</td>
                  <td><span className={`badge badge-${s.status === '合作中' ? 'green' : 'gray'}`}>{s.status}</span></td>
                  <td>{s.resource_count}</td>
                  <td className="small">{s.remarks || '—'}</td>
                  <td className="nowrap">
                    <button className="btn btn-xs" onClick={() => setSupModal(s)}>编辑</button>
                    <button className="btn btn-xs btn-danger-ghost" onClick={() => delSupplier(s)}>删</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && <ResourceModal suppliers={suppliers} initial={modal.id ? modal : null}
        onClose={() => setModal(null)} saved={() => { loadResources(); loadSuppliers(); }} />}
      {detail && <DetailModal resource={detail} onClose={() => setDetail(null)}
        changed={() => { loadResources(); }} />}
      {supModal && (
        <Modal title={supModal.id ? '编辑供应商' : '新增供应商'} onClose={() => setSupModal(null)}
          footer={<><button className="btn" onClick={() => setSupModal(null)}>取消</button>
            <button className="btn btn-primary" form="sup-form" type="submit">保存</button></>}>
          <form id="sup-form" onSubmit={saveSupplier} className="form-grid">
            <label className="span-2">供应商名称 *<input name="name" required className="input" defaultValue={supModal.name || ''} /></label>
            <label>类型 *
              <select name="type" className="input" defaultValue={supModal.type || '酒店'} disabled={!!supModal.id}>
                {TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label>联系人<input name="contact" className="input" defaultValue={supModal.contact || ''} /></label>
            <label>电话<input name="phone" className="input" defaultValue={supModal.phone || ''} /></label>
            <label>状态
              <select name="status" className="input" defaultValue={supModal.status || '合作中'}>
                <option>合作中</option><option>已停用</option>
              </select>
            </label>
            <label className="span-3">备注<input name="remarks" className="input" defaultValue={supModal.remarks || ''} /></label>
          </form>
        </Modal>
      )}
    </div>
  );
}
