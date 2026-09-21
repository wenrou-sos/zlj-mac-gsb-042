import { yuan } from '../../api.js';

export default function FinanceTab({ tour }) {
  const { finance } = tour;
  const costRows = [
    { label: '航空切位', value: finance.costs.flight, icon: '✈️', n: tour.flights.length },
    { label: '酒店控房', value: finance.costs.hotel, icon: '🏨', n: tour.hotels.length },
    { label: '地接服务', value: finance.costs.local, icon: '🚌', n: tour.local_services.length },
    { label: '其他成本', value: finance.costs.other, icon: '🧾', n: tour.other_costs.length }
  ];

  return (
    <div className="finance-tab">
      <div className="finance-cards">
        <div className="fin-card fin-revenue">
          <div className="fin-label">团总收入（游客报名费）</div>
          <div className="fin-value">{yuan(finance.revenue)}</div>
          <div className="fin-sub">按 {finance.headcount} 名在团游客实收团费汇总</div>
        </div>
        <div className="fin-card fin-cost">
          <div className="fin-label">计调各项支出合计</div>
          <div className="fin-value">{yuan(finance.costs.total)}</div>
          <div className="fin-sub">切位 + 控房 + 地接 + 其他</div>
        </div>
        <div className={`fin-card ${finance.grossProfit >= 0 ? 'fin-profit' : 'fin-loss'}`}>
          <div className="fin-label">预估毛利 {finance.headcount > 0 && <small>毛利率 {finance.margin}%</small>}</div>
          <div className="fin-value">{yuan(finance.grossProfit)}</div>
          <div className="fin-sub">{finance.grossProfit >= 0 ? '收入 − 支出' : '⚠️ 成本已超过收入，请复核报价或控位规模'}</div>
        </div>
      </div>

      <div className="finance-detail-grid">
        <div className="card">
          <h3 className="card-title">收入明细（按游客）</h3>
          <table className="table">
            <thead><tr><th>游客</th><th>房型</th><th>团费</th></tr></thead>
            <tbody>
              {tour.tourists.filter(t => t.status !== '已退团').map(t => (
                <tr key={t.id}><td>{t.name}</td><td><span className="tag">{t.room_type}</span></td><td>{yuan(t.price)}</td></tr>
              ))}
              <tr className="row-sum"><td colSpan="2">收入合计</td><td className="text-green"><strong>{yuan(finance.revenue)}</strong></td></tr>
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3 className="card-title">支出明细（计调资源）</h3>
          <table className="table">
            <thead><tr><th>项目</th><th>笔数</th><th>金额</th></tr></thead>
            <tbody>
              {costRows.map(r => (
                <tr key={r.label}><td>{r.icon} {r.label}</td><td>{r.n}</td><td>{yuan(r.value)}</td></tr>
              ))}
              <tr className="row-sum"><td colSpan="2">支出合计</td><td className="text-red"><strong>{yuan(finance.costs.total)}</strong></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card note-card">
        💡 毛利为实时估算：切位成本 = 座位数 × 切位价（含去回程）；酒店成本 = 间数 × 晚均价 × 晚数；地接与其他成本按录入金额。
        未确认（待确认状态）的计调资源同样计入成本预估。
      </div>
    </div>
  );
}
