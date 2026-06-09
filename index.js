require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const { google } = require('googleapis');

// ============================================
// CONFIG
// ============================================
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MEXC_API_KEY     = process.env.MEXC_API_KEY;
const MEXC_API_SECRET  = process.env.MEXC_API_SECRET;
const SHEET_ID         = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDS     = process.env.GOOGLE_CREDENTIALS;

const TRADE_SIZE     = parseFloat(process.env.TRADE_SIZE || '5');
const LEVERAGE       = parseInt(process.env.LEVERAGE || '3');
const SCORE_MIN      = parseInt(process.env.SCORE_MIN || '90');
const MAX_POSITIONS  = parseInt(process.env.MAX_POSITIONS || '4');

const MEXC_BASE = 'https://contract.mexc.com';

// ============================================
// ESTADO EN MEMORIA
// ============================================
let openPositions = {};
let botActive = true;

// ============================================
// MEXC API
// ============================================
function mexcSign(params, method = 'POST') {
  const ts = Date.now().toString();
  const queryString = method === 'GET'
    ? Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')
    : JSON.stringify(params);
  const toSign = MEXC_API_KEY + ts + queryString;
  const sig = crypto.createHmac('sha256', MEXC_API_SECRET).update(toSign).digest('hex');
  return { ts, sig };
}
async function mexcRequest(method, path, params = {}) {
  const { ts, sig } = mexcSign(params, method);
  const headers = {
    'ApiKey': MEXC_API_KEY,
    'Request-Time': ts,
    'Signature': sig,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://futures.mexc.com',
    'Referer': 'https://futures.mexc.com/'
  };
  try {
    const url = MEXC_BASE + path;
    const res = method === 'GET'
      ? await axios.get(url, { headers, params })
      : await axios.post(url, JSON.stringify(params), { headers });
    return res.data;
  } catch (e) {
    console.error(`MEXC error [${method} ${path}]:`, JSON.stringify(e.response?.data) || e.message);
    console.error(`MEXC status:`, e.response?.status);
    console.error(`MEXC headers sent:`, JSON.stringify(e.config?.headers));
    return null;
  }
}

async function setLeverage(symbol, leverage) {
  return mexcRequest('POST', '/api/v1/private/position/change_leverage', {
    symbol,
    leverage: parseInt(leverage),
    positionType: 1,
    openType: 1
  });
}

async function openShort(symbol, contracts) {
  return mexcRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    price: 0,
    vol: contracts,
    side: 3,
    type: 5,
    openType: 2
  });
}

async function placeStopLoss(symbol, contracts, slPrice) {
  return mexcRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    price: slPrice,
    vol: contracts,
    side: 4,
    type: 3,
    openType: 1,
    stopLossPrice: slPrice
  });
}

async function takeProfitOrder(symbol, contracts, tpPrice) {
  return mexcRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    price: tpPrice,
    vol: contracts,
    side: 4,
    type: 1,
    openType: 1
  });
}

async function cancelAllOrders(symbol) {
  return mexcRequest('POST', '/api/v1/private/order/cancel_all', { symbol });
}

async function closePosition(symbol) {
  await cancelAllOrders(symbol);
  return mexcRequest('POST', '/api/v1/private/position/close_all', { symbol });
}

async function getCurrentPrice(symbol) {
  try {
    const res = await axios.get(`${MEXC_BASE}/api/v1/contract/ticker?symbol=${symbol}`);
    return parseFloat(res.data?.data?.lastPrice || 0);
  } catch (e) { return 0; }
}

async function getAccountBalance() {
  const res = await mexcRequest('GET', '/api/v1/private/account/assets', {});
  if (!res || !res.data) return 0;
  const usdt = res.data.find(a => a.currency === 'USDT');
  return parseFloat(usdt?.availableBalance || 0);
}

async function getOpenPositions() {
  const res = await mexcRequest('GET', '/api/v1/private/position/open_positions', {});
  return res?.data || [];
}

// ============================================
// GOOGLE SHEETS
// ============================================
async function appendToSheet(row) {
  if (!SHEET_ID || !GOOGLE_CREDS) return;
  try {
    const creds = JSON.parse(GOOGLE_CREDS);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Bot!A:P',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
  } catch (e) { console.error('Sheets error:', e.message); }
}

