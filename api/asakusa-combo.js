// Combo booking search for 浅草酒店 (MKG Hotel Asakusa)
// GET /api/asakusa-combo?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&adultCount=2
//
// 规则：
//   - 最多 1 次换房（也就是 2 段）
//   - 允许跨房型
//   - 每段价格取 SmartOrder DIRECT rate；合计后再打 3% 折
//   - 返回按 折后合计价 升序的 Top 方案（默认 10 个）
//
// 只在客人搜索的日期段没有单一房型能完整入住（type-level 全部 sold_out）时才有意义调用；
// 前端会在 no-avail 时主动 fetch 这个接口。

const HOTEL_ID      = '86177544';
const CLIENT_ID     = process.env.SMARTORDER_CLIENT_ID     || '1513859491169472512';
const CLIENT_SECRET = process.env.SMARTORDER_CLIENT_SECRET || 'UJKaBl2TYGngV8DQMSCv2Gx6UZtYYcYh';
const TOKEN_URL     = 'https://idp.smartorder.ai/realms/smartorder-booking-api/protocol/openid-connect/token';
const BASE_URL      = 'https://api-open-booking.smartorder.ai';
const DIRECT_RATE   = '1126061761074001';
const DISCOUNT_PCT  = 0.03;   // 3% 直订组合折扣

// 浅草房号 → 房型ID / 名称 / 容量 —— 与 pms-avail.js / hotel-asakusa.html 保持一致
const ROOM_MAP = {
  '101':'900014417','201':'900014417','301':'900014417','401':'900014417',
  '202':'900014418','302':'900014418','402':'900014418',
  '501':'900014419',
  '502':'900014420',
};
const TYPE_INFO = {
  '900014417': { zh:'舒适三人间', en:'Comfortable Triple', ja:'コンフォートトリプル', maxGuest: 3 },
  '900014418': { zh:'高级家庭房', en:'Superior Family Room', ja:'スーペリアファミリールーム', maxGuest: 4 },
  '900014419': { zh:'豪华小型套房', en:'Deluxe Compact Suite', ja:'デラックスコンパクトスイート', maxGuest: 3 },
  '900014420': { zh:'豪华套房', en:'Deluxe Suite', ja:'デラックススイート', maxGuest: 4 },
};

