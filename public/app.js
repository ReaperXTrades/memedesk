// Memecoin Bot Desk — PAPIERGELD / SIMULATION.
// Keine Wallet, keine Keys, keine echten Orders. Die Bot-Schleife läuft nur,
// solange die Seite offen ist. Stand liegt in localStorage.
(function () {
  const START = 300;
  const KEY = 'memedesk-state-v1';
  const TICK_MS = 20000;
  const CANDLE_TTL = 30000;
  const GECKO_GAP = 2200; // ~27 req/min ceiling, under GeckoTerminal's ~30/min

  const BOTS = {
    Scanner: ['🔭', '#2b6cff'],
    Social: ['📣', '#c43dff'],
    Analyst: ['📈', '#00b3a4'],
    Sizer: ['⚖️', '#ff9f1a'],
    Risk: ['🛡️', '#ff3d5e'],
    Skeptiker: ['🤨', '#8a8a8a'],
    Fills: ['✅', '#21b36b'],
    System: ['🖥️', '#333']
  };

  const $ = id => document.getElementById(id);
  const usdMsg = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  const usd = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const k = n => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + (+n).toFixed(0);
  const fp = p => p >= 1 ? p.toFixed(4) : Number(p).toPrecision(4);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const pick = a => a[Math.floor(Math.random() * a.length)];

  function fresh() {
    return { cash: START, start: START, positions: [], trades: [], pending: [], feed: [], auto: false, seq: 0, cooldown: {}, said: {} };
  }

  function loadState() {
    const base = fresh();
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!raw || typeof raw.cash !== 'number') return base;
      return {
        cash: raw.cash,
        start: typeof raw.start === 'number' ? raw.start : START,
        positions: Array.isArray(raw.positions) ? raw.positions : [],
        trades: Array.isArray(raw.trades) ? raw.trades : [],
        pending: Array.isArray(raw.pending) ? raw.pending : [],
        feed: Array.isArray(raw.feed) ? raw.feed : [],
        auto: !!raw.auto,
        seq: raw.seq | 0,
        cooldown: raw.cooldown && typeof raw.cooldown === 'object' ? raw.cooldown : {},
        said: raw.said && typeof raw.said === 'object' ? raw.said : {}
      };
    } catch {
      return base;
    }
  }

  let S = loadState();
  let market = [];
  let lastRun = 0;
  let sel = null;
  let pct = 0.25;
  let renderedUntil = 0;
  let ticking = false;
  let lastPool = null;

  function pruneMaps() {
    const now = Date.now();
    for (const key of Object.keys(S.cooldown)) if (now - S.cooldown[key] > 15 * 60e3) delete S.cooldown[key];
    for (const key of Object.keys(S.said)) if (now - S.said[key] > 60 * 60e3) delete S.said[key];
  }

  function persist() {
    pruneMaps();
    const payload = {
      cash: S.cash, start: S.start, positions: S.positions, trades: S.trades,
      pending: S.pending, feed: S.feed, auto: S.auto, seq: S.seq,
      cooldown: S.cooldown, said: S.said
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(payload));
    } catch {
      payload.feed = S.feed = S.feed.slice(-80);
      payload.trades = S.trades = S.trades.slice(-80);
      try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch { /* quota, keep running */ }
    }
  }

  function say(bot, text, extra = {}) {
    S.feed.push({ t: Date.now(), bot, text, ...extra, id: ++S.seq });
    if (S.feed.length > 250) S.feed.splice(0, S.feed.length - 250);
  }

  function equity() {
    return S.cash + S.positions.reduce((a, p) => a + p.qty * p.last, 0);
  }

  function open(t, size, by, plan) {
    size = Math.min(size, S.cash);
    if (size < 1 || !(t.price > 0)) return null;
    const p = {
      id: ++S.seq, address: t.address, symbol: t.symbol, pool: t.pool, img: t.img,
      entry: t.price, last: t.price, qty: size / t.price, cost: size,
      tp: plan?.tp || t.price * 1.3, sl: plan?.sl || t.price * 0.88,
      opened: Date.now(), by
    };
    S.cash -= size;
    S.positions.push(p);
    say('Fills', `Paper-Buy ${t.symbol}: ${usdMsg(size)} @ $${fp(t.price)} (${by}).`, { kind: 'fill' });
    return p;
  }

  function close(p, frac, reason) {
    frac = Math.min(1, frac);
    const q = p.qty * frac, val = q * p.last, cost = p.cost * frac, pnl = val - cost;
    S.cash += val;
    p.qty -= q;
    p.cost -= cost;
    const tr = { n: S.trades.length + 1, symbol: p.symbol, img: p.img, entry: p.entry, exit: p.last, cost, pnl, pct: cost ? pnl / cost * 100 : 0, reason, t: Date.now() };
    S.trades.push(tr);
    if (p.qty * p.last < 0.01 || frac >= 1) S.positions = S.positions.filter(x => x !== p);
    say('Fills', `Trade ${tr.n} closed ${pnl >= 0 ? '+' : ''}${usdMsg(pnl)} (${tr.pct.toFixed(1)}%) — ${p.symbol}, ${reason}.`, { kind: pnl >= 0 ? 'win' : 'loss' });
    S.cooldown[p.address] = Date.now();
    return tr;
  }

  function score(t) {
    const spike = t.vol1h > 0 ? t.vol5 / (t.vol1h / 12) : 0;
    const ratio = (t.buys5 + 1) / (t.sells5 + 1);
    const s = Math.max(-20, Math.min(20, t.ch5)) * 1.5
      + Math.min(spike, 5) * 6
      + Math.min(ratio, 3) * 8
      + (t.boost ? 5 : 0)
      + Math.min(t.socials, 3) * 2
      - (t.liq < 20000 ? 30 : 0)
      - (t.ageMin < 30 ? 15 : 0);
    return { spike, ratio, s };
  }

  async function j(u) {
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(r.status + ' ' + u);
    return r.json();
  }

  async function loadMarket() {
    const [boosts, profiles] = await Promise.all([
      j('https://api.dexscreener.com/token-boosts/latest/v1').catch(() => []),
      j('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => [])
    ]);
    const boost = {};
    for (const b of (Array.isArray(boosts) ? boosts : [])) {
      if (b.chainId === 'solana' && b.tokenAddress) boost[b.tokenAddress] = (boost[b.tokenAddress] || 0) + (b.amount || 0);
    }
    const profileAddrs = (Array.isArray(profiles) ? profiles : []).filter(p => p.chainId === 'solana').map(p => p.tokenAddress);
    const addrs = [...new Set([...S.positions.map(p => p.address), ...Object.keys(boost), ...profileAddrs])].filter(Boolean).slice(0, 60);
    let pairs = [];
    for (let i = 0; i < addrs.length; i += 30) {
      const got = await j('https://api.dexscreener.com/tokens/v1/solana/' + addrs.slice(i, i + 30).join(',')).catch(() => []);
      pairs = pairs.concat(Array.isArray(got) ? got : []);
    }
    const q = ['pump', 'meme', 'bonk', 'pepe', 'dog', 'cat'][Math.floor(Date.now() / 20000) % 6];
    const s = await j('https://api.dexscreener.com/latest/dex/search?q=' + q).catch(() => ({ pairs: [] }));
    pairs = pairs.concat(((s && s.pairs) || []).filter(p => p.chainId === 'solana' && ((p.volume && p.volume.h1) || 0) > 1000));
    const best = {};
    for (const p of pairs) {
      const a = p.baseToken && p.baseToken.address;
      if (!a || !p.priceUsd) continue;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const prev = (best[a] && best[a].liquidity && best[a].liquidity.usd) || 0;
      if (!best[a] || liq > prev) best[a] = p;
    }
    market = Object.values(best).map(p => {
      const m5 = (p.txns && p.txns.m5) || {};
      const h1 = (p.txns && p.txns.h1) || {};
      return {
        address: p.baseToken.address,
        symbol: p.baseToken.symbol,
        name: p.baseToken.name,
        pool: p.pairAddress,
        url: p.url,
        img: (p.info && p.info.imageUrl) || null,
        price: +p.priceUsd,
        mcap: p.marketCap || p.fdv || 0,
        liq: (p.liquidity && p.liquidity.usd) || 0,
        vol5: (p.volume && p.volume.m5) || 0,
        vol1h: (p.volume && p.volume.h1) || 0,
        vol24: (p.volume && p.volume.h24) || 0,
        ch5: (p.priceChange && p.priceChange.m5) || 0,
        ch1: (p.priceChange && p.priceChange.h1) || 0,
        ch24: (p.priceChange && p.priceChange.h24) || 0,
        buys5: m5.buys || 0,
        sells5: m5.sells || 0,
        buys1: h1.buys || 0,
        sells1: h1.sells || 0,
        ageMin: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 6e4 : 9999,
        boost: boost[p.baseToken.address] || 0,
        socials: ((p.info && p.info.socials) || []).length
      };
    }).filter(t => t.liq > 0).sort((a, b) => b.vol5 - a.vol5);
  }

  async function runTick() {
    try {
      await loadMarket();
    } catch (e) {
      say('System', 'Datenquelle hakt: ' + e.message);
      return;
    }
    lastRun = Date.now();
    const by = {};
    market.forEach(t => { by[t.address] = t; });

    for (const p of [...S.positions]) {
      const t = by[p.address];
      if (!t) continue;
      p.last = t.price;
      const ch = (p.last / p.entry - 1) * 100;
      if (p.last <= p.sl) {
        say('Risk', `${p.symbol} ${ch.toFixed(1)}% — Stop getroffen. Out, no arguing.`, { kind: 'risk' });
        close(p, 1, 'Stop-Loss');
      } else if (p.last >= p.tp) {
        say('Risk', `${p.symbol} +${ch.toFixed(1)}% — Take-Profit. Gewinne sichern.`, { kind: 'risk' });
        close(p, 1, 'Take-Profit');
      } else if (Date.now() - p.opened > 45 * 6e4) {
        say('Risk', `${p.symbol} läuft 45 Min seitwärts (${ch.toFixed(1)}%). Zeit-Stop.`, { kind: 'risk' });
        close(p, 1, 'Zeit-Stop');
      } else if (t.liq < 10000) {
        say('Risk', `${p.symbol}: Liquidität weg (${k(t.liq)}). Raus.`, { kind: 'risk' });
        close(p, 1, 'Liquidität');
      }
    }

    S.pending = S.pending.filter(x => Date.now() - x.t < 5 * 6e4);

    const ranked = market.map(t => ({ t, ...score(t) })).sort((a, b) => b.s - a.s);
    const movers = ranked.slice(0, 3);
    for (const m of movers.filter(m => Date.now() - (S.said[m.t.address] || 0) > 4 * 6e4).slice(0, 2)) {
      const t = m.t;
      S.said[t.address] = Date.now();
      say('Scanner', t.ch5 < -3
        ? `${t.symbol} is flushing. ${k(t.mcap)}, red candles (${t.ch5.toFixed(1)}% 5m).`
        : `${t.symbol} bewegt sich: ${t.ch5 >= 0 ? '+' : ''}${t.ch5.toFixed(1)}% in 5m, MC ${k(t.mcap)}, Vol-Spike ${m.spike.toFixed(1)}x.`,
      { address: t.address });
    }

    const hot = ranked.find(m => m.t.boost > 0 && Date.now() - (S.said['s' + m.t.address] || 0) > 5 * 6e4);
    if (hot && (S.said['s' + hot.t.address] = Date.now())) {
      say('Social', pick([
        `${hot.t.symbol} hat ${hot.t.boost} Boosts auf DexScreener — Leute zahlen für Aufmerksamkeit.`,
        `Trending: ${hot.t.symbol}, ${hot.t.socials} Social-Links, ${hot.t.buys5} Buys in 5m.`,
        `${hot.t.symbol} wird gepusht (Boost ${hot.t.boost}). Hype ≠ Edge.`
      ]), { address: hot.t.address });
    }

    const c = ranked.find(m =>
      !S.positions.some(p => p.address === m.t.address) &&
      !S.pending.some(p => p.address === m.t.address) &&
      Date.now() - (S.cooldown[m.t.address] || 0) > 10 * 6e4 &&
      (m.t.liq >= 20000 || Math.random() < 0.25)
    );
    if (!c) return;

    const t = c.t;
    const vol = Math.min(30, Math.max(6, Math.abs(t.ch5) * 1.5 + 4));
    const plan = { entry: t.price, tp: t.price * (1 + vol * 1.8 / 100), sl: t.price * (1 - vol / 100), tpPct: vol * 1.8, slPct: vol };
    say('Analyst', `${t.symbol}: Entry $${fp(plan.entry)}, TP +${plan.tpPct.toFixed(0)}%, Stop -${plan.slPct.toFixed(0)}%. Buy/Sell ${c.ratio.toFixed(2)}.`, { address: t.address });
    const eq = equity();
    const expo = eq - S.cash;
    const size = Math.max(5, Math.min(S.cash, eq * (c.s > 45 ? 0.25 : c.s > 30 ? 0.15 : 0.1)));
    say('Sizer', `${usdMsg(size)} auf ${t.symbol} (${(eq ? size / eq * 100 : 0).toFixed(0)}% der Bank).`, { address: t.address });

    let v = 'BUY';
    let why = 'Momentum, Volumen und Käuferdruck passen.';
    if (t.liq < 20000) { v = 'PASS'; why = `Liquidität nur ${k(t.liq)} — da kommst du nicht raus.`; }
    else if (t.ageMin < 30) { v = 'PASS'; why = `Pair erst ${t.ageMin.toFixed(0)} Min alt. Rug-Risiko.`; }
    else if (c.ratio < 1) { v = 'PASS'; why = `Mehr Sells als Buys (${t.buys5}/${t.sells5}). Wir sind der Exit-Liquidity.`; }
    else if (t.ch1 > 120) { v = 'WAIT'; why = `+${t.ch1.toFixed(0)}% in 1h — zu spät, warte auf Pullback.`; }
    else if (c.s < 20) { v = 'WAIT'; why = `Score ${c.s.toFixed(0)} zu schwach. Kein Setup.`; }
    else if (S.positions.length >= 3 || expo + size > eq * 0.7) { v = 'WAIT'; why = 'Risk-Limit: max. 3 Positionen / 70% Exposure.'; }

    say('Skeptiker', `${v} ${t.symbol} — ${why}`, { kind: 'verdict', verdict: v, address: t.address });
    if (v !== 'BUY') S.cooldown[t.address] = Date.now();
    if (v === 'BUY') {
      if (S.auto) open(t, size, 'Auto', plan);
      else {
        const pr = { id: ++S.seq, address: t.address, symbol: t.symbol, img: t.img, size, plan, why, t: Date.now() };
        S.pending.push(pr);
        say('System', `Freigabe nötig: ${t.symbol} ${usdMsg(size)}. Du entscheidest.`, { kind: 'approval', pid: pr.id });
      }
    }
  }

  const candleCache = {};
  const inflight = {};
  let geckoAt = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function candles(pool) {
    const hit = candleCache[pool];
    if (hit && Date.now() - hit.t < CANDLE_TTL) return hit.d;
    if (inflight[pool]) return inflight[pool];
    inflight[pool] = (async () => {
      const wait = geckoAt - Date.now();
      if (wait > 0) await sleep(wait);
      geckoAt = Date.now() + GECKO_GAP;
      try {
        const r = await j(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/minute?aggregate=1&limit=150`);
        const list = (r && r.data && r.data.attributes && r.data.attributes.ohlcv_list) || [];
        const map = new Map();
        for (const x of list) map.set(x[0], { time: x[0], open: x[1], high: x[2], low: x[3], close: x[4], volume: x[5] });
        const d = [...map.values()].sort((a, b) => a.time - b.time);
        candleCache[pool] = { t: Date.now(), d };
        return d;
      } catch (e) {
        if (String(e.message).includes('429')) geckoAt = Date.now() + 60000;
        throw e;
      } finally {
        delete inflight[pool];
      }
    })();
    return inflight[pool];
  }

  function safeHttps(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && (u.hostname === 'dexscreener.com' || u.hostname.endsWith('.dexscreener.com'))) return u.href;
    } catch { /* ignore */ }
    return '';
  }

  function fomoHref(address, dexUrl) {
    if (typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return 'https://fomo.family/tokens/solana/' + address;
    }
    return safeHttps(dexUrl) || 'https://dexscreener.com/solana';
  }

  function cur() {
    if (!market.length) return null;
    return market.find(m => m.address === sel) || market[0];
  }

  function renderFeed() {
    const nf = S.feed.filter(f => f.id > renderedUntil);
    if (!nf.length) return;
    renderedUntil = nf[nf.length - 1].id;
    for (const f of nf) {
      const [ic, col] = BOTS[f.bot] || ['🤖', '#444'];
      const d = document.createElement('div');
      d.className = 'msg';
      const verdict = f.verdict && ['BUY', 'WAIT', 'PASS'].includes(f.verdict) ? f.verdict : '';
      const text = verdict ? esc(f.text).replace(esc(verdict), `<span class="v ${verdict}">${esc(verdict)}</span>`) : esc(f.text);
      const tone = f.kind === 'win' ? 'g' : f.kind === 'loss' ? 'r' : '';
      d.innerHTML = `<div class="ic" style="background:${col}">${ic}</div><div><b>${esc(f.bot)}</b><span class="tm">${new Date(f.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span><div class="${tone}">${text}</div></div>`;
      $('feed').prepend(d);
    }
    while ($('feed').children.length > 150) $('feed').lastChild.remove();
  }

  function render() {
    const t = cur();
    if (t) {
      sel = t.address;
      $('tav').src = t.img || '';
      $('tname').textContent = t.name + ' ($' + t.symbol + ')';
      $('tmc').textContent = 'MC ' + k(t.mcap) + ' · ' + (t.ch5 >= 0 ? '+' : '') + t.ch5.toFixed(1) + '% 5m';
      $('tprice').textContent = '$' + fp(t.price);
      $('aname').textContent = '$' + t.symbol;
      $('fomo').href = fomoHref(t.address, t.url);
      $('fomo').title = 'In Fomo öffnen: ' + t.symbol;
      const p = S.positions.find(x => x.address === t.address);
      if (p) {
        const v = p.qty * t.price, pn = v - p.cost;
        $('posv').textContent = usd(v);
        $('pospnl').innerHTML = `<span class="${pn >= 0 ? 'g' : 'r'}">${pn >= 0 ? '+' : ''}${usd(pn)} (${(p.cost ? pn / p.cost * 100 : 0).toFixed(1)}%)</span> · TP $${fp(p.tp)} · SL $${fp(p.sl)}`;
      } else {
        $('posv').textContent = '$0.00';
        $('pospnl').textContent = 'keine Position';
      }
      const dex = safeHttps(t.url);
      $('stats').innerHTML = [
        ['Liquidität', k(t.liq)],
        ['Volumen 5m / 24h', k(t.vol5) + ' / ' + k(t.vol24)],
        ['Buys vs Sells 5m', `<span class=g>${t.buys5}</span> / <span class=r>${t.sells5}</span>`],
        ['Txns 1h', t.buys1 + t.sells1],
        ['Change 1h / 24h', `<span class=${t.ch1 >= 0 ? 'g' : 'r'}>${t.ch1}%</span> / <span class=${t.ch24 >= 0 ? 'g' : 'r'}>${t.ch24}%</span>`],
        ['Alter Pair', t.ageMin > 2000 ? (t.ageMin / 1440).toFixed(0) + ' Tage' : t.ageMin.toFixed(0) + ' Min']
      ].map(x => `<div><span class=mut>${x[0]}</span><b>${x[1]}</b></div>`).join('')
        + (dex ? `<div style="grid-column:span 2"><a href="${esc(dex)}" target="_blank" rel="noopener noreferrer" style="color:#2b9cff">auf DexScreener öffnen ↗</a></div>` : '');
      $('list').innerHTML = market.slice(0, 25).map(m => `<div data-a="${esc(m.address)}" class="${m.address === sel ? 'act' : ''}"><span>${S.positions.some(p => p.address === m.address) ? '● ' : ''}<b>${esc(m.symbol)}</b> <span class=mut>${k(m.mcap)}</span></span><span class=${m.ch5 >= 0 ? 'g' : 'r'}>${m.ch5 >= 0 ? '+' : ''}${m.ch5.toFixed(1)}%</span></div>`).join('');
    }

    const eq = equity();
    $('bal').textContent = usd(eq);
    $('bal').className = 'big ' + (eq >= S.start ? 'g' : 'r');
    $('bankst').textContent = `BANK · started ${usd(S.start)} · Cash ${usd(S.cash)}`;
    const gr = S.trades.filter(x => x.pnl >= 0).length;
    const worst = Math.min(0, ...S.trades.map(x => x.pnl));
    $('tsum').textContent = `${S.trades.length} trades · ${gr} green ${S.trades.length - gr} red · worst ${usd(worst)}`;
    $('open').innerHTML = S.positions.map(p => {
      const pn = p.qty * p.last - p.cost;
      return `<div class=tr><span>OPEN <b>${esc(p.symbol)}</b> <span class=mut>${usd(p.cost)} · ${esc(p.by)}</span></span><span class=${pn >= 0 ? 'g' : 'r'}>${pn >= 0 ? '+' : ''}${usd(pn)}</span></div>`;
    }).join('');
    $('trades').innerHTML = S.trades.slice().reverse().map(x => `<div class=tr><span>#${x.n} <b>${esc(x.symbol)}</b> <span class=mut>${esc(x.reason)}</span></span><span class=${x.pnl >= 0 ? 'g' : 'r'}>${x.pnl >= 0 ? '+' : ''}${usd(x.pnl)} (${x.pct.toFixed(1)}%)</span></div>`).join('');
    $('sw').className = 'sw' + (S.auto ? ' on' : '');
    $('upd').textContent = lastRun ? 'Update ' + new Date(lastRun).toLocaleTimeString('de-DE') : 'lade…';
    $('cards').innerHTML = S.pending.map(p => {
      const href = fomoHref(p.address, '');
      return `<div class="card"><div><span class="v BUY">SKEPTIKER: BUY</span> <b>$${esc(p.symbol)}</b> · ${usd(p.size)} Papiergeld</div><div class="mut">${esc(p.why)} Entry $${fp(p.plan.entry)} · TP +${p.plan.tpPct.toFixed(0)}% · SL -${p.plan.slPct.toFixed(0)}%</div><div class="row"><button class="btn ok" type="button" data-act="ok" data-id="${Number(p.id)}">Freigeben</button><button class="btn no" type="button" data-act="no" data-id="${Number(p.id)}">Ablehnen</button><a class="btn fomo" href="${href}" target="_blank" rel="noopener noreferrer">In Fomo öffnen</a></div></div>`;
    }).join('');
    renderFeed();
  }

  function approve(id, ok) {
    const pr = S.pending.find(p => p.id === id);
    S.pending = S.pending.filter(p => p.id !== id);
    if (pr) {
      const tt = market.find(m => m.address === pr.address);
      if (ok && tt) open(tt, pr.size, 'Freigegeben', pr.plan);
      else if (!ok) say('Skeptiker', `${pr.symbol} abgelehnt. Gut, nächste.`);
    }
    persist();
    render();
  }

  function buy(address, share) {
    const t = market.find(m => m.address === address);
    if (!t) return;
    const sz = S.cash * Math.min(1, share || 0.1);
    if (open(t, sz, 'Manuell')) say('Risk', `Manueller Kauf ${t.symbol}. Stop -12% gilt trotzdem.`, { kind: 'risk' });
    persist();
    render();
  }

  function sell(address, share) {
    const p = S.positions.find(x => x.address === address);
    if (!p) return;
    const t = market.find(m => m.address === address);
    if (t) p.last = t.price;
    close(p, share || 1, 'Manuell');
    persist();
    render();
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await runTick();
    } catch (e) {
      console.error(e);
    } finally {
      ticking = false;
      persist();
      render();
      loadCandles();
    }
  }

  const mini = mk('mini', 120, false);
  const big = mk('chart', 280, true);

  function mk(el, h, vol) {
    const node = $(el);
    const c = LightweightCharts.createChart(node, {
      height: h,
      width: node.clientWidth || 300,
      layout: { background: { color: 'transparent' }, textColor: '#777', fontFamily: 'Inter' },
      grid: { vertLines: { color: '#141414' }, horzLines: { color: '#141414' } },
      timeScale: { timeVisible: true, borderColor: '#222' },
      rightPriceScale: { borderColor: '#222' },
      crosshair: { mode: 0 }
    });
    const cs = c.addCandlestickSeries({
      upColor: '#21e07a', downColor: '#ff4d5e', borderVisible: false,
      wickUpColor: '#21e07a', wickDownColor: '#ff4d5e',
      priceFormat: { type: 'price', precision: 8, minMove: 1e-8 }
    });
    let v = null, ma = null;
    if (vol) {
      v = c.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' } });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      ma = c.addLineSeries({ color: '#ffb020', lineWidth: 1, priceLineVisible: false });
    }
    new ResizeObserver(() => c.applyOptions({ width: node.clientWidth })).observe(node);
    return { c, cs, v, ma };
  }

  async function loadCandles() {
    const t = cur();
    if (!t || !t.pool) return;
    let d;
    try { d = await candles(t.pool); }
    catch (e) { console.warn('candles', e); return; }
    if (!Array.isArray(d) || !d.length) return;
    if (cur()?.pool !== t.pool) return;
    mini.cs.setData(d.slice(-50));
    big.cs.setData(d);
    big.v.setData(d.map(x => ({ time: x.time, value: x.volume || 0, color: x.close >= x.open ? '#21e07a55' : '#ff4d5e55' })));
    big.ma.setData(d.map((x, i) => i < 19 ? null : { time: x.time, value: d.slice(i - 19, i + 1).reduce((a, b) => a + b.close, 0) / 20 }).filter(Boolean));
    if (lastPool !== t.pool) {
      mini.c.timeScale().fitContent();
      big.c.timeScale().fitContent();
      lastPool = t.pool;
    }
    window.__desk.candlePoints = d.length;
    window.__desk.candlePool = t.pool;
  }

  $('list').onclick = e => {
    const d = e.target.closest('[data-a]');
    if (!d) return;
    sel = d.dataset.a;
    render();
    loadCandles();
  };
  $('pcts').onclick = e => {
    if (!e.target.dataset.p) return;
    pct = +e.target.dataset.p;
    [...$('pcts').children].forEach(b => b.classList.toggle('sel', b === e.target));
  };
  $('cards').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    approve(Number(b.dataset.id), b.dataset.act === 'ok');
  });
  $('auto').onclick = () => {
    S.auto = !S.auto;
    say('System', `Auto-Modus ${S.auto ? 'AN — Skeptiker-BUYs werden automatisch (Papiergeld) ausgeführt' : 'AUS — du gibst frei'}.`);
    persist();
    render();
  };
  $('reset').onclick = () => {
    if (!confirm('Bank auf $300 Papiergeld zurücksetzen?')) return;
    S = fresh();
    renderedUntil = 0;
    $('feed').innerHTML = '';
    say('System', 'Bank zurückgesetzt auf $300.00 Papiergeld.');
    persist();
    render();
  };

  function slider(id, fn) {
    const s = $(id), kn = s.querySelector('.knob');
    let x0 = null;
    kn.onpointerdown = e => { x0 = e.clientX; kn.setPointerCapture(e.pointerId); };
    kn.onpointermove = e => {
      if (x0 === null) return;
      const m = s.clientWidth - 54;
      kn.style.left = Math.max(5, Math.min(m, 5 + e.clientX - x0)) + 'px';
    };
    const end = () => {
      const done = parseFloat(kn.style.left || 5) >= s.clientWidth - 60;
      x0 = null;
      kn.style.left = '5px';
      if (done) fn();
    };
    kn.onpointerup = end;
    kn.onpointercancel = () => { x0 = null; kn.style.left = '5px'; };
  }
  slider('sbuy', () => buy(sel, pct));
  slider('ssell', () => sell(sel, pct));

  window.__desk = {
    tick,
    approve,
    candlePoints: 0,
    candlePool: null,
    snapshot() {
      return {
        cash: S.cash,
        equity: equity(),
        positions: S.positions.map(p => ({ symbol: p.symbol, address: p.address, cost: p.cost, by: p.by, qty: p.qty })),
        pending: S.pending.map(p => ({ id: p.id, symbol: p.symbol, address: p.address, size: p.size })),
        feed: S.feed.map(f => ({ bot: f.bot, text: f.text, verdict: f.verdict || null })),
        market: market.length,
        auto: S.auto,
        lastRun,
        paper: true
      };
    }
  };

  if (!S.feed.length) say('System', 'Desk online. PAPIERGELD / SIMULATION — keine Wallet, kein echtes Geld.');
  persist();
  render();
  tick();
  setInterval(tick, TICK_MS);
  setInterval(loadCandles, CANDLE_TTL);
})();
