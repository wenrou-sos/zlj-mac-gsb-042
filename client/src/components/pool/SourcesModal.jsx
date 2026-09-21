import { useEffect, useState } from 'react';
import { api, yuan } from '../../api.js';
import { useToast } from '../Toast.jsx';
import Modal from '../Modal.jsx';
import { Empty, ConfirmBadge } from '../ui.jsx';

const TYPE_LABEL = { flight: '航班座位', hotel: '酒店房量', local: '地接容量' };

// 资源占用来源：实时余量（酒店逐晚）+ 各团队占用明细（含快照单价）
export default function SourcesModal({ resourceId, title, onClose }) {
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    api.get('/resources/' + resourceId).then(setDetail).catch(e => toast(e.message, 'error'));
  }, [resourceId]);

  if (!detail) return <Modal title={title || '占用来源'} onClose={onClose}><div className="loading">加载中…</div></Modal>;

  const nights = detail.nights || [{
    resource_id: detail.id, date: detail.date, quantity: detail.quantity,
    unit_price: detail.unit_price, status: detail.status, held: detail.held, available: detail.available
  }];

  return (
    <Modal wide title={title || `占用来源 · ${detail.flight_no || detail.hotel_name || detail.service_name}${detail.room_type ? ' ' + detail.room_type : ''}`}
      onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>关闭</button>}>
      <table className="table">
        <thead><tr><th>{detail.type === 'hotel' ? '入住日期（晚）' : '日期'}</th><th>采购量</th><th>有效占用</th><th>实时余量</th><th>单价</th><th>状态</th></tr></thead>
        <tbody>
          {nights.map(n => (
            <tr key={n.date} className={n.available <= 0 ? 'row-cancel' : ''}>
              <td className="mono">{n.date}{n.missing && <span className="text-red"> 缺房量记录</span>}</td>
              <td>{n.quantity}</td><td>{n.held}</td>
              <td className={n.available <= 3 ? 'text-red' : 'text-green'}><strong>{n.available}</strong></td>
              <td>{yuan(n.unit_price)}</td>
              <td><span className={`badge badge-${n.status === '开放' ? 'green' : 'gray'}`}>{n.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="card-title" style={{ marginTop: 18 }}>各团队占用明细{detail.type === 'hotel' ? '（首晚资源；逐晚余量见上表）' : ''}</h3>
      {detail.sources.length === 0 ? <Empty text="当前无有效占用" /> : (
        <table className="table">
          <thead><tr><th>团队</th><th>业务</th><th>日期</th><th>数量</th><th>状态</th><th>快照单价</th><th>快照成本</th></tr></thead>
          <tbody>
            {detail.sources.map(o => (
              <tr key={o.id}>
                <td>{o.tour_id ? <a href={`#/tours/${o.tour_id}`} className="mono">{o.tour_code || '(团队)'}</a> : <span className="muted">团队已删除</span>}</td>
                <td><span className="tag">{TYPE_LABEL[o.booking_type]}</span></td>
                <td className="mono small">{o.service_date}</td><td>{o.quantity}</td>
                <td><ConfirmBadge confirmed={o.status === '已确认'} /></td>
                <td className={o.unit_price_snapshot !== detail.unit_price ? 'text-red' : ''}>
                  {yuan(o.unit_price_snapshot)}{o.status === '已确认' && <small> 🔒</small>}
                </td>
                <td>{yuan(o.cost_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="price-hint" style={{ marginTop: 12 }}>🔒 确认时锁定成本快照，供应商后续调价不影响该团队毛利；「待确认」占用跟随最新采购价。</div>
    </Modal>
  );
}
