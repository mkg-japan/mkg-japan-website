// Vercel Function: PMS-based availability for MKG HOME 芝 (hotel 30958695)
// GET /api/shiba-pms-avail?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD

const HOTEL_NUM     = '30958695';
const PMS_CLIENT_ID = '1513859491169472512';
const PMS_SECRET    = 'UJKaBl2TYGngV8DQMSCv2Gx6UZtYYcYh';
const TOKEN_URL     = 'https://idp.smartorder.ai/realms/smartorder-booking-api/protocol/openid-connect/token';
const PMS_BASE      = 'https://api-open-pms.smartorder.ai';

// Physical room number → SmartOrder room type ID (each room is its own type)
const ROOM_TYPE_MAP = {
  '101': '900014422',
  '102': '900014421',
  '201': '900014423',
  '202': '900014424',
  '301': '900014425',
  '401': '900014426',
};

// Each room type has exactly 1 physical room
const TYPE_TOTAL = {
  '900014422': 1,
  '900014421': 1,
  '900014423': 1,
  '900014424': 1,
  '900014425': 1,
  '900014426': 1,
};

let _pmsToken = null, _pmsExpiry = 0;

async function getPmsToken() {
  if (_pmsToken && Date.now() < _pmsExpiry) return _pmsToken;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: PMS_CLIENT_ID,
    client_secret: PMS_SECRET,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  _pmsToken = j.access_token;
  _pmsExpiry = Date.now() + (j.expires_in - 60) * 1000;
  return _pmsToken;
}

async function searchOrders(token, beginDate, endDate, dateType) {
  const r = await fetch(`${PMS_BASE}/pms/api/v3/order/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hotelNum: HOTEL_NUM, beginDate, endDate, dateType, pageNum: 1, pageSize: 200 }),
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json();
  return (j.data && j.data.list) ? j.data.list : [];
}

async function getOrderDetail(token, orderNum) {
  const r = await fetch(`${PMS_BASE}/pms/api/v3/order/detail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hotelNum: HOTEL_NUM, orderNum }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  return j.data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { checkIn, checkOut } = req.query;
  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return res.status(400).json({ error: 'checkIn and checkOut required' });
  }

  const debug = req.query.debug === '1';

  try {
    const token = await getPmsToken();

    // Three queries each within PMS 31-day limit
    const pastStart = new Date(checkIn); pastStart.setDate(pastStart.getDate() - 30);
    const futureEnd = new Date(checkIn);  futureEnd.setDate(futureEnd.getDate() + 30);

    const toNum = x => (x && typeof x === 'object') ? (x.orderNum || x.orderNo || x.id || JSON.stringify(x)) : String(x);

    const [pastCiOrders, windowCiOrders, coOrders] = await Promise.all([
      searchOrders(token, pastStart.toISOString().split('T')[0], checkIn,                    2).catch(() => []),
      searchOrders(token, checkIn,                               checkOut,                   2).catch(() => []),
      searchOrders(token, checkIn,                               futureEnd.toISOString().split('T')[0], 3).catch(() => []),
    ]);

    const allOrderNums = [...new Set([...pastCiOrders, ...windowCiOrders, ...coOrders].map(toNum))];
    const details = await Promise.all(allOrderNums.map(n => getOrderDetail(token, n).catch(() => null)));

    const occupiedByType = {};
    const debugRows = [];

    for (const d of details) {
      if (!d) continue;
      for (const info of (d.accomOrderInfos || [])) {
        const roomCi = (info.checkInTime  || '').slice(0, 10);
        const roomCo = (info.checkOutTime || '').slice(0, 10);
        const overlaps = roomCi < checkOut && roomCo > checkIn;
        const typeId = String(info.roomTypeCode || ROOM_TYPE_MAP[info.roomSerialNum] || '');

        if (debug) debugRows.push({
          orderNum: d.orderNum,
          roomSerialNum: info.roomSerialNum,
          roomTypeCode: info.roomTypeCode,
          resolvedTypeId: typeId,
          status: info.status,
          roomCi, roomCo, overlaps,
        });

        if (!overlaps) continue;
        if (info.status !== 40) continue; // only status=40 = confirmed booking
        if (!typeId) continue;
        if (!occupiedByType[typeId]) occupiedByType[typeId] = new Set();
        occupiedByType[typeId].add(info.roomSerialNum || typeId);
      }
    }

    const availability = {};
    for (const [typeId, total] of Object.entries(TYPE_TOTAL)) {
      const occupied = occupiedByType[typeId] ? occupiedByType[typeId].size : 0;
      availability[typeId] = {
        available: occupied < total,
        totalRooms: total,
        occupiedRooms: occupied,
      };
    }

    const payload = { checkIn, checkOut, availability };
    if (debug) {
      payload._debug = {
        allOrderNums_count: allOrderNums.length,
        pastCi: pastCiOrders.length,
        windowCi: windowCiOrders.length,
        co: coOrders.length,
        overlapping: debugRows.filter(r => r.overlaps),
      };
    }
    res.status(200).json(payload);
  } catch (e) {
    res.status(503).json({ error: 'pms_unavailable', message: e.message });
  }
};