async function initSheet() {
  if (!SHEET_ID || !GOOGLE_CREDS) return;
  try {
    const creds = JSON.parse(GOOGLE_CREDS);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Bot!A1:P1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        'Fecha entrada', 'Símbolo', 'DEX origen', 'Score', 'Precio entrada',
        'Precio salida', 'Cambio %', 'PnL ($)', 'Resultado',
        'SL', 'TP', 'Leverage', 'Trade size', 'Fecha salida', 'Motivo cierre', 'Notas'
      ]] }
    });
  } catch (e) { console.error('initSheet error:', e.message); }
}

// ============================================
// PARSEAR SEÑAL
// ============================================
function parseSignal(text) {
  try {
    if (text.startsWith('SIGNAL:')) {
      const json = JSON.parse(text.slice(7));
      return {
        score:   parseInt(json.score || 0),
        symbol:  json.sym || null,
        sym:     json.sym || null,
        dex:     json.dex || 'MEXC',
        entrada: parseFloat(json.entrada || 0),
        sl:      parseFloat(json.sl || 0),
        tp:      parseFloat(json.tp || 0),
        valid:   !!(json.score && json.sym && json.entrada)
      };
    }
    return { valid: false };
  } catch (e) {
    console.error('parseSignal error:', e.message);
    return { valid: false };
  }
}

// ============================================
// EJECUTAR TRADE
// ============================================
async function executeTrade(signal) {
  const sym = signal.sym || signal.symbol;
  const { dex, score, sl, tp } = signal;
  const mexcSymbol = `${sym}_USDT`;

  if (Object.keys(openPositions).length >= MAX_POSITIONS) {
    await sendTelegram(`⚠️ Máx posiciones (${MAX_POSITIONS}) — ignorando ${sym}`);
    return;
  }

  if (openPositions[sym]) {
    console.log(`Ya hay posición en ${sym}`);
    return;
  }

  const balance = await getAccountBalance();
  if (balance < TRADE_SIZE) {
    await sendTelegram(`❌ Balance insuficiente ($${balance.toFixed(2)}) para abrir ${sym}`);
    return;
  }

  const currentPrice = await getCurrentPrice(mexcSymbol);
  if (!currentPrice) {
    await sendTelegram(`❌ No se pudo obtener precio de ${sym}`);
    return;
  }

  const notional  = TRADE_SIZE * LEVERAGE;
  const contracts = Math.max(Math.floor(notional / currentPrice), 1);
  const slPrice   = sl > 0 ? sl : parseFloat((currentPrice * 1.10).toFixed(6));
  const tpPrice   = tp > 0 ? tp : parseFloat((currentPrice * 0.70).toFixed(6));

  console.log(`Abriendo short ${sym}: ${contracts} contratos @ $${currentPrice} | SL: ${slPrice} | TP: ${tpPrice}`);

  // await setLeverage(mexcSymbol, LEVERAGE); // skip - configurado manualmente

const order = await openShort(mexcSymbol, contracts);
  console.log('openShort response:', JSON.stringify(order));
  if (!order || order.code !== 200) {
    await sendTelegram(`❌ Error al abrir short ${sym}: ${order?.message || 'error desconocido'}`);
    return;
  }

  await sleep(1000);

  const tpOrder = await takeProfitOrder(mexcSymbol, contracts, tpPrice);
  if (!tpOrder || tpOrder.code !== 200) {
    console.warn(`TP order falló para ${sym}:`, tpOrder?.message);
  }

  const slOrder = await placeStopLoss(mexcSymbol, contracts, slPrice);
  if (!slOrder || slOrder.code !== 200) {
    console.warn(`SL order falló para ${sym}:`, slOrder?.message);
  }

  openPositions[sym] = {
    entryPrice: currentPrice,
    contracts,
    sl: slPrice,
    tp: tpPrice,
    openTime: new Date().toISOString(),
    score,
    dex,
    tpOrderId: tpOrder?.data,
    slOrderId: slOrder?.data
  };

  const tpOk = tpOrder?.code === 200 ? '✅' : '⚠️';
  const slOk = slOrder?.code === 200 ? '✅' : '⚠️';

  await sendTelegram(
    `✅ *SHORT abierto — ${sym}*\n\n` +
    `Score: ${score}/100 · ${dex}\n\n` +
    `├ Entrada:   $${currentPrice.toFixed(6)}\n` +
    `├ TP ${tpOk}:     $${tpPrice.toFixed(6)}\n` +
    `├ SL ${slOk}:     $${slPrice.toFixed(6)}\n` +
    `├ Contratos: ${contracts}\n` +
    `└ $${TRADE_SIZE} · ${LEVERAGE}x · exposición $${notional}\n\n` +
    `📊 Posiciones: ${Object.keys(openPositions).length}/${MAX_POSITIONS}`
  );
}

