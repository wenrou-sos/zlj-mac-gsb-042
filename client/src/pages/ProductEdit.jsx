import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

const EMPTY = {
  name: '', days: 1, departure_city: '', destination: '',
  price_double: '', price_triple: '', price_child: '', description: ''
};

export default function ProductEdit({ id }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [days, setDays] = useState([{ day_no: 1, title: '', attractions: '', meals: '', hotel: '' }]);
  const [loaded, setLoaded] = useState(!id);

  useEffect(() => {
    if (id) {
      api.get('/products/' + id).then(p => {
        setForm({ ...p });
        setDays(p.itinerary.length ? p.itinerary : buildDays(p.days));
        setLoaded(true);
      }).catch(e => toast(e.message, 'error'));
    }
  }, [id]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function buildDays(n) {
    return Array.from({ length: Number(n) }, (_, i) => ({ day_no: i + 1, title: '', attractions: '', meals: '', hotel: '' }));
  }

  // 调整天数时尽量保留已填内容
  const changeDays = (n) => {
    n = Math.max(1, Math.min(30, Number(n) || 1));
    set('days', n);
    setDays(prev => {
      const next = [...prev];
      if (n > next.length) for (let i = next.length + 1; i <= n; i++) next.push({ day_no: i, title: '', attractions: '', meals: '', hotel: '' });
      else next.length = n;
      return next.map((d, i) => ({ ...d, day_no: i + 1 }));
    });
  };

  const setDay = (i, k, v) => setDays(ds => ds.map((d, j) => j === i ? { ...d, [k]: v } : d));

  const save = async (e) => {
    e.preventDefault();
    const body = { ...form, itinerary: days };
    try {
      if (id) { await api.put('/products/' + id, body); toast('产品已更新', 'success'); }
      else { await api.post('/products', body); toast('产品已创建', 'success'); window.location.hash = '#/products'; }
    } catch (err) { toast(err.message, 'error'); }
  };

  if (!loaded) return <div className="loading">加载中…</div>;

  return (
    <div>
      <div className="page-head">
        <div><h1>{id ? '编辑产品' : '新建旅游产品'}</h1><p>维护线路基础信息、每日行程与三档价格</p></div>
        <a className="btn" href="#/products">← 返回列表</a>
      </div>

      <form onSubmit={save}>
        <div className="card form-card">
          <h3 className="card-title">基础信息</h3>
          <div className="form-grid">
            <label className="span-2">线路名称
              <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="如：云南昆明大理丽江双飞6日游" />
            </label>
            <label>行程天数
              <input className="input" type="number" min="1" max="30" value={form.days} onChange={e => changeDays(e.target.value)} />
            </label>
            <label>出发城市
              <input className="input" required value={form.departure_city} onChange={e => set('departure_city', e.target.value)} />
            </label>
            <label>目的地
              <input className="input" required value={form.destination} onChange={e => set('destination', e.target.value)} />
            </label>
            <label>双人房报价（元/人）
              <input className="input" type="number" min="0" step="0.01" value={form.price_double} onChange={e => set('price_double', e.target.value)} />
            </label>
            <label>三人房报价（元/人）
              <input className="input" type="number" min="0" step="0.01" value={form.price_triple} onChange={e => set('price_triple', e.target.value)} />
            </label>
            <label>儿童不占床（元/人）
              <input className="input" type="number" min="0" step="0.01" value={form.price_child} onChange={e => set('price_child', e.target.value)} />
            </label>
            <label className="span-3">产品说明
              <textarea className="input" rows="2" value={form.description || ''} onChange={e => set('description', e.target.value)} />
            </label>
          </div>
        </div>

        <div className="card form-card">
          <h3 className="card-title">每日行程安排（共 {form.days} 天）</h3>
          <div className="itinerary-list">
            {days.map((d, i) => (
              <div className="day-block" key={i}>
                <div className="day-head">
                  <span className="day-no">D{d.day_no}</span>
                  <input className="input day-title" placeholder="当日主题，如：上海飞昆明，入住酒店"
                    value={d.title} onChange={e => setDay(i, 'title', e.target.value)} />
                </div>
                <div className="day-grid">
                  <label>🏞 景点安排<textarea rows="2" className="input" value={d.attractions} onChange={e => setDay(i, 'attractions', e.target.value)} /></label>
                  <label>🍽 用餐安排<textarea rows="2" className="input" placeholder="早/中/晚" value={d.meals} onChange={e => setDay(i, 'meals', e.target.value)} /></label>
                  <label>🏨 住宿<textarea rows="2" className="input" value={d.hotel} onChange={e => setDay(i, 'hotel', e.target.value)} /></label>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="form-actions">
          <a className="btn" href="#/products">取消</a>
          <button className="btn btn-primary" type="submit">💾 保存产品</button>
        </div>
      </form>
    </div>
  );
}
