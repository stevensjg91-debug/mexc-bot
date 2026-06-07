require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
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
function mexcSign(params) {
  const ts = Date.now().toString();
  const queryString = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  const toSign = MEXC_API_KEY + ts + queryString;
  const sig = crypto.createHmac('sha256', MEXC_API_SECRET).update(toSign).digest('hex');
  return { ts, sig };
}

async function mexcRequest(method, path, params = {}) {
  const { ts, sig } = mexcSign(params);
  const headers = {
    'ApiKey': MEXC_API_KEY,
    'Request-Time': ts,
    'Signature': sig,
    'Content-Type': 'application/json'
  };
  try {
    const url = MEXC_BASE + path;
    const res = method === 'GET'
      ? await axios.get(url, { headers, params })
      : await axios.post(url, params, { headers });
    return res.data;
  } catch (e) {
    console.error(`MEXC error [${method} ${path}]:`, e.response?.data || e.message);
    return null;
  }
}

async function setLeverage(symbol, leverage) {
  return mexcRequest('POST', '/api/v1/private/position/change_leverage', {
    symbol,
    leverage,
    openType: 1
  });
}

async function openShort(symbol, contracts) {
  return mexcRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    price: 0,
    vol: contracts,
    side: 3,      // open short
    type: 5,      // market
    openType: 1   // isolated
  });
}

// SL nativo: orden stop que cierra el short cuando precio SUBE al SL
async function placeStopLoss(symbol, contracts, slPrice) {
  return mexcRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    price: slPrice,
    vol: contracts,
    side: 4,        // close short
    type: 3,        // stop market
    openType: 1,
    stopLossPrice: slPrice
  });
}

