require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');

// ============================================
// CONFIG
// ============================================
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MEXC_API_KEY    = process.env.MEXC_API_KEY;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET;
const SHEET_ID        = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDS    = process.env.GOOGLE_CREDENTIALS; // JSON string

const TRADE_SIZE      = parseFloat(process.env.TRADE_SIZE || '5');
const LEVERAGE        = parseInt(process.env.LEVERAGE || '3');
const SCORE_MIN       = parseInt(process.env.SCORE_MIN || '90');
const MAX_POSITIONS   = parseInt(process.env.MAX_POSITIONS || '4');

const MEXC_BASE = 'https://contract.mexc.com';

// ============================================
// ESTADO EN MEMORIA
// ============================================
let openPositions = {}; // { symbol: { entryPrice, size, sl, tp, openTime } }
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
    openType: 1 // isolated
  });
}

async function openShort(symbol, size) {
  return mexcRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    price: 0,           // market order
    vol: size,
    side: 3,            // 3 = open short
    type: 5,            // market
    openType: 1,        // isolated
    leverage
  });
}

async function closePosition(symbol) {
  return mexcRequest('POST', '/api/v1/private/position/close_all', {
    symbol
  });
}

async function getPositions() {
  return mexcRequest('GET', '/api/v1/private/position/open_positions', {});
}

async function getCurrentPrice(symbol) {
  try {
    const res = await axios.get(`${MEXC_BASE}/api/v1/contract/ticker?symbol=${symbol}`);
    return parseFloat(res.data?.data?.lastPrice || 0);
  } catch (e) {
    return 0;
  }
}

async function getAccountBalance() {
  const res = await mexcRequest('GET', '/api/v1/private/account/assets', {});
  if (!res || !res.data) return 0;
  const usdt = res.data.find(a => a.currency === 'USDT');
  return parseFloat(usdt?.availableBalance || 0);
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
  } catch (e) {
    console.error('Sheets error:', e.message);
  }
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
    const headers = [[
      'Fecha entrada', 'Símbolo', 'DEX origen', 'Score', 'Precio entrada',
      'Precio salida', 'Cambio %', 'PnL ($)', 'Resultado',
      'SL', 'TP', 'Leverage', 'Trade size', 'Fecha salida', 'Motivo cierre', 'Notas'
    ]];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Bot!A1:P1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: headers }
    });
    console.log('Sheet inicializada');
  } catch (e) {
    console.error('initSheet error:', e.message);
  }
}

