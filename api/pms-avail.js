// Unified PMS availability for all MKG properties
// GET /api/pms-avail?hotel=asakusa|shiba|shinjuku&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD

const PMS_BASE  = 'https://api-open-pms.smartorder.ai';
const TOKEN_URL = 'https://idp.smartorder.ai/realms/smartorder-booking-api/protocol/openid-connect/token';

const HOTELS = {
  asakusa: {
    hotelNum:  '86177544',
    clientId:  '1487118111575543808',
    secret:    'IYnSyEEnZ5dckZkc437q8DX8HXk6zWsD',
    roomTypeMap: {
      '101':'900014417','201':'900014417','301':'900014417','401':'900014417',
      '202':'900014418','302':'900014418','402':'900014418',
      '501':'900014419',
      '502':'900014420',
    },
    typeTotal: { '900014417':4, '900014418':3, '900014419':1, '900014420':1 },
  },
  shiba: {
    hotelNum:  '30958695',
    clientId:  '1513859491169472512',
    secret:    'UJKaBl2TYGngV8DQMSCv2Gx6UZtYYcYh',
    roomTypeMap: {
      '101':'900014422','102':'900014421','201':'900014423',
      '202':'900014424','301':'900014425','401':'900014426',
    },
    typeTotal: {
      '900014422':1,'900014421':1,'900014423':1,
      '900014424':1,'900014425':1,'900014426':1,
    },
  },
  shinjuku: {
    hotelNum:  '51401486',
    clientId:  '1513859491169472512',
    secret:    'UJKaBl2TYGngV8DQMSCv2Gx6UZtYYcYh',
    roomTypeMap: { '7F':'905007308' },
    typeTotal:  { '905007308':1 },
  },
};

const _tokens = {};

async function getToken(clientId, secret) {
  const t = _tokens[clientId];
  if (t && Date.now() < t.expiry) return t.token;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }).toString(),
  });
  const j = await r.json();
  _tokens[clientId] = { token: j.access_token, expiry: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

async function searchOrders(token, hotelNum, beginDate, endDate, dateType) {
  const r = await fetch(`${PMS_BASE}/pms/api/v3/order/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hotelNum, beginDate, endDate, dateType, pageNum: 1, pageSize: 200 }),
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json();
  return (j.data && j.data.list) ? j.data.list : [];
}

async function getOrderDetail(token, hotelNum, orderNum) {
  const r = await fetch(`${PMS_BASE}/pms/api/v3/order/detail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hotelNum, orderNum }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  return j.data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { hotel, checkIn, checkOut } = req.query;
  if (!hotel || !HOTELS[hotel]) {
    return res.status(400).json({ error: 'hotel must be asakusa, shiba, or shinjuku' });
  }
  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return res.status(400).json({ error: 'checkIn and checkOut required' });
  }

  const { hotelNum, clientId, secret, roomTypeMap, typeTotal } = HOTELS[hotel];
  const debug = req.query.debug === '1';

  try {
    const token = await getToken(clientId, secret);
    const toNum = x => (x && typeof x === 'object') ? (x.orderNum || x.orderNo || x.id || JSON.stringify(x)) : String(x);

    const pastStart = new Date(checkIn); pastStart.setDate(pastStart.getDate() - 30);
    const futureEnd = new Date(checkIn);  futureEnd.setDate(futureEnd.getDate() + 30);

    const [pastCiOrders, windowCiOrders, coOrders] = await Promise.all([
      searchOrders(token, hotelNum, pastStart.toISOString().split('T')[0], checkIn,  2).catch(() => []),
      searchOrders(token, hotelNum, checkIn, checkOut,                               2).catch(() => []),
      searchOrders(token, hotelNum, checkIn, futureEnd.toISOString().split('T')[0],  3).catch(() => []),
    ]);

    const allOrderNums = [...new Set([...pastCiOrders, ...windowCiOrders, ...coOrders].map(toNum))];
    const details = await Promise.all(allOrderNums.map(n => getOrderDetail(token, hotelNum, n).catch(() => null)));

    const occupiedByType = {};
    const debugRows = [];

    for (const d of details) {
      if (!d) continue;
      for (const info of (d.accomOrderInfos || [])) {
        const roomCi = (info.checkInTime  || '').slice(0, 10);
        const roomCo = (info.checkOutTime || '').slice(0, 10);
        const overlaps = roomCi < checkOut && roomCo > checkIn;
        const typeId = String(info.roomTypeCode || roomTypeMap[info.roomSerialNum] || '');

        if (debug) debugRows.push({
          orderNum: d.orderNum, roomSerialNum: info.roomSerialNum,
          roomTypeCode: info.roomTypeCode, resolvedTypeId: typeId,
          status: info.status, roomCi, roomCo, overlaps,
        });

        if (!overlaps) continue;
        if (info.status !== 40) continue;
        if (!typeId) continue;
        if (!occupiedByType[typeId]) occupiedByType[typeId] = new Set();
        occupiedByType[typeId].add(info.roomSerialNum || typeId);
      }
    }

    const availability = {};
    for (const [typeId, total] of Object.entries(typeTotal)) {
      const occupied = occupiedByType[typeId] ? occupiedByType[typeId].size : 0;
      availability[typeId] = { available: occupied < total, totalRooms: total, occupiedRooms: occupied, freeRooms: total - occupied };
    }

    const payload = { hotel, checkIn, checkOut, availability };
    if (debug) payload._debug = {
      allOrderNums_count: allOrderNums.length,
      pastCi: pastCiOrders.length, windowCi: windowCiOrders.length, co: coOrders.length,
      overlapping: debugRows.filter(r => r.overlaps),
    };
    res.status(200).json(payload);
  } catch (e) {
    res.status(503).json({ error: 'pms_unavailable', message: e.message });
  }
};