// TP nativo: orden limit que cierra el short cuando precio BAJA al TP
async function takeProfitOrder(symbol, contracts, tpPrice) {
  return mexcRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    price: tpPrice,
    vol: contracts,
    side: 4,        // close short
    type: 1,        // limit
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
// PARSEAR SEÑAL DEL SCANNER
// ============================================
function parseSignal(text) {
  try {
    const scoreMatch = text.match(/score[:\s]+(\d+)/i) || text.match(/\(score:\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;

    const symMatch = text.match(/\*([A-Z0-9]+)\*/);
    const symbol = symMatch ? symMatch[1] : null;

    const dexMatch = text.match(/·\s*(MEXC|AsterDEX|Hyperliquid|Backpack|Paradex)/i);
    const dex = dexMatch ? dexMatch[1] : 'MEXC';

    const entradaMatch = text.match(/Entrada[:\s]+\$([0-9.]+)/i);
    const entrada = entradaMatch ? parseFloat(entradaMatch[1]) : 0;

    const slMatch = text.match(/SL[:\s]+\$([0-9.]+)/i) || text.match(/Invalidaci[oó]n[:\s]+\$([0-9.]+)/i);
    const sl = slMatch ? parseFloat(slMatch[1]) : 0;

    const tpMatch = text.match(/TP[:\s]+\$([0-9.]+)/i);
    const tp = tpMatch ? parseFloat(tpMatch[1]) : 0;

    return { score, symbol, dex, entrada, sl, tp, valid: !!(score && symbol && entrada) };
  } catch (e) {
    return { valid: false };
  }
}

// ============================================
// EJECUTAR TRADE CON SL/TP NATIVOS
// ============================================
async function executeTrade(signal) {
  const { symbol, score, dex, sl, tp } = signal;
  const mexcSymbol = `${symbol}_USDT`;

  if (Object.keys(openPositions).length >= MAX_POSITIONS) {
    await sendTelegram(`⚠️ Máx posiciones (${MAX_POSITIONS}) — ignorando ${symbol}`);
    return;
  }

  if (openPositions[symbol]) {
    console.log(`Ya hay posición en ${symbol}`);
    return;
  }

  const balance = await getAccountBalance();
  if (balance < TRADE_SIZE) {
    await sendTelegram(`❌ Balance insuficiente ($${balance.toFixed(2)}) para abrir ${symbol}`);
    return;
  }

  const currentPrice = await getCurrentPrice(mexcSymbol);
  if (!currentPrice) {
    await sendTelegram(`❌ No se pudo obtener precio de ${symbol}`);
    return;
  }

  // Calcular contratos
  const notional = TRADE_SIZE * LEVERAGE;
  const contracts = Math.max(Math.floor((notional / currentPrice) * 10) / 10, 0.1);

  // Calcular SL y TP
  const slPrice = sl > 0 ? sl : parseFloat((currentPrice * 1.10).toFixed(6));
  const tpPrice = tp > 0 ? tp : parseFloat((currentPrice * 0.70).toFixed(6));

  console.log(`Abriendo short ${symbol}: ${contracts} contratos @ $${currentPrice} | SL: ${slPrice} | TP: ${tpPrice}`);

  // 1. Configurar leverage
  await setLeverage(mexcSymbol, LEVERAGE);

  // 2. Abrir short (market)
  const order = await openShort(mexcSymbol, contracts);
  if (!order || order.code !== 200) {
    await sendTelegram(`❌ Error al abrir short ${symbol}: ${order?.message || 'error desconocido'}`);
    return;
  }

  // Pequeña pausa para que la orden se procese
  await sleep(1000);

  // 3. Poner TP nativo (limit close)
  const tpOrder = await takeProfitOrder(mexcSymbol, contracts, tpPrice);
  if (!tpOrder || tpOrder.code !== 200) {
    console.warn(`TP order falló para ${symbol}:`, tpOrder?.message);
  }

  // 4. Poner SL nativo (stop market close)
  const slOrder = await placeStopLoss(mexcSymbol, contracts, slPrice);
  if (!slOrder || slOrder.code !== 200) {
    console.warn(`SL order falló para ${symbol}:`, slOrder?.message);
  }

  // Guardar posición en memoria para tracking
  openPositions[symbol] = {
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

  const slOk = tpOrder?.code === 200 ? '✅' : '⚠️';
  const tpOk = slOrder?.code === 200 ? '✅' : '⚠️';

  await sendTelegram(
    `✅ *SHORT abierto — ${symbol}*\n\n` +
    `Score: ${score}/100 · ${dex}\n\n` +
    `├ Entrada:   $${currentPrice.toFixed(6)}\n` +
    `├ TP ${slOk}:     $${tpPrice.toFixed(6)}\n` +
    `├ SL ${tpOk}:     $${slPrice.toFixed(6)}\n` +
    `├ Contratos: ${contracts}\n` +
    `└ $${TRADE_SIZE} · ${LEVERAGE}x · exposición $${notional}\n\n` +
    `📊 Posiciones: ${Object.keys(openPositions).length}/${MAX_POSITIONS}`
  );
}

// ============================================
// MONITOR — verifica si posición ya cerró (cada 30s)
// Solo para detectar cierres y registrar en Sheets
// El SL/TP real lo gestiona MEXC directamente
// ============================================
async function monitorPositions() {
  if (Object.keys(openPositions).length === 0) return;

  const livePositions = await getOpenPositions();
  const liveSymbols = new Set(livePositions.map(p => p.symbol));

  for (const [symbol, pos] of Object.entries(openPositions)) {
    const mexcSymbol = `${symbol}_USDT`;

    // Si ya no está en posiciones abiertas → cerró (por SL, TP o manual)
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
  console.log('🤖 MEXC Bot arrancando...');
  console.log(`Config: $${TRADE_SIZE}/trade · ${LEVERAGE}x · Score mín: ${SCORE_MIN} · Max pos: ${MAX_POSITIONS}`);

  await initSheet();

  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.on('message', async (msg) => {
    const text = msg.text || msg.caption || '';
    const chatId = msg.chat.id.toString();

    // Log para debug
    console.log(`Mensaje recibido | chat: ${chatId} | from: ${msg.from?.username || msg.from?.id} | forward: ${!!msg.forward_origin} | texto: ${text.substring(0, 60)}`);

    if (chatId !== TELEGRAM_CHAT_ID.toString()) return;

    // Comandos
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

    // Procesar señal Death Scanner
    if (!botActive) return;

    // Detectar mensaje del wolfscannnerbot (directo o reenviado)
    const fromScanner = msg.forward_origin?.sender_user?.username === 'wolfscannnerbot'
      || msg.forward_from?.username === 'wolfscannnerbot'
      || msg.from?.username === 'wolfscannnerbot'
      || msg.from?.id === 8772548345;

    const isSignal = text.includes('DEATH SCANNER') || text.includes('CONFIRMADA') || text.includes('score:');

    if (!fromScanner && !isSignal) return;

    const signal = parseSignal(text);
    if (!signal.valid) return;
    if (signal.score < SCORE_MIN) {
      console.log(`Score ${signal.score} < ${SCORE_MIN}, ignorando ${signal.symbol}`);
      return;
    }
    if (signal.dex !== 'MEXC') {
      console.log(`Señal ${signal.dex} ignorada (solo MEXC)`);
      return;
    }

    console.log(`Señal: ${signal.symbol} score=${signal.score}`);
    await executeTrade(signal);
  });

  bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
  });

  // Monitor cada 30s — solo para detectar cierres y registrar
  setInterval(monitorPositions, 30000);

  // Heartbeat cada hora
  setInterval(async () => {
    const balance = await getAccountBalance();
    console.log(`Heartbeat | $${balance.toFixed(2)} | Pos: ${Object.keys(openPositions).length}`);
  }, 3600000);

  await sendTelegram(
    `🤖 *MEXC Bot online v2*\n\n` +
    `├ Trade size: $${TRADE_SIZE}\n` +
    `├ Leverage: ${LEVERAGE}x\n` +
    `├ Score mín: ${SCORE_MIN}\n` +
    `└ Max posiciones: ${MAX_POSITIONS}\n\n` +
    `SL/TP nativos activados ✅\n\n` +
    `Comandos:\n` +
    `/status · /positions · /pause · /resume · /close SYMBOL`
  );

  console.log('✅ Bot v2 listo — SL/TP nativos MEXC');
}

main().catch(console.error);