// ============================================
// PARSEAR MENSAJE DEL SCANNER
// ============================================
function parseSignal(text) {
  try {
    // Extraer score
    const scoreMatch = text.match(/score[:\s]+(\d+)/i) || text.match(/\(score:\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;

    // Extraer símbolo
    const symMatch = text.match(/\*([A-Z0-9]+)\*/);
    const symbol = symMatch ? symMatch[1] : null;

    // Extraer DEX
    const dexMatch = text.match(/·\s*(MEXC|AsterDEX|Hyperliquid|Backpack|Paradex)/i);
    const dex = dexMatch ? dexMatch[1] : 'MEXC';

    // Extraer precio entrada
    const entradaMatch = text.match(/Entrada[:\s]+\$([0-9.]+)/i);
    const entrada = entradaMatch ? parseFloat(entradaMatch[1]) : 0;

    // Extraer SL
    const slMatch = text.match(/SL[:\s]+\$([0-9.]+)/i) || text.match(/Invalidaci[oó]n[:\s]+\$([0-9.]+)/i);
    const sl = slMatch ? parseFloat(slMatch[1]) : 0;

    // Extraer TP
    const tpMatch = text.match(/TP[:\s]+\$([0-9.]+)/i);
    const tp = tpMatch ? parseFloat(tpMatch[1]) : 0;

    return { score, symbol, dex, entrada, sl, tp, valid: !!(score && symbol && entrada) };
  } catch (e) {
    console.error('parseSignal error:', e.message);
    return { valid: false };
  }
}

// ============================================
// EJECUTAR TRADE
// ============================================
async function executeTrade(signal) {
  const { symbol, score, dex, entrada, sl, tp } = signal;
  const mexcSymbol = `${symbol}_USDT`;

  // Verificar máx posiciones
  if (Object.keys(openPositions).length >= MAX_POSITIONS) {
    console.log(`MAX_POSITIONS alcanzado (${MAX_POSITIONS}), ignorando ${symbol}`);
    await sendTelegram(`⚠️ Máx posiciones (${MAX_POSITIONS}) alcanzado — ignorando ${symbol}`);
    return;
  }

  // Verificar si ya hay posición abierta en este symbol
  if (openPositions[symbol]) {
    console.log(`Ya hay posición abierta en ${symbol}`);
    return;
  }

  // Verificar balance
  const balance = await getAccountBalance();
  if (balance < TRADE_SIZE) {
    console.log(`Balance insuficiente: $${balance}`);
    await sendTelegram(`❌ Balance insuficiente ($${balance.toFixed(2)}) para abrir ${symbol}`);
    return;
  }

  // Calcular precio actual
  const currentPrice = await getCurrentPrice(mexcSymbol);
  if (!currentPrice) {
    console.log(`No se pudo obtener precio de ${mexcSymbol}`);
    return;
  }

  // Calcular volumen en contratos
  const notional = TRADE_SIZE * LEVERAGE;
  const contracts = Math.floor((notional / currentPrice) * 10) / 10; // 1 decimal
  if (contracts <= 0) {
    console.log(`Contratos insuficientes para ${symbol}`);
    return;
  }

  console.log(`Abriendo short ${symbol}: ${contracts} contratos @ $${currentPrice}`);

  // Configurar leverage
  await setLeverage(mexcSymbol, LEVERAGE);

  // Abrir short
  const order = await openShort(mexcSymbol, contracts);
  if (!order || order.code !== 200) {
    console.error(`Error abriendo orden ${symbol}:`, order);
    await sendTelegram(`❌ Error al abrir short ${symbol}: ${order?.message || 'desconocido'}`);
    return;
  }

  // Guardar posición
  const slPrice = sl || currentPrice * 1.10;
  const tpPrice = tp || currentPrice * 0.70;
  openPositions[symbol] = {
    entryPrice: currentPrice,
    contracts,
    sl: slPrice,
    tp: tpPrice,
    openTime: new Date().toISOString(),
    score,
    dex,
    orderId: order.data
  };

  const msg = `✅ *SHORT abierto*\n\n`
    + `🏷 *${symbol}* · ${dex}\n`
    + `Score: ${score}/100\n\n`
    + `├ Entrada:  $${currentPrice.toFixed(6)}\n`
    + `├ SL:       $${slPrice.toFixed(6)}\n`
    + `├ TP:       $${tpPrice.toFixed(6)}\n`
    + `├ Contratos: ${contracts}\n`
    + `└ Trade size: $${TRADE_SIZE} · ${LEVERAGE}x\n\n`
    + `📊 Posiciones abiertas: ${Object.keys(openPositions).length}/${MAX_POSITIONS}`;

  await sendTelegram(msg);
  console.log(`SHORT abierto: ${symbol} @ ${currentPrice}`);
}

// ============================================
// MONITOR POSICIONES (cada 30s)
// ============================================
async function monitorPositions() {
  if (Object.keys(openPositions).length === 0) return;

  for (const [symbol, pos] of Object.entries(openPositions)) {
    const mexcSymbol = `${symbol}_USDT`;
    const currentPrice = await getCurrentPrice(mexcSymbol);
    if (!currentPrice) continue;

    const change = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100; // short: baja = ganancia
    const pnl = (change / 100) * LEVERAGE * TRADE_SIZE;

    let closeReason = null;

    if (currentPrice >= pos.sl) {
      closeReason = 'SL';
    } else if (currentPrice <= pos.tp) {
      closeReason = 'TP';
    }

    if (closeReason) {
      await closePosition(mexcSymbol);

      const resultado = closeReason === 'TP' ? '✅ TP alcanzado' : '❌ SL alcanzado';
      const emoji = closeReason === 'TP' ? '✅' : '❌';

      const msg = `${emoji} *Posición cerrada*\n\n`
        + `🏷 *${symbol}*\n`
        + `${resultado}\n\n`
        + `├ Entrada: $${pos.entryPrice.toFixed(6)}\n`
        + `├ Salida:  $${currentPrice.toFixed(6)}\n`
        + `├ Cambio:  ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\n`
        + `└ PnL:     ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;

      await sendTelegram(msg);

      // Guardar en Sheets
      await appendToSheet([
        pos.openTime,
        symbol,
        pos.dex,
        pos.score,
        pos.entryPrice.toFixed(6),
        currentPrice.toFixed(6),
        change.toFixed(2) + '%',
        pnl.toFixed(2),
        closeReason === 'TP' ? 'WIN' : 'LOSS',
        pos.sl.toFixed(6),
        pos.tp.toFixed(6),
        LEVERAGE,
        TRADE_SIZE,
        new Date().toISOString(),
        closeReason,
        `Score: ${pos.score}`
      ]);

      delete openPositions[symbol];
      console.log(`Posición cerrada: ${symbol} | ${closeReason} | PnL: ${pnl.toFixed(2)}`);
    }
  }
}

// ============================================
// TELEGRAM
// ============================================
async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error('sendTelegram error:', e.message);
  }
}

// ============================================
// ARRANQUE
// ============================================
async function main() {
  console.log('🤖 MEXC Bot arrancando...');
  console.log(`Config: $${TRADE_SIZE}/trade · ${LEVERAGE}x · Score mín: ${SCORE_MIN} · Max pos: ${MAX_POSITIONS}`);

  await initSheet();

  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  // Escuchar mensajes del scanner
  bot.on('message', async (msg) => {
    const text = msg.text || msg.caption || '';
    const chatId = msg.chat.id.toString();

    // Solo procesar mensajes del chat del scanner
    if (chatId !== TELEGRAM_CHAT_ID.toString()) return;

    // Comandos de control
    if (text === '/status') {
      const positions = Object.keys(openPositions);
      const balance = await getAccountBalance();
      const statusMsg = `📊 *Bot Status*\n\n`
        + `Estado: ${botActive ? '🟢 Activo' : '🔴 Pausado'}\n`
        + `Balance: $${balance.toFixed(2)}\n`
        + `Posiciones: ${positions.length}/${MAX_POSITIONS}\n`
        + (positions.length > 0 ? `\nAbiertas:\n${positions.map(s => `• ${s}`).join('\n')}` : '');
      await sendTelegram(statusMsg);
      return;
    }

    if (text === '/pause') {
      botActive = false;
      await sendTelegram('⏸ Bot pausado. No abrirá nuevas posiciones.');
      return;
    }

    if (text === '/resume') {
      botActive = true;
      await sendTelegram('▶️ Bot activado.');
      return;
    }

    if (text === '/positions') {
      const positions = Object.entries(openPositions);
      if (positions.length === 0) {
        await sendTelegram('📭 Sin posiciones abiertas.');
        return;
      }
      let msg = '📊 *Posiciones abiertas*\n\n';
      for (const [sym, pos] of positions) {
        const cur = await getCurrentPrice(`${sym}_USDT`);
        const chg = cur ? ((pos.entryPrice - cur) / pos.entryPrice * 100).toFixed(2) : '?';
        msg += `• *${sym}*: entrada $${pos.entryPrice.toFixed(4)} | actual $${cur?.toFixed(4) || '?'} | ${chg}%\n`;
      }
      await sendTelegram(msg);
      return;
    }

    if (text.startsWith('/close ')) {
      const sym = text.split(' ')[1]?.toUpperCase();
      if (sym && openPositions[sym]) {
        await closePosition(`${sym}_USDT`);
        const cur = await getCurrentPrice(`${sym}_USDT`);
        const pos = openPositions[sym];
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
        await sendTelegram(`✅ ${sym} cerrado manualmente. PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
      } else {
        await sendTelegram(`❌ No hay posición abierta en ${sym || '?'}`);
      }
      return;
    }

    // Procesar señal del Death Scanner
    if (!botActive) return;
    if (!text.includes('DEATH SCANNER') && !text.includes('CONFIRMADA') && !text.includes('score')) return;

    const signal = parseSignal(text);
    if (!signal.valid) return;
    if (signal.score < SCORE_MIN) {
      console.log(`Score ${signal.score} < ${SCORE_MIN}, ignorando ${signal.symbol}`);
      return;
    }
    if (signal.dex !== 'MEXC') {
      console.log(`Señal de ${signal.dex}, ignorando (solo MEXC)`);
      return;
    }

    console.log(`Señal recibida: ${signal.symbol} score=${signal.score}`);
    await executeTrade(signal);
  });

  // Monitor de posiciones cada 30 segundos
  setInterval(monitorPositions, 30000);

  // Heartbeat cada hora
  setInterval(async () => {
    const balance = await getAccountBalance();
    console.log(`Heartbeat | Balance: $${balance.toFixed(2)} | Posiciones: ${Object.keys(openPositions).length}`);
  }, 3600000);

  await sendTelegram(`🤖 *MEXC Bot online*\n\n`
    + `Config:\n`
    + `├ Trade size: $${TRADE_SIZE}\n`
    + `├ Leverage: ${LEVERAGE}x\n`
    + `├ Score mín: ${SCORE_MIN}\n`
    + `└ Max posiciones: ${MAX_POSITIONS}\n\n`
    + `Comandos:\n`
    + `/status — estado del bot\n`
    + `/positions — posiciones abiertas\n`
    + `/pause — pausar bot\n`
    + `/resume — activar bot\n`
    + `/close SYMBOL — cerrar posición manual`
  );

  console.log('✅ Bot listo y escuchando señales');
}

main().catch(console.error);
