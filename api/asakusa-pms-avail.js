// Vercel Function: PMS-based availability for MKG HOTEL 浅草
// Queries actual PMS bookings to determine per-room-type availability
// GET /api/asakusa-pms-avail?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&adultCount=2

const HOTEL_NUM     = '86177544';
const PMS_CLIENT_ID = '1487118111575543808';
const PMS_SECRET    = 'IYnSyEEnZ5dckZkc437q8DX8HXk6zWsD';
const TOKEN_URL     = 'https://idp.smartorder.ai/realms/smartorder-booking-api/protocol/openid-connect/token';
const PMS_BASE      = 'https://api-open-pms.smartorder.ai';

// Room number → room type ID mapping (physical rooms in this hotel)
const ROOM_TYPE_MAP = {
  '101': '900014417', '201': '900014417', '301': '900014417', '401': '900014417',
  '202': '900014418', '302': '900014418', '402': '900014418',
  '501': '900014419',
  '502': '900014420',
};

// Total physical rooms per type
const TYPE_TOTAL = {
  '900014417': 4,
  '900014418': 3,
  '900014419': 1,
  '900014420': 1,
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

    // PMS API limit: max 31-day span per query
    // Query 1: guests who checked in up to 30 days before our checkIn (long-stay in-house)
    const pastStart = new Date(checkIn); pastStart.setDate(pastStart.getDate() - 30);
    const pastStartStr = pastStart.toISOString().split('T')[0];
    // Query 2: guests checking in during our checkIn→checkOut window
    // Query 3: guests checking out within 30 days from checkIn (catches anyone still here)
    const futureEnd = new Date(checkIn); futureEnd.setDate(futureEnd.getDate() + 30);
    const futureEndStr = futureEnd.toISOString().split('T')[0];

    let searchErrors = [];
    const [pastCiOrders, windowCiOrders, coOrders] = await Promise.all([
      searchOrders(token, pastStartStr, checkIn,     2).catch(e => { searchErrors.push('past: '+e.message); return []; }),
      searchOrders(token, checkIn,      checkOut,    2).catch(e => { searchErrors.push('ci: '+e.message);   return []; }),
      searchOrders(token, checkIn,      futureEndStr,3).catch(e => { searchErrors.push('co: '+e.message);   return []; }),
    ]);
    const ciOrders = [...pastCiOrders, ...windowCiOrders];

    // searchOrders may return order objects or plain order numbers — normalise to strings
    const toNum = x => (x && typeof x === 'object') ? (x.orderNum || x.orderNo || x.id || JSON.stringify(x)) : String(x);
    const allOrderNums = [...new Set([...ciOrders, ...coOrders].map(toNum))];
    const toFetch = allOrderNums.slice(0, 60);
    const details = await Promise.all(toFetch.map(n => getOrderDetail(token, n).catch(() => null)));

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
        occupiedByType[typeId].add(info.roomSerialNum || info.roomTypeCode);
      }
    }

    const availability = {};
    for (const [typeId, total] of Object.entries(TYPE_TOTAL)) {
      const occupied = occupiedByType[typeId] ? occupiedByType[typeId].size : 0;
      availability[typeId] = {
        available: occupied < total,
        totalRooms: total,
        occupiedRooms: occupied,
        freeRooms: total - occupied,
      };
    }

    const payload = { checkIn, checkOut, availability };
    if (debug) {
      payload._debug = {
        pastStartStr, futureEndStr,
        pastCiOrders_count: pastCiOrders.length,
        windowCiOrders_count: windowCiOrders.length,
        coOrders_count: coOrders.length,
        searchErrors,
        allOrderNums,
        rooms: debugRows,
      };
    }
    res.status(200).json(payload);
  } catch (e) {
    res.status(503).json({ error: 'pms_unavailable', message: e.message });
  }
};
