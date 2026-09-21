import { useEffect, useState } from 'react';
import { api, yuan } from '../api.js';

export default function Products() {
  const [list, setList] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.get('/products?q=' + encodeURIComponent(q)).then(setList).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const remove = async (p) => {
    if (!confirm(`确认删除产品「${p.name}」？此操作不可恢复。`)) return;
    try {
      await api.del('/products/' + p.id);
      load();
    } catch (e) { alert(e.message); }
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>旅游产品</h1><p>销售部维护线路行程与三档报价</p></div>
        <a className="btn btn-primary" href="#/products/new">＋ 新建产品</a>
      </div>

      <div className="toolbar">
        <input className="input" placeholder="搜索线路名称 / 出发城市 / 目的地"
          value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
        <button className="btn" onClick={load}>搜索</button>
      </div>

      {loading ? <div className="loading">加载中…</div> : list.length === 0 ? <div className="empty">📭 暂无产品，点击「新建产品」</div> : (
        <div className="product-grid">
          {list.map(p => (
            <div className="product-card" key={p.id}>
              <div className="product-top">
                <span className="badge badge-teal">{p.days} 天</span>
                <span className="product-route">{p.departure_city} → {p.destination}</span>
              </div>
              <h3>{p.name}</h3>
              <div className="price-row">
                <div><small>双人房</small><strong>{yuan(p.price_double)}</strong></div>
                <div><small>三人房</small><strong>{yuan(p.price_triple)}</strong></div>
                <div><small>儿童不占床</small><strong>{yuan(p.price_child)}</strong></div>
              </div>
              <div className="product-foot">
                <small>已建团 {p.tour_count} 次</small>
                <div className="row-gap">
                  <a className="btn btn-sm" href={`#/tours/new?product=${p.id}`}>创建团队</a>
                  <a className="btn btn-sm" href={`#/products/${p.id}`}>编辑</a>
                  <button className="btn btn-sm btn-danger-ghost" onClick={() => remove(p)}>删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