let _tokenCache = { token: null, expiry: 0 };
async function getToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiry) return _tokenCache.token;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
  });
  const j = await r.json();
  _tokenCache = { token: j.access_token, expiry: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

// 返回所有日期字符串（每晚），[ci, co) 半开
function nightsBetween(ci, co) {
  const out = [];
  const d = new Date(ci);
  const end = new Date(co);
  while (d < end) { out.push(d.toISOString().split('T')[0]); d.setDate(d.getDate()+1); }
  return out;
}

// 一段是否可以入住某个房间：该房间在 [segCi, segCo) 每一晚都必须空
function roomIsFreeForSegment(roomOccNights, segCi, segCo) {
  const occSet = new Set(roomOccNights);
  for (const n of nightsBetween(segCi, segCo)) {
    if (occSet.has(n)) return false;
  }
  return true;
}

// 调 SmartOrder avail 拿指定 roomTypeId 在 [ci, co) 的 DIRECT rate 总价；找不到 DIRECT 就取最低价
async function getSegmentPrice(token, roomTypeId, ci, co, adultCount) {
  const qs = new URLSearchParams({ checkIn: ci, checkOut: co, adultCount: String(adultCount), roomTypeId });
  const r = await fetch(`${BASE_URL}/booking/api/v3/avail/${HOTEL_ID}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  const rates = ((j.data && j.data.roomRates) || []).filter(x => String(x.roomId) === String(roomTypeId));
  if (rates.length === 0) return null;
  const direct = rates.find(x => x.rateId === DIRECT_RATE);
  const chosen = direct || rates.sort((a,b) => a.totalAmount - b.totalAmount)[0];
  return { rateId: chosen.rateId, totalAmount: chosen.totalAmount, averageDailyAmount: chosen.averageDailyAmount, nights: chosen.nights };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { checkIn, checkOut, adultCount = '2' } = req.query;
  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return res.status(400).json({ error: 'checkIn and checkOut required' });
  }
  const guests = parseInt(adultCount) || 2;
  const nights = nightsBetween(checkIn, checkOut).length;
  if (nights < 2) {
    // 单晚不需要换房
    return res.status(200).json({ combos: [], reason: 'need_at_least_2_nights' });
  }

  try {
    const [pmsRes, token] = await Promise.all([
      fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/pms-avail?hotel=asakusa&checkIn=${checkIn}&checkOut=${checkOut}&perroom=1`).then(r => r.json()),
      getToken(),
    ]);

    const perRoom = pmsRes.perRoom || {};
    if (!Object.keys(perRoom).length) {
      return res.status(503).json({ error: 'pms_unavailable' });
    }

    // 1. 枚举中转日 mid ∈ (checkIn, checkOut)
    const nightList = nightsBetween(checkIn, checkOut);
    const midDays = [];
    for (let i = 1; i < nightList.length; i++) {
      const d = new Date(nightList[i]);
      midDays.push(d.toISOString().split('T')[0]);
    }

    // 2. 每个 mid 都遍历 (roomA in seg1) × (roomB in seg2) 找可行组合
    //    去重：同房型内选最"顺"的一间（避免 101/201/301/401 全组合导致N倍方案）
    const combos = [];
    const roomIds = Object.keys(perRoom);

    for (const mid of midDays) {
      // 段1: [checkIn, mid) 可入住的房间集合
      const seg1Rooms = roomIds.filter(rsn => roomIsFreeForSegment(perRoom[rsn].occupiedNights, checkIn, mid));
      // 段2: [mid, checkOut) 可入住的房间集合
      const seg2Rooms = roomIds.filter(rsn => roomIsFreeForSegment(perRoom[rsn].occupiedNights, mid, checkOut));

      // 按 roomType 去重（每个房型选一间即可，方案里对客人来说房型才是重点）
      const seg1ByType = {};
      for (const r of seg1Rooms) {
        const t = perRoom[r].typeId;
        if (!seg1ByType[t]) seg1ByType[t] = r;
      }
      const seg2ByType = {};
      for (const r of seg2Rooms) {
        const t = perRoom[r].typeId;
        if (!seg2ByType[t]) seg2ByType[t] = r;
      }

      for (const t1 of Object.keys(seg1ByType)) {
        for (const t2 of Object.keys(seg2ByType)) {
          const room1 = seg1ByType[t1];
          const room2 = seg2ByType[t2];
          // 避免"两段同房间同房型"这种伪组合（那其实是整段单房，不需要换房）
          if (t1 === t2 && room1 === room2) continue;
          // 容纳人数不够则跳过
          if (TYPE_INFO[t1] && TYPE_INFO[t1].maxGuest < guests) continue;
          if (TYPE_INFO[t2] && TYPE_INFO[t2].maxGuest < guests) continue;
          combos.push({ mid, t1, t2, room1, room2 });
        }
      }
    }

    if (combos.length === 0) {
      return res.status(200).json({ combos: [], reason: 'no_feasible_combo' });
    }

    // 3. 批量调 SmartOrder avail 拿每段价格 —— 用缓存避免同段重复请求
    const priceCache = {};
    async function priceOf(typeId, ci, co) {
      const k = `${typeId}|${ci}|${co}`;
      if (priceCache[k] !== undefined) return priceCache[k];
      const p = await getSegmentPrice(token, typeId, ci, co, guests).catch(() => null);
      priceCache[k] = p;
      return p;
    }

    const enriched = [];
    for (const c of combos) {
      const [p1, p2] = await Promise.all([
        priceOf(c.t1, checkIn, c.mid),
        priceOf(c.t2, c.mid, checkOut),
      ]);
      if (!p1 || !p2) continue;
      const gross = p1.totalAmount + p2.totalAmount;
      const discount = Math.round(gross * DISCOUNT_PCT);
      const net = gross - discount;
      enriched.push({
        segments: [
          { checkIn, checkOut: c.mid, roomTypeId: c.t1, roomSerialNum: c.room1, nights: p1.nights, totalAmount: p1.totalAmount, averageDailyAmount: p1.averageDailyAmount, rateId: p1.rateId, roomName: TYPE_INFO[c.t1] },
          { checkIn: c.mid, checkOut, roomTypeId: c.t2, roomSerialNum: c.room2, nights: p2.nights, totalAmount: p2.totalAmount, averageDailyAmount: p2.averageDailyAmount, rateId: p2.rateId, roomName: TYPE_INFO[c.t2] },
        ],
        crossType: c.t1 !== c.t2,
        grossTotal: gross,
        discountPct: DISCOUNT_PCT,
        discountAmount: discount,
        netTotal: net,
        currencyCode: 'JPY',
      });
    }

    // 4. 排序：折后合计价升序；返回 Top 8
    enriched.sort((a, b) => a.netTotal - b.netTotal);
    res.status(200).json({
      checkIn, checkOut, adultCount: guests, nights,
      count: enriched.length,
      combos: enriched.slice(0, 8),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
