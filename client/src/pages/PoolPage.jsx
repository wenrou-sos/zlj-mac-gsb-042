import { useEffect, useMemo, useState } from 'react';
import { api, yuan } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import SourcesModal from '../components/pool/SourcesModal.jsx';
import { PageHead, Empty } from '../components/ui.jsx';

const TYPE_LABEL = { flight: '航班座位', hotel: '酒店房量', local: '地接容量' };
const TYPE_ICON = { flight: '✈️', hotel: '🏨', local: '🚌' };

/* ---------------- 供应商弹窗 ---------------- */
function SupplierModal({ su, onClose, reload }) {
  const toast = useToast();
  const [form, setForm] = useState(su || { name: '', type: '综合', contact: '', phone: '', remarks: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const save = async (e) => {
    e.preventDefault();
    try {
      if (su) await api.put('/suppliers/' + su.id, form);
      else await api.post('/suppliers', form);
      onClose(); reload(); toast('供应商已保存', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <Modal title={su ? '编辑供应商' : '新增供应商'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" form="su-form" type="submit">保存</button></>}>
      <form id="su-form" onSubmit={save}>
        <div className="form-grid">
          <label className="span-2">供应商名称 *<input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="航司/包机商、酒店集采、地接社" /></label>
          <label>类型
            <select className="input" value={form.type} onChange={e => set('type', e.target.value)}>
              <option>综合</option><option>航空</option><option>酒店</option><option>地接</option>
            </select>
          </label>
          <label>联系人<input className="input" value={form.contact} onChange={e => set('contact', e.target.value)} /></label>
          <label>联系电话<input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} /></label>
          <label className="span-3">备注<input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)} /></label>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- 资源弹窗 ---------------- */
const blankResource = {
  type: 'flight', supplier_id: '', date: '', end_date: '',
  flight_no: '', route: '', hotel_name: '', room_type: '标间',
  service_name: '', service_unit: '', quantity: '', unit_price: '', unit: '', status: '开放', remarks: ''
};

function ResourceModal({ resource, suppliers, onClose, reload }) {
  const toast = useToast();
  const [form, setForm] = useState(resource || blankResource);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isHotel = form.type === 'hotel';
  const isFlight = form.type === 'flight';
  const isLocal = form.type === 'local';
  const editing = !!resource;

  const save = async (e) => {
    e.preventDefault();
    const body = { ...form };
    if (!isHotel || editing) delete body.end_date; // 编辑只改单晚；新建酒店保留连住区间
    try {
      if (editing) await api.put('/resources/' + resource.id, body);
      else await api.post('/resources', body);
      onClose(); reload(); toast('资源已保存', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };

  return (
    <Modal title={editing ? `编辑${TYPE_LABEL[form.type]}资源` : `新增${TYPE_LABEL[form.type]}资源`} wide onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" form="res-form" type="submit">保存</button></>}>
      <form id="res-form" onSubmit={save}>
        <div className="form-grid">
          <label>资源类型 *
            <select className="input" value={form.type} disabled={editing}
              onChange={e => set('type', e.target.value)}>
              <option value="flight">航班座位（按航班日期）</option>
              <option value="hotel">酒店房量（按入住日期逐日）</option>
              <option value="local">地接服务容量（按服务日期）</option>
            </select>
          </label>
          <label className="span-2">供应商 *
            <select className="input" required value={form.supplier_id} onChange={e => set('supplier_id', Number(e.target.value))}>
              <option value="">请选择供应商</option>
              {suppliers.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}（{s.type}）</option>)}
            </select>
          </label>

          {isFlight && <>
            <label>航班日期 *<input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} /></label>
            <label>航班号 *<input className="input mono" required value={form.flight_no} onChange={e => set('flight_no', e.target.value)} placeholder="MU5802" /></label>
            <label>航线<input className="input" value={form.route} onChange={e => set('route', e.target.value)} placeholder="上海虹桥 → 昆明长水" /></label>
          </>}

          {isHotel && <>
            <label>{editing ? '入住日期（当晚）' : '首晚入住日期'} *<input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} /></label>
            {!editing && <label>最后一晚（可选，连续采购）<input type="date" className="input" value={form.end_date} min={form.date} onChange={e => set('end_date', e.target.value)} /></label>}
            <label>酒店名称 *<input className="input" required value={form.hotel_name} onChange={e => set('hotel_name', e.target.value)} /></label>
            <label>房型 *<input className="input" required value={form.room_type} onChange={e => set('room_type', e.target.value)} placeholder="标间/大床/海景双床房" /></label>
          </>}

          {isLocal && <>
            <label>服务日期 *<input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} /></label>
            <label className="span-2">地接服务名称 *<input className="input" required value={form.service_name} onChange={e => set('service_name', e.target.value)} placeholder="如：云南6日地接一揽子（33座大巴/中文导游）" /></label>
            <label className="span-3">计量单位说明<input className="input" value={form.service_unit} onChange={e => set('service_unit', e.target.value)} placeholder="如：33座大巴+导游，按人份计价" /></label>
          </>}

          <label>采购数量 *<input type="number" min="1" className="input" required value={form.quantity} onChange={e => set('quantity', e.target.value)} /></label>
          <label>单位
            <input className="input" list="unit-list" value={form.unit || (isFlight ? '座' : isHotel ? '间' : '人')}
              onChange={e => set('unit', e.target.value)} />
            <datalist id="unit-list"><option>座</option><option>间</option><option>人</option><option>份</option></datalist>
          </label>
          <label>采购单价（元）<input type="number" min="0" step="0.01" className="input" value={form.unit_price} onChange={e => set('unit_price', e.target.value)} /></label>
          <label>资源状态
            <select className="input" value={form.status || '开放'} onChange={e => set('status', e.target.value)}>
              <option>开放</option><option>停售</option>
            </select>
          </label>
          <label className="span-2">备注<input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)} /></label>
        </div>
        {isHotel && !editing && form.end_date && <div className="price-hint" style={{ marginTop: 12 }}>
          ℹ️ 将按入住日期逐晚生成资源记录（{form.date} 至 {form.end_date}，含首尾两晚），每晚房量与单价一致；确认占用时按晚锁定成本快照。
        </div>}
      </form>
    </Modal>
  );
}

