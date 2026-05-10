// Tobacco2026 Inventory Management — Express API server
// 백엔드: Google Sheets API 프록시 + 비즈니스 로직
const express = require('express');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 5000;

// ===== 설정 =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1Bfzg3V3GwprCaBUtZuHREWwdxnwR72nAxBBjQ_ZjrFw';
const SHEET_MASTER = '앱_상품마스터';
const SHEET_SALES = '앱_판매기록';
const SHEET_INOUT = '앱_입출고';
const SHEET_CONFIG = '앱_설정';

// ===== Google 인증 =====
function getAuth() {
  // 1순위: 서비스 계정 JSON (환경변수 또는 파일)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  const credCandidates = [
    path.join(__dirname, '..', 'credentials.json'),
    path.join(__dirname, '..', 'secrets', 'credentials.json'),
    path.join(__dirname, 'credentials.json'),
  ];
  for (const credPath of credCandidates) {
    if (fs.existsSync(credPath)) {
      return new google.auth.GoogleAuth({
        keyFile: credPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    }
  }
  // 2순위: API Key (읽기 전용)
  if (process.env.GOOGLE_API_KEY) {
    return { apiKey: process.env.GOOGLE_API_KEY, readOnly: true };
  }
  return null;
}

async function sheetsClient() {
  const auth = getAuth();
  if (!auth) throw new Error('Google 인증이 설정되지 않았습니다. GOOGLE_SERVICE_ACCOUNT_JSON 환경변수 또는 credentials.json을 설정하세요.');
  if (auth.apiKey) {
    return { sheets: google.sheets({ version: 'v4', auth: auth.apiKey }), readOnly: true };
  }
  const client = await auth.getClient();
  return { sheets: google.sheets({ version: 'v4', auth: client }), readOnly: false };
}

// ===== 캐시 (간단 메모리) =====
const cache = { master: null, masterAt: 0 };
const CACHE_TTL = 60 * 1000; // 1분

async function getMaster(force = false) {
  if (!force && cache.master && Date.now() - cache.masterAt < CACHE_TTL) {
    return cache.master;
  }
  const { sheets } = await sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_MASTER}!A2:L1000`,
  });
  const rows = res.data.values || [];
  const master = rows.filter(r => r[0]).map(r => ({
    id: r[0], name: r[1], maker: r[2],
    barcodeSingle: r[3], barcodeCarton: r[4],
    priceSingle: parseInt(r[5]) || 0,
    priceCarton: parseInt(r[6]) || 0,
    safetyStockCarton: parseInt(r[7]) || 1,
    discontinued: r[8] === 'Y',
    note: r[9] || '',
    initialSingle: parseInt(r[10]) || 0,
    initialCarton: parseInt(r[11]) || 0,
  }));
  cache.master = master;
  cache.masterAt = Date.now();
  return master;
}

async function getSalesAll() {
  const { sheets } = await sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_SALES}!A2:I10000`,
  });
  return (res.data.values || []).filter(r => r[0]).map(r => ({
    datetime: r[0], productId: r[1], name: r[2], unit: r[3],
    qty: parseInt(r[4]) || 0,
    unitPrice: parseInt(r[5]) || 0,
    amount: parseInt(r[6]) || 0,
    memo: r[7] || '', source: r[8] || '',
  }));
}

