import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

export default function TourNew() {
  const toast = useToast();
  const [products, setProducts] = useState([]);
  const preset = new URLSearchParams(window.location.hash.split('?')[1] || '').get('product');
  const [form, setForm] = useState({
    product_id: preset || '', code: '', departure_date: '', return_date: '', capacity: 20, tour_leader: '', remarks: ''
  });

  useEffect(() => { api.get('/products').then(setProducts); }, []);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const product = products.find(p => String(p.id) === String(form.product_id));

  const submit = async (e) => {
    e.preventDefault();
    try {
      const t = await api.post('/tours', form);
      toast('团队创建成功，开始收客吧', 'success');
      window.location.hash = '#/tours/' + t.id;
    } catch (err) { toast(err.message, 'error'); }
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>创建团队</h1><p>选择产品、出发日期与团容量，团号留空将按出发日期自动生成</p></div>
        <a className="btn" href="#/tours">← 返回列表</a>
      </div>

      <form className="card form-card" style={{ maxWidth: 720 }} onSubmit={submit}>
        <div className="form-grid">
          <label className="span-3">选择旅游产品
            <select className="input" required value={form.product_id} onChange={e => set('product_id', e.target.value)}>
              <option value="">— 请选择 —</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}（{p.departure_city}→{p.destination}，{p.days}天）</option>)}
            </select>
          </label>
          {product && (
            <div className="span-3 price-hint">
              参考报价：双人房 ¥{product.price_double} / 三人房 ¥{product.price_triple} / 儿童不占床 ¥{product.price_child}
            </div>
          )}
          <label>团号（可留空自动生成）
            <input className="input mono" placeholder="如 TH20261001-001" value={form.code} onChange={e => set('code', e.target.value)} />
          </label>
          <label>团容量（人数）
            <input className="input" type="number" min="1" value={form.capacity} onChange={e => set('capacity', e.target.value)} />
          </label>
          <label>领队
            <input className="input" value={form.tour_leader} onChange={e => set('tour_leader', e.target.value)} />
          </label>
          <label>出发日期
            <input className="input" type="date" required value={form.departure_date} onChange={e => set('departure_date', e.target.value)} />
          </label>
          <label>返程日期
            <input className="input" type="date" value={form.return_date} onChange={e => set('return_date', e.target.value)} />
          </label>
          <label className="span-3">备注
            <textarea className="input" rows="2" value={form.remarks} onChange={e => set('remarks', e.target.value)} />
          </label>
        </div>
        <div className="form-actions">
          <a className="btn" href="#/tours">取消</a>
          <button className="btn btn-primary" type="submit">创建并进入团队</button>
        </div>
      </form>
    </div>
  );
}