/* ---------------- 主页面 ---------------- */
export default function PoolPage() {
  const toast = useToast();
  const [suppliers, setSuppliers] = useState([]);
  const [resources, setResources] = useState([]);
  const [filter, setFilter] = useState({ type: '', supplier_id: '', status: '', date: '', q: '' });
  const [suModal, setSuModal] = useState(null);
  const [resModal, setResModal] = useState(null);
  const [sourcesFor, setSourcesFor] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      Object.entries(filter).forEach(([k, v]) => v && qs.set(k, v));
      const [su, rs] = await Promise.all([api.get('/suppliers'), api.get('/resources?' + qs.toString())]);
      setSuppliers(su); setResources(rs);
    } catch (e) { toast(e.message, 'error'); }
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [filter.type, filter.supplier_id, filter.status, filter.date, filter.q]);

  const suName = useMemo(() => Object.fromEntries(suppliers.map(s => [s.id, s.name])), [suppliers]);

  const toggleResource = async (r) => {
    try { await api.post(`/resources/${r.id}/toggle`); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const toggleSupplier = async (s) => {
    try { await api.post(`/suppliers/${s.id}/toggle`); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const delResource = async (r) => {
    if (!confirm(`确认删除该资源？\n${r.flight_no || r.hotel_name || r.service_name} ${r.date || ''}\n待确认占用将自动释放，已确认占用会阻止删除。`)) return;
    try { await api.del('/resources/' + r.id); reload(); toast('资源已删除', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  const delSupplier = async (s) => {
    if (!confirm(`确认删除供应商「${s.name}」？名下有资源记录时无法删除。`)) return;
    try { await api.del('/suppliers/' + s.id); reload(); toast('供应商已删除', 'success'); } catch (e) { toast(e.message, 'error'); }
  };

  const stats = {
    total: resources.length,
    tight: resources.filter(r => r.available >= 0 && r.available <= 3).length,
    full: resources.filter(r => r.available <= 0).length,
    stopped: resources.filter(r => r.status === '停售').length
  };

  return (
    <div>
      <PageHead title="供应商资源池" subtitle="统一维护航班座位、酒店每日房量与地接服务容量：供应商、日期、采购数量、单价与状态">
        <button className="btn" onClick={() => setSuModal({})}>＋ 供应商</button>
        <button className="btn btn-primary" onClick={() => setResModal({})}>＋ 新建资源</button>
      </PageHead>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <div className="stat-card stat-teal"><div className="stat-icon">📦</div><div><div className="stat-num">{stats.total}</div><div className="stat-label">资源记录</div></div></div>
        <div className="stat-card stat-orange"><div className="stat-icon">⚠️</div><div><div className="stat-num">{stats.tight}</div><div className="stat-label">余量 ≤ 3（紧张）</div></div></div>
        <div className="stat-card stat-green"><div className="stat-icon">🔒</div><div><div className="stat-num">{stats.full}</div><div className="stat-label">已占满</div></div></div>
        <div className="stat-card stat-blue"><div className="stat-icon">🚫</div><div><div className="stat-num">{stats.stopped}</div><div className="stat-label">停售</div></div></div>
      </div>

      <div className="card">
        <div className="ops-head">
          <h3>🏢 供应商 <small>共 {suppliers.length} 家</small></h3>
        </div>
        <table className="table">
          <thead><tr><th>名称</th><th>类型</th><th>联系人</th><th>电话</th><th>资源数</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {suppliers.map(s => (
              <tr key={s.id} className={s.active ? '' : 'row-cancel'}>
                <td><strong>{s.name}</strong>{s.remarks && <small className="muted">　{s.remarks}</small>}</td>
                <td><span className="tag">{s.type}</span></td>
                <td>{s.contact || '—'}</td><td className="mono small">{s.phone || '—'}</td>
                <td>{s.resource_count}</td>
                <td><span className={`badge badge-${s.active ? 'green' : 'gray'}`}>{s.active ? '合作中' : '已停用'}</span></td>
                <td className="nowrap">
                  <button className="btn btn-xs" onClick={() => setSuModal(s)}>编辑</button>
                  <button className="btn btn-xs" onClick={() => toggleSupplier(s)}>{s.active ? '停用' : '启用'}</button>
                  <button className="btn btn-xs btn-danger-ghost" onClick={() => delSupplier(s)}>删</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="toolbar">
          <select className="input" value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}>
            <option value="">全部类型</option>
            <option value="flight">航班座位</option>
            <option value="hotel">酒店房量</option>
            <option value="local">地接容量</option>
          </select>
          <select className="input" value={filter.supplier_id} onChange={e => setFilter(f => ({ ...f, supplier_id: e.target.value }))}>
            <option value="">全部供应商</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="input" value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
            <option value="">全部状态</option><option value="开放">开放</option><option value="停售">停售</option>
          </select>
          <input type="date" className="input" style={{ maxWidth: 170 }} value={filter.date} onChange={e => setFilter(f => ({ ...f, date: e.target.value }))} />
          <input className="input" placeholder="搜索航班号/酒店/地接服务/供应商" value={filter.q}
            onChange={e => setFilter(f => ({ ...f, q: e.target.value }))} />
        </div>

        {loading ? <div className="empty">加载中…</div> : resources.length === 0 ? <Empty text="资源池为空，点击右上角「新建资源」录入采购库存" /> : (
          <table className="table">
            <thead><tr>
              <th>类型</th><th>日期</th><th>资源</th><th>供应商</th><th>采购量</th><th>有效占用</th><th>实时余量</th><th>单价</th><th>状态</th><th></th>
            </tr></thead>
            <tbody>
              {resources.map(r => {
                const tight = r.available <= 3;
                return (
                  <tr key={r.id}>
                    <td>{TYPE_ICON[r.type]} <span className="tag">{TYPE_LABEL[r.type]}</span></td>
                    <td className="mono small">{r.date}{r.end_date && r.end_date !== r.date ? <small> 起（连住）</small> : ''}</td>
                    <td>
                      {r.type === 'flight' && <strong className="mono">{r.flight_no}</strong>}
                      {r.type === 'hotel' && <><strong>{r.hotel_name}</strong> <span className="tag">{r.room_type}</span></>}
                      {r.type === 'local' && <><strong>{r.service_name}</strong>{r.service_unit && <small className="muted">　{r.service_unit}</small>}</>}
                      {r.route && <div className="muted">{r.route}</div>}
                    </td>
                    <td className="small">{suName[r.supplier_id] || r.supplier_name}</td>
                    <td>{r.quantity} {r.unit}</td>
                    <td>{r.held}</td>
                    <td><strong className={r.status === '停售' ? '' : tight ? 'text-red' : 'text-green'}>
                      {r.available}{tight && r.status === '开放' ? ' ⚠️' : ''}
                    </strong></td>
                    <td>{yuan(r.unit_price)}</td>
                    <td><span className={`badge badge-${r.status === '开放' ? 'green' : 'gray'}`}>{r.status}</span></td>
                    <td className="nowrap">
                      <button className="btn btn-xs" onClick={() => setSourcesFor(r)}>来源</button>
                      <button className="btn btn-xs" onClick={() => setResModal(r)}>改</button>
                      <button className="btn btn-xs" onClick={() => toggleResource(r)}>{r.status === '开放' ? '停售' : '开售'}</button>
                      <button className="btn btn-xs btn-danger-ghost" onClick={() => delResource(r)}>删</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card note-card">
        💡 余量 = 采购数量 − 所有团队「待确认 + 已确认」的有效占用；酒店按入住日期逐晚扣减，冲突时系统会返回具体日期与当晚剩余量。
        团队「确认」占用时锁定成本快照，之后在此调价不会改变已确认团队的毛利。
      </div>

      {suModal && <SupplierModal su={suModal.id ? suModal : null} onClose={() => setSuModal(null)} reload={reload} />}
      {resModal && <ResourceModal resource={resModal.id ? resModal : null} suppliers={suppliers} onClose={() => setResModal(null)} reload={reload} />}
      {sourcesFor && <SourcesModal resourceId={sourcesFor.id} onClose={() => setSourcesFor(null)} />}
    </div>
  );
}
