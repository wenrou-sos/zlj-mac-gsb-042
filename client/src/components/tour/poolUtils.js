// 团队计调页资源池辅助：按计调记录聚合实时余量 / 冲突日期
// pool_availability 来自 GET /tours/:id，每条为某占用（某晚）的实时余量。
export function availByBooking(tour) {
  const map = new Map();
  for (const a of tour.pool_availability || []) {
    const key = `${a.booking_type}:${a.booking_id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  for (const arr of map.values()) arr.sort((x, y) => x.date.localeCompare(y.date));
  return map;
}

export function bookingAvail(tour, type, id) {
  return availByBooking(tour).get(`${type}:${id}`) || null;
}

// 多晚（酒店）汇总：最紧余量、冲突日期列表
export function availSummary(avail) {
  if (!avail || !avail.length) return null;
  const min = avail.reduce((m, a) => Math.min(m, a.available), Infinity);
  const conflictDates = avail.filter(a => a.shortage).map(a => a.date);
  const stopped = avail.some(a => a.resource_status !== '开放');
  return { min, conflictDates, stopped, nights: avail.length };
}