async function getInoutAll() {
  const { sheets } = await sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INOUT}!A2:G10000`,
  });
  return (res.data.values || []).filter(r => r[0]).map(r => ({
    datetime: r[0], productId: r[1], name: r[2], type: r[3],
    unit: r[4], qty: parseInt(r[5]) || 0, memo: r[6] || '',
  }));
}

// 현재고 계산: 기초 + 입고 - 출고(판매) — 보루 단위로 환산
async function getStockSummary() {
  const [master, sales, inout] = await Promise.all([getMaster(), getSalesAll(), getInoutAll()]);
  const BORU = 10;
  const map = {};
  for (const m of master) {
    map[m.id] = {
      ...m,
      // 단일 단위 기준으로 통합 계산 (보루*10 + 단일)
      stockUnits: m.initialCarton * BORU + m.initialSingle,
      sold: 0, in: 0, adj: 0,
    };
  }
  for (const s of sales) {
    if (!map[s.productId]) continue;
    const units = s.unit === '보루' ? s.qty * BORU : s.qty;
    map[s.productId].stockUnits -= units;
    map[s.productId].sold += units;
  }
  for (const i of inout) {
    if (!map[i.productId]) continue;
    const units = i.unit === '보루' ? i.qty * BORU : i.qty;
    if (i.type === '입고') { map[i.productId].stockUnits += units; map[i.productId].in += units; }
    else if (i.type === '반품' || i.type === '출고조정') { map[i.productId].stockUnits -= units; map[i.productId].adj -= units; }
    else if (i.type === '재고조정') { map[i.productId].stockUnits += units; map[i.productId].adj += units; }
  }
  return Object.values(map).map(p => {
    const carton = Math.floor(p.stockUnits / BORU);
    const single = p.stockUnits - carton * BORU;
    const lowStock = carton < (p.safetyStockCarton || 1);
    return {
      id: p.id, name: p.name, maker: p.maker,
      barcodeSingle: p.barcodeSingle, barcodeCarton: p.barcodeCarton,
      priceSingle: p.priceSingle, priceCarton: p.priceCarton,
      safetyStockCarton: p.safetyStockCarton,
      discontinued: p.discontinued, note: p.note,
      stockSingle: single, stockCarton: carton, stockUnits: p.stockUnits,
      lowStock, sold: p.sold, inQty: p.in, adj: p.adj,
    };
  });
}

// ===== Routes =====
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  const auth = getAuth();
  res.json({
    ok: true,
    spreadsheetId: SPREADSHEET_ID,
    auth: auth ? (auth.apiKey ? 'apikey(read-only)' : 'service-account') : 'none',
    time: new Date().toISOString(),
  });
});

app.get('/api/products', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const master = await getMaster(force);
    res.json(master);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 신규 상품 등록
app.post('/api/products', async (req, res) => {
  try {
    const { sheets, readOnly } = await sheetsClient();
    if (readOnly) return res.status(403).json({ error: 'read-only mode' });
    const b = req.body || {};
    const name = (b.name||'').trim();
    if (!name) return res.status(400).json({ error: '상품명 필수' });
    const master = await getMaster(true);
    const nameKey = name.toLowerCase();
    if (master.find(m => (m.name||'').toLowerCase() === nameKey)) {
      return res.status(409).json({ error: '같은 이름의 상품이 이미 있습니다: ' + name });
    }
    // 상품ID 자동 생성: P + 3자리 (기존 최대 + 1)
    let id = (b.id||'').trim();
    if (!id) {
      let maxN = 0;
      master.forEach(m => { const mt = /^P(\d+)$/i.exec(m.id||''); if (mt) maxN = Math.max(maxN, parseInt(mt[1])); });
      id = 'P' + String(maxN + 1).padStart(3, '0');
    } else if (master.find(m => (m.id||'').toLowerCase() === id.toLowerCase())) {
      return res.status(409).json({ error: '같은 상품ID가 이미 있습니다: ' + id });
    }
    // 바코드 중복 체크
    const bcS = (b.barcodeSingle||'').trim();
    const bcC = (b.barcodeCarton||'').trim();
    if (bcS && master.find(m => m.barcodeSingle === bcS || m.barcodeCarton === bcS)) {
      return res.status(409).json({ error: '낱개 바코드가 이미 사용 중: ' + bcS });
    }
    if (bcC && master.find(m => m.barcodeSingle === bcC || m.barcodeCarton === bcC)) {
      return res.status(409).json({ error: '보루 바코드가 이미 사용 중: ' + bcC });
    }
    const row = [
      id, name, (b.maker||'').trim(),
      bcS, bcC,
      parseInt(b.priceSingle) || 0,
      parseInt(b.priceCarton) || 0,
      parseInt(b.safetyStockCarton) || 1,
      b.discontinued === true || b.discontinued === 'Y' ? 'Y' : '',
      (b.note||'').trim(),
      parseInt(b.initialSingle) || 0,
      parseInt(b.initialCarton) || 0,
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_MASTER}!A:L`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
    cache.master = null; // invalidate
    res.json({ ok: true, id, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 기존 상품 수정 (이름/제조사/가격/바코드/안전재고/메모/단종)
app.patch('/api/products/:id', async (req, res) => {
  try {
    const { sheets, readOnly } = await sheetsClient();
    if (readOnly) return res.status(403).json({ error: 'read-only mode' });
    const id = (req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: '상품ID 필수' });
    const b = req.body || {};
    // 현재 시트의 상품 마스터를 읽어서 해당 행을 찾음
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_MASTER}!A2:L1000`,
    });
    const rows = masterRes.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][0] || '').trim() === id) { rowIndex = i; break; }
    }
    if (rowIndex < 0) return res.status(404).json({ error: '상품을 찾을 수 없음: ' + id });
    const cur = rows[rowIndex];
    const name = (b.name !== undefined ? String(b.name) : cur[1] || '').trim();
    if (!name) return res.status(400).json({ error: '상품명 필수' });
    // 편집 시에는 이름 중복을 검사하지 않음 — 기존 시트에 중복이 있거나,
    // 사용자가 의도적으로 같은 이름을 쓰는 경우(철자 수정 등)도 허용
    const bcS = (b.barcodeSingle !== undefined ? String(b.barcodeSingle) : cur[3] || '').trim();
    const bcC = (b.barcodeCarton !== undefined ? String(b.barcodeCarton) : cur[4] || '').trim();
    // 바코드 중복 체크 (다른 행에)
    for (let i = 0; i < rows.length; i++) {
      if (i === rowIndex) continue;
      const otherS = (rows[i][3] || '').trim();
      const otherC = (rows[i][4] || '').trim();
      if (bcS && (otherS === bcS || otherC === bcS)) {
        return res.status(409).json({ error: '낱개 바코드 중복: ' + bcS });
      }
      if (bcC && (otherS === bcC || otherC === bcC)) {
        return res.status(409).json({ error: '보루 바코드 중복: ' + bcC });
      }
    }
    const newRow = [
      id,
      name,
      (b.maker !== undefined ? String(b.maker) : cur[2] || '').trim(),
      bcS,
      bcC,
      b.priceSingle !== undefined ? (parseInt(b.priceSingle) || 0) : (parseInt(cur[5]) || 0),
      b.priceCarton !== undefined ? (parseInt(b.priceCarton) || 0) : (parseInt(cur[6]) || 0),
      b.safetyStockCarton !== undefined ? (parseInt(b.safetyStockCarton) || 0) : (parseInt(cur[7]) || 1),
      b.discontinued !== undefined ? (b.discontinued === true || b.discontinued === 'Y' ? 'Y' : '') : (cur[8] || ''),
      (b.note !== undefined ? String(b.note) : cur[9] || '').trim(),
      // 초기재고는 따로 건드리지 않음 (생성 시점의 값 유지)
      cur[10] !== undefined ? cur[10] : 0,
      cur[11] !== undefined ? cur[11] : 0,
    ];
    // 시트 내 실제 행 번호 = rowIndex + 2 (헤더 행 1개 포함)
    const sheetRow = rowIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_MASTER}!A${sheetRow}:L${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [newRow] },
    });
    cache.master = null;
    res.json({ ok: true, id, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/lookup', async (req, res) => {
  try {
    const q = (req.query.barcode || '').trim();
    if (!q) return res.status(400).json({ error: 'barcode required' });
    const master = await getMaster();
    const found = master.find(p => p.barcodeSingle === q || p.barcodeCarton === q);
    if (!found) return res.status(404).json({ error: 'not found', barcode: q });
    const unit = found.barcodeSingle === q ? '단일' : '보루';
    res.json({ ...found, matchedUnit: unit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stock', async (req, res) => {
  try { res.json(await getStockSummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sales', async (req, res) => {
  try {
    const { sheets, readOnly } = await sheetsClient();
    if (readOnly) return res.status(403).json({ error: 'read-only mode (서비스 계정 필요)' });
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const master = await getMaster();
    const masterMap = Object.fromEntries(master.map(m => [m.id, m]));
    const now = new Date();
    const tz = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = [];
    for (const it of items) {
      const m = masterMap[it.productId];
      if (!m) return res.status(400).json({ error: `상품ID 없음: ${it.productId}` });
      const unit = it.unit === '보루' ? '보루' : '단일';
      const qty = parseInt(it.qty) || 0;
      if (qty <= 0) return res.status(400).json({ error: '수량은 1 이상' });
      const unitPrice = unit === '보루' ? m.priceCarton : m.priceSingle;
      const amount = unitPrice * qty;
      rows.push([
        it.datetime || tz(now),
        m.id, m.name, unit, qty, unitPrice, amount,
        it.memo || '', it.source || 'web',
      ]);
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_SALES}!A:I`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });

    // ===== 갑 자동 보충 로직 =====
    // 판매 후 갑(stockSingle)이 0 이하가 된 상품에 대해, 보루>0이면
    // 자동으로 -1 보루 / +10 갑 환산 기록을 앱_입출고에 추가
    let autoConvertCount = 0;
    try {
      const stock = await getStockSummary();
      const affectedIds = new Set(items.map(it => it.productId));
      const ts = tz(now);
      const autoRows = [];
      for (const s of stock) {
        if (!affectedIds.has(s.id)) continue;
        let single = s.stockSingle;
        let carton = s.stockCarton;
        // 음수 갑 + 보루 보유 시 풀어주기 (반복: 갑이 0 미만이면 계속)
        let safety = 0;
        while (single <= 0 && carton > 0 && safety < 100) {
          autoRows.push([ts, s.id, s.name, '재고조정', '보루', -1, '[자동환산] 갑 부족분 자동변환']);
          autoRows.push([ts, s.id, s.name, '재고조정', '단일', 10,  '[자동환산] 보루 1개 풀어 갑 +10']);
          carton -= 1; single += 10;
          safety++; autoConvertCount++;
        }
      }
      if (autoRows.length) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_INOUT}!A:G`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: autoRows },
        });
      }
    } catch (autoErr) {
      console.error('자동 환산 처리 오류:', autoErr.message);
    }

    res.json({ ok: true, count: rows.length, autoConvert: autoConvertCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inout', async (req, res) => {
  try {
    const { sheets, readOnly } = await sheetsClient();
    if (readOnly) return res.status(403).json({ error: 'read-only mode' });
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const master = await getMaster();
    const masterMap = Object.fromEntries(master.map(m => [m.id, m]));
    const now = new Date();
    const tz = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = [];
    for (const it of items) {
      const m = masterMap[it.productId];
      if (!m) return res.status(400).json({ error: `상품ID 없음: ${it.productId}` });
      const type = it.type || '입고';
      const unit = it.unit === '보루' ? '보루' : '단일';
      const qty = parseInt(it.qty) || 0;
      rows.push([it.datetime || tz(now), m.id, m.name, type, unit, qty, it.memo || '']);
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_INOUT}!A:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
    res.json({ ok: true, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sales', async (req, res) => {
  try {
    const all = await getSalesAll();
    const { from, to, productId } = req.query;
    let out = all;
    if (from) out = out.filter(s => s.datetime >= from);
    if (to) out = out.filter(s => s.datetime <= to + ' 23:59:59');
    if (productId) out = out.filter(s => s.productId === productId);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inout', async (req, res) => {
  try { res.json(await getInoutAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 일/주/월 매출 요약
app.get('/api/dashboard', async (req, res) => {
  try {
    const sales = await getSalesAll();
    const today = new Date(); today.setHours(0,0,0,0);
    const tzShift = (d) => new Date(d.getTime() + 9*3600*1000);
    const todayKr = tzShift(new Date()).toISOString().slice(0,10);
    const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const fmt = d => d.toISOString().slice(0,10);
    const todayKey = todayKr;
    const weekKey = fmt(weekAgo);
    const monthKey = fmt(monthStart);

    let dToday=0, dWeek=0, dMonth=0;
    let cToday=0, cWeek=0, cMonth=0;
    const productAgg = {};
    for (const s of sales) {
      const day = s.datetime.slice(0,10);
      if (day === todayKey) { dToday += s.amount; cToday += s.qty; }
      if (day >= weekKey)   { dWeek  += s.amount; cWeek  += s.qty; }
      if (day >= monthKey)  { dMonth += s.amount; cMonth += s.qty; }
      if (!productAgg[s.productId]) productAgg[s.productId] = { id: s.productId, name: s.name, qtyUnits: 0, amount: 0 };
      productAgg[s.productId].qtyUnits += (s.unit === '보루' ? s.qty * 10 : s.qty);
      productAgg[s.productId].amount += s.amount;
    }
    const top = Object.values(productAgg).sort((a,b)=>b.qtyUnits-a.qtyUnits).slice(0, 10);

    // 최근 14일 일별
    const dailyMap = {};
    for (let i=13; i>=0; i--) { const d=new Date(today); d.setDate(d.getDate()-i); dailyMap[fmt(d)]={date:fmt(d), amount:0, qty:0}; }
    for (const s of sales) { const day=s.datetime.slice(0,10); if (dailyMap[day]) { dailyMap[day].amount+=s.amount; dailyMap[day].qty+=s.qty; } }

    res.json({
      today: { amount: dToday, qty: cToday },
      week: { amount: dWeek, qty: cWeek },
      month: { amount: dMonth, qty: cMonth },
      topProducts: top,
      daily: Object.values(dailyMap),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV 일괄 업로드
app.post('/api/sales/bulk-csv', async (req, res) => {
  try {
    const { csv, source } = req.body;
    if (!csv) return res.status(400).json({ error: 'csv required' });
    const lines = csv.split(/\r?\n/).filter(l => l.trim());
    const header = lines[0].split(',').map(s => s.trim());
    // 기대 컬럼: 일시(또는 일자), 바코드, 단위(단일/보루), 수량, [메모]
    const idx = (k) => header.findIndex(h => h === k);
    const iDate = idx('일시') >= 0 ? idx('일시') : idx('일자');
    const iBarcode = idx('바코드');
    const iUnit = idx('단위');
    const iQty = idx('수량');
    const iMemo = idx('메모');
    if (iBarcode<0 || iQty<0) return res.status(400).json({ error: '헤더에 바코드, 수량 필수' });
    const master = await getMaster();
    const byBarcode = {};
    for (const m of master) {
      if (m.barcodeSingle) byBarcode[m.barcodeSingle] = { m, unit: '단일' };
      if (m.barcodeCarton) byBarcode[m.barcodeCarton] = { m, unit: '보루' };
    }
    const items = []; const errors = [];
    for (let i=1; i<lines.length; i++) {
      const cols = lines[i].split(',').map(s => s.trim());
      const barcode = cols[iBarcode];
      const found = byBarcode[barcode];
      if (!found) { errors.push({ line: i+1, barcode, error: '상품 없음' }); continue; }
      const unit = (iUnit>=0 && cols[iUnit]) ? cols[iUnit] : found.unit;
      const qty = parseInt(cols[iQty]) || 0;
      if (qty <= 0) { errors.push({ line: i+1, error: '수량 0' }); continue; }
      items.push({
        datetime: iDate>=0 ? cols[iDate] : undefined,
        productId: found.m.id, unit, qty,
        memo: iMemo>=0 ? cols[iMemo] : '',
        source: source || 'csv',
      });
    }
    if (items.length === 0) return res.json({ ok: true, count: 0, errors });
    // POST /api/sales 로직 재사용
    req.body = items;
    return app._router.handle({ ...req, url: '/api/sales', method: 'POST' }, res, () => {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// 판매/입출고 취소 — 반대 기록을 추가 (원본 보존)
app.post('/api/cancel', async (req, res) => {
  try {
    const { sheets, readOnly } = await sheetsClient();
    if (readOnly) return res.status(403).json({ error: 'read-only mode' });
    const b = req.body || {};
    const kind = b.kind; // 'sale' | 'io'
    const productId = b.productId;
    if (!productId || !kind) return res.status(400).json({ error: 'kind, productId 필수' });
    const master = await getMaster();
    const m = master.find(x => x.id === productId);
    if (!m) return res.status(404).json({ error: '상품ID 없음: ' + productId });
    const now = new Date();
    const tz = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const ts = tz(now);
    const unit = b.unit === '보루' ? '보루' : '단일';
    const qty = parseInt(b.qty) || 0;
    const ref = b.datetime ? `[취소] 원본 ${b.datetime}` : '[취소]';
    if (kind === 'sale') {
      // 판매 취소: 반대 부호 판매기록 (수량 음수 + 금액 음수)
      const unitPrice = unit === '보루' ? m.priceCarton : m.priceSingle;
      const row = [ts, m.id, m.name, unit, -qty, unitPrice, -unitPrice * qty, ref, 'cancel'];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_SALES}!A:I`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });
    } else if (kind === 'io') {
      // 입출고 취소: 반대 부호 수량으로 같은 type 기록
      const type = b.type || '입고';
      const row = [ts, m.id, m.name, type, unit, -qty, ref + (b.memo?(' · '+b.memo):'')];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_INOUT}!A:G`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });
    } else {
      return res.status(400).json({ error: 'kind는 sale 또는 io' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tobacco2026 server listening on :${PORT}`);
  console.log(`Spreadsheet: ${SPREADSHEET_ID}`);
  const auth = getAuth();
  console.log(`Auth: ${auth ? (auth.apiKey ? 'apikey(read-only)' : 'service-account') : 'NONE — set GOOGLE_SERVICE_ACCOUNT_JSON or place credentials.json'}`);
});
