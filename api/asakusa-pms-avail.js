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
    signal: AbortSignal.timeout(8000),
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

  try {
    const token = await getPmsToken();

    // Find all orders overlapping [checkIn, checkOut):
    // 1) Orders checking IN before our checkOut (and presumably checking out after our checkIn)
    // 2) Query past 90 days up to checkOut for check-in, plus filter by checkOut > checkIn
    const ciOrders  = await searchOrders(token, checkIn, checkOut, 2);  // checking in during our window
    const coOrders  = await searchOrders(token, checkIn, checkOut, 3);  // checking out during our window

    // Also catch long-stay guests who checked in before our checkIn
    const pastStart = new Date(checkIn);
    pastStart.setDate(pastStart.getDate() - 90);
    const pastOrders = await searchOrders(token, pastStart.toISOString().split('T')[0], checkIn, 2);

    const allOrderNums = [...new Set([...ciOrders, ...coOrders, ...pastOrders])];

    // Fetch details in parallel (cap at 30 to avoid timeout)
    const toFetch = allOrderNums.slice(0, 30);
    const details = await Promise.all(toFetch.map(n => getOrderDetail(token, n).catch(() => null)));

    // Count occupied rooms per type for the requested period
    const occupiedByType = {}; // typeId → Set of room numbers

    for (const d of details) {
      if (!d) continue;
      for (const info of (d.accomOrderInfos || [])) {
        if (info.status === 40) continue; // cancelled
        const roomCi = (info.checkInTime || '').slice(0, 10);
        const roomCo = (info.checkOutTime || '').slice(0, 10);
        // Overlaps our period: roomCi < checkOut AND roomCo > checkIn
        if (roomCi < checkOut && roomCo > checkIn) {
          const typeId = String(info.roomTypeCode || ROOM_TYPE_MAP[info.roomSerialNum] || '');
          if (typeId) {
            if (!occupiedByType[typeId]) occupiedByType[typeId] = new Set();
            occupiedByType[typeId].add(info.roomSerialNum);
          }
        }
      }
    }

    // Build availability result
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

    res.status(200).json({ checkIn, checkOut, availability });
  } catch (e) {
    res.status(503).json({ error: 'pms_unavailable', message: e.message });
  }
};