// ============================================
// MONITOR
// ============================================
async function monitorPositions() {
  if (Object.keys(openPositions).length === 0) return;

  const livePositions = await getOpenPositions();
  const liveSymbols = new Set(livePositions.map(p => p.symbol));

  for (const [symbol, pos] of Object.entries(openPositions)) {
    const mexcSymbol = `${symbol}_USDT`;

    if (!liveSymbols.has(mexcSymbol)) {
      const currentPrice = await getCurrentPrice(mexcSymbol);
      const change = currentPrice ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 : 0;
      const pnl = (change / 100) * LEVERAGE * TRADE_SIZE;

      let motivo = 'CERRADO';
      let emoji = '📊';
      if (currentPrice <= pos.tp) { motivo = 'TP'; emoji = '✅'; }
      else if (currentPrice >= pos.sl) { motivo = 'SL'; emoji = '❌'; }

      await sendTelegram(
        `${emoji} *Posición cerrada — ${symbol}*\n\n` +
        `Motivo: ${motivo}\n\n` +
        `├ Entrada: $${pos.entryPrice.toFixed(6)}\n` +
        `├ Salida:  $${currentPrice?.toFixed(6) || '?'}\n` +
        `├ Cambio:  ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\n` +
        `└ PnL:     ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
      );

      await appendToSheet([
        pos.openTime, symbol, pos.dex, pos.score,
        pos.entryPrice.toFixed(6), currentPrice?.toFixed(6) || '?',
        change.toFixed(2) + '%', pnl.toFixed(2),
        pnl > 0 ? 'WIN' : 'LOSS',
        pos.sl.toFixed(6), pos.tp.toFixed(6),
        LEVERAGE, TRADE_SIZE,
        new Date().toISOString(), motivo, `Score: ${pos.score}`
      ]);

      delete openPositions[symbol];
      console.log(`Posición cerrada: ${symbol} | ${motivo} | PnL: ${pnl.toFixed(2)}`);
    }
  }
}

// ============================================
// UTILIDADES
// ============================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown'
    });
  } catch (e) { console.error('sendTelegram error:', e.message); }
}

// ============================================
// MAIN
// ============================================
async function main() {
  // HTTP server PRIMERO
  const PORT = process.env.PORT || 8080;
  http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/signal') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const signal = JSON.parse(body);
          console.log('HTTP signal:', JSON.stringify(signal));
          res.writeHead(200);
          res.end('ok');
          if (!botActive) return;
          if (signal.score < SCORE_MIN) return;
          if (signal.dex === 'MEXC') await executeTrade(signal);
          else if (signal.dex === 'AsterDEX') {
            const url = `https://asterdex.com/en/trade/pro/futures/${signal.sym}USDT`;
            await sendTelegram(`⚡ *SEÑAL ASTERDEX — ${signal.sym}*\n\nScore: ${signal.score}/100\n\n├ Entrada: $${signal.entrada.toFixed(6)}\n├ SL: $${signal.sl.toFixed(6)}\n├ TP: $${signal.tp.toFixed(6)}\n\n🔗 [Abrir en AsterDEX](${url})\n\n⚠️ Ejecución manual`);
          }
        } catch(e) {
          console.error('HTTP signal error:', e.message);
          res.writeHead(400);
          res.end('error');
        }
      });
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  }).listen(PORT, () => console.log(`HTTP server en puerto ${PORT}`));

  console.log('🤖 MEXC Bot arrancando...');
  console.log(`Config: $${TRADE_SIZE}/trade · ${LEVERAGE}x · Score mín: ${SCORE_MIN} · Max pos: ${MAX_POSITIONS}`);

  await initSheet();

  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.on('message', async (msg) => {
    const text = msg.text || msg.caption || '';
    const chatId = msg.chat.id.toString();

    console.log(`Mensaje recibido | chat: ${chatId} | from: ${msg.from?.username || msg.from?.id} | forward: ${!!msg.forward_origin} | texto: ${text.substring(0, 60)}`);

    if (chatId !== TELEGRAM_CHAT_ID.toString()) return;

    if (text === '/status') {
      const balance = await getAccountBalance();
      const live = await getOpenPositions();
      await sendTelegram(
        `📊 *Bot Status*\n\n` +
        `Estado: ${botActive ? '🟢 Activo' : '🔴 Pausado'}\n` +
        `Balance: $${balance.toFixed(2)}\n` +
        `Posiciones MEXC: ${live.length}\n` +
        `Tracking local: ${Object.keys(openPositions).length}/${MAX_POSITIONS}`
      );
      return;
    }

    if (text === '/pause') {
      botActive = false;
      await sendTelegram('⏸ Bot pausado.');
      return;
    }

    if (text === '/resume') {
      botActive = true;
      await sendTelegram('▶️ Bot activado.');
      return;
    }

    if (text === '/positions') {
      const live = await getOpenPositions();
      if (live.length === 0) {
        await sendTelegram('📭 Sin posiciones abiertas.');
        return;
      }
      let msg = '📊 *Posiciones abiertas*\n\n';
      for (const p of live) {
        const sym = p.symbol.replace('_USDT', '');
        const cur = await getCurrentPrice(p.symbol);
        const entry = parseFloat(p.openAvgPrice || 0);
        const chg = entry > 0 && cur ? ((entry - cur) / entry * 100).toFixed(2) : '?';
        msg += `• *${sym}*: entrada $${entry.toFixed(4)} | actual $${cur?.toFixed(4)} | ${chg}%\n`;
      }
      await sendTelegram(msg);
      return;
    }

    if (text.startsWith('/close ')) {
      const sym = text.split(' ')[1]?.toUpperCase();
      if (!sym) return;
      await closePosition(`${sym}_USDT`);
      const pos = openPositions[sym];
      if (pos) {
        const cur = await getCurrentPrice(`${sym}_USDT`);
        const chg = ((pos.entryPrice - cur) / pos.entryPrice) * 100;
        const pnl = (chg / 100) * LEVERAGE * TRADE_SIZE;
        await appendToSheet([
          pos.openTime, sym, pos.dex, pos.score,
          pos.entryPrice.toFixed(6), cur.toFixed(6),
          chg.toFixed(2) + '%', pnl.toFixed(2), 'MANUAL',
          pos.sl.toFixed(6), pos.tp.toFixed(6),
          LEVERAGE, TRADE_SIZE, new Date().toISOString(), 'Manual', `Score: ${pos.score}`
        ]);
        delete openPositions[sym];
        await sendTelegram(`✅ ${sym} cerrado. PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
      } else {
        await sendTelegram(`⚠️ ${sym} cerrado en MEXC (sin tracking local).`);
      }
      return;
    }

    // Señales via Telegram (legacy, por si acaso)
    if (!botActive) return;
    if (!text.startsWith('SIGNAL:')) return;
    const signal = parseSignal(text);
    if (!signal.valid) return;
    if (signal.score < SCORE_MIN) return;
    if (signal.dex === 'MEXC') await executeTrade(signal);
  });

  bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
  });

  // Monitor cada 30s
  setInterval(monitorPositions, 30000);

  // Heartbeat cada hora
  setInterval(async () => {
    const balance = await getAccountBalance();
    console.log(`Heartbeat | $${balance.toFixed(2)} | Pos: ${Object.keys(openPositions).length}`);
  }, 3600000);

  // ============================================


  await sendTelegram(
    `🤖 *MEXC Bot online v2*\n\n` +
    `├ Trade size: $${TRADE_SIZE}\n` +
    `├ Leverage: ${LEVERAGE}x\n` +
    `├ Score mín: ${SCORE_MIN}\n` +
    `└ Max posiciones: ${MAX_POSITIONS}\n\n` +
    `SL/TP nativos + HTTP endpoint ✅\n\n` +
    `Comandos:\n` +
    `/status · /positions · /pause · /resume · /close SYMBOL`
  );

  console.log('✅ Bot v2 listo — SL/TP nativos MEXC + HTTP /signal');
}

main().catch(console.error);
