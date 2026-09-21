import { useEffect, useState } from 'react';
import Dashboard from './pages/Dashboard.jsx';
import Products from './pages/Products.jsx';
import ProductEdit from './pages/ProductEdit.jsx';
import Tours from './pages/Tours.jsx';
import TourNew from './pages/TourNew.jsx';
import TourDetail from './pages/TourDetail.jsx';
import ResourcePool from './pages/ResourcePool.jsx';

const NAV = [
  { hash: '#/', label: '工作台', icon: '🏠' },
  { hash: '#/products', label: '旅游产品', icon: '🗺️' },
  { hash: '#/tours', label: '团队收客', icon: '👥' },
  { hash: '#/resources', label: '供应商资源池', icon: '📦' }
];

function parseHash() {
  const h = window.location.hash || '#/';
  const parts = h.replace(/^#\//, '').split('/').filter(Boolean);
  return parts;
}

export default function App() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  let page;
  const [a, b] = route;
  if (!a) page = <Dashboard />;
  else if (a === 'products' && !b) page = <Products />;
  else if (a === 'products' && (b === 'new' || /^\d+$/.test(b))) page = <ProductEdit id={/^\d+$/.test(b) ? b : null} />;
  else if (a === 'tours' && !b) page = <Tours />;
  else if (a === 'tours' && b === 'new') page = <TourNew />;
  else if (a === 'tours' && /^\d+$/.test(b)) page = <TourDetail id={b} />;
  else if (a === 'resources') page = <ResourcePool />;
  else page = <Dashboard />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo"><span>✈️</span><div>云游国旅<br /><small>组团·计调平台</small></div></div>
        <nav>
          {NAV.map(n => {
            const active = (n.hash === '#/' && !a) || (n.hash !== '#/' && a === n.hash.slice(2));
            return <a key={n.hash} href={n.hash} className={active ? 'active' : ''}>
              <span className="nav-icon">{n.icon}</span>{n.label}
            </a>;
          })}
        </nav>
        <div className="sidebar-footer">销售部 / 计调部协同系统<br />React · SQLite</div>
      </aside>
      <main className="content">{page}</main>
    </div>
  );
}
