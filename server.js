// ═══════════════════════════════════════════════════════════════════
// TeleBot Creator — Server (Render.com)
// Deploy this on render.com as a Web Service
//
// Environment variables to set on Render:
//   SERVER_KEY=your-secret-key-here   (any random string)
//   PORT=3000                          (Render sets this automatically)
//
// Build Command: npm install
// Start Command: node server.js
// ═══════════════════════════════════════════════════════════════════

const express    = require('express');
const TelegramBot= require('node-telegram-bot-api');
const app        = express();

app.use(express.json({ limit: '10mb' }));

// ── CORS (allow requests from any origin) ────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-server-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
const SERVER_KEY = process.env.SERVER_KEY || 'tc-server-key';
function auth(req, res, next) {
  if (req.headers['x-server-key'] !== SERVER_KEY) {
    return res.status(401).json({ error: 'Unauthorized — check SERVER_KEY' });
  }
  next();
}

// ── Storage ───────────────────────────────────────────────────────────────────
const runningBots = new Map(); // botId → { bot, startedAt }
const botLogs     = new Map(); // botId → [{ts, time, type, text}]
const botVars     = new Map(); // botId:chatId → {k:v}   (local)
const groupVars   = new Map(); // botId:chatId → {k:v}   (group)
const globalVars  = new Map(); // botId → {k:v}           (global)
const waiting     = new Map(); // uid:chatId → {resolve, timer, varName}

function addLog(botId, text, type='sys') {
  const logs = botLogs.get(botId) || [];
  logs.push({ ts: Date.now(), time: new Date().toLocaleTimeString(), type, text });
  if (logs.length > 300) logs.splice(0, logs.length - 300);
  botLogs.set(botId, logs);
}

// ── Variable helpers ──────────────────────────────────────────────────────────
function getVar(botId, chatId, name, type='local') {
  if (!name) return '';
  if (type === 'global') return (globalVars.get(botId)||{})[name] ?? '';
  if (type === 'group')  return (groupVars.get(botId+':'+chatId)||{})[name] ?? '';
  return (botVars.get(botId+':'+chatId)||{})[name] ?? '';
}
function setVar(botId, chatId, name, value, type='local') {
  if (!name) return;
  if (type === 'global') {
    const m = globalVars.get(botId) || {};
    m[name] = value; globalVars.set(botId, m); return;
  }
  if (type === 'group') {
    const key = botId+':'+chatId;
    const m = groupVars.get(key) || {};
    m[name] = value; groupVars.set(key, m); return;
  }
  const key = botId+':'+chatId;
  const m = botVars.get(key) || {};
  m[name] = value; botVars.set(key, m);
}
function sub(botId, chatId, msgCtx, text) {
  const local  = botVars.get(botId+':'+chatId) || {};
  const grp    = groupVars.get(botId+':'+chatId) || {};
  const global = globalVars.get(botId) || {};
  const ctx = {
    first_name: msgCtx?.from?.first_name || '',
    last_name:  msgCtx?.from?.last_name  || '',
    username:   msgCtx?.from?.username   || '',
    user_id:    String(msgCtx?.from?.id  || ''),
    chat_id:    String(chatId),
    text:       msgCtx?.text || '',
    date:       new Date().toLocaleDateString(),
    message_id: String(msgCtx?.message_id || ''),
    callback_data: msgCtx?.callback_data || '',
  };
  const all = {...ctx, ...local, ...grp, ...global};
  return String(text||'').replace(/\{\{(\w+)\}\}/g, (_, k) => all[k] ?? '');
}
function sleep(ms) { return new Promise(r => setTimeout(r, parseInt(ms)||0)); }

// ── Run a single flow ──────────────────────────────────────────────────────────
async function runFlow(botId, bot, msg, flow, allFlows) {
  const chatId   = msg.chat?.id;
  const blocks   = flow.blocks || [];
  let   lastMsgId= msg.message_id;

  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const c = b.config || {};
    const s = (t) => sub(botId, chatId, msg, t);

    try {
      switch (b.type) {
        case 'send_text': {
          const opts = {};
          if (c.parse_mode) opts.parse_mode = c.parse_mode;
          if (c.no_preview) opts.disable_web_page_preview = true;
          if (c.buttons?.length) opts.reply_markup = buildKb(c.buttons, allFlows);
          const r = await bot.sendMessage(chatId, s(c.text||''), opts);
          lastMsgId = r.message_id;
          addLog(botId, '📤 '+s(c.text||'').substring(0,40), 'out'); break;
        }
        case 'send_img':   await bot.sendPhoto(chatId, s(c.url||''), {caption:s(c.caption||'')}); break;
        case 'send_vid':   await bot.sendVideo(chatId, s(c.url||'')); break;
        case 'send_audio': await bot.sendAudio(chatId, s(c.url||'')); break;
        case 'send_doc':   await bot.sendDocument(chatId, s(c.url||'')); break;
        case 'edit_msg': {
          const mid = c.target==='user'?msg.message_id:c.target==='id'?parseInt(c.msg_id):lastMsgId;
          await bot.editMessageText(s(c.text||''), {chat_id:chatId,message_id:mid}); break;
        }
        case 'del_msg': {
          const mid = c.target==='user'?msg.message_id:c.target==='id'?parseInt(c.msg_id):lastMsgId;
          await bot.deleteMessage(chatId, mid).catch(()=>{}); break;
        }
        case 'pin_msg': {
          const mid = c.target==='user'?msg.message_id:c.target==='id'?parseInt(c.msg_id):lastMsgId;
          await bot.pinChatMessage(chatId, mid, {disable_notification:!!c.silent}).catch(()=>{}); break;
        }
        case 'forward':
          await bot.forwardMessage(s(c.to||String(chatId)), chatId, lastMsgId); break;
        case 'inline_kb': {
          const kb = buildKb(c.buttons, allFlows);
          const opts = {reply_markup: {inline_keyboard: kb?.inline_keyboard || []}};
          if (c.parse_mode) opts.parse_mode = c.parse_mode;
          const r = await bot.sendMessage(chatId, s(c.text||''), opts);
          lastMsgId = r.message_id; break;
        }
        case 'reply_kb': {
          const rows = (c.buttons||[]).map(r=>(r||[]).map(b=>({text:b.text||''})));
          await bot.sendMessage(chatId, s(c.text||'⌨'), {reply_markup:{keyboard:rows,resize_keyboard:!!c.resize,one_time_keyboard:!!c.one_time}}); break;
        }
        case 'remove_kb':
          await bot.sendMessage(chatId, '​', {reply_markup:{remove_keyboard:true}}); break;
        case 'delay':
          await sleep(parseInt(c.ms)||1000); break;
        case 'set_var':
          setVar(botId, chatId, c.var_name||c.name||'', s(c.val||''), c.var_type||'local'); break;
        case 'var_math': {
          const cur = getVar(botId, chatId, c.var_name||'', c.var_type||'local');
          const val = s(c.value||'1');
          let res;
          switch(c.operation||'+') {
            case '+': res=(parseFloat(cur)||0)+(parseFloat(val)||0); break;
            case '-': res=(parseFloat(cur)||0)-(parseFloat(val)||0); break;
            case '*': res=(parseFloat(cur)||0)*(parseFloat(val)||1); break;
            case '/': res=parseFloat(val)?((parseFloat(cur)||0)/parseFloat(val)):cur; break;
            case '%': res=parseFloat(val)?((parseFloat(cur)||0)%parseFloat(val)):cur; break;
            case 'set': res=val; break;
            case 'concat':  res=String(cur)+val; break;
            case 'prepend': res=val+String(cur); break;
            default: res=val;
          }
          setVar(botId, chatId, c.var_name||'', String(res), c.var_type||'local'); break;
        }
        case 'if_else': {
          const vv = String(getVar(botId, chatId, (c.var||'').replace(/[{}]/g,''), c.var_type||'local'));
          const cv = s(c.val||'');
          const pass = c.op==='='?vv===cv:c.op==='!='?vv!==cv:c.op==='contains'?vv.includes(cv):c.op==='startsWith'?vv.startsWith(cv):c.op==='>'?+vv>+cv:c.op==='<'?+vv<+cv:false;
          if (!pass) return; break;
        }
        case 'wait_input': {
          const wkey = String(msg.from?.id||chatId)+':'+String(chatId);
          const answer = await new Promise((resolve) => {
            const timer = c.timeout && parseInt(c.timeout)>0
              ? setTimeout(() => { waiting.delete(wkey); resolve(s(c.timeout_msg||'Time is up!')); }, parseInt(c.timeout)*1000)
              : null;
            waiting.set(wkey, { resolve, timer, varName: c.save_to||'input' });
          });
          setVar(botId, chatId, c.save_to||'input', answer, 'local'); break;
        }
        case 'jump': {
          const target = allFlows.find(f=>f.id===c.flow);
          if (target) await runFlow(botId, bot, msg, target, allFlows);
          return;
        }
        case 'group_only':
          if (!['group','supergroup'].includes(msg.chat?.type)) { addLog(botId,'🚫 Not a group','sys'); return; } break;
        case 'private_only':
          if (msg.chat?.type !== 'private') { addLog(botId,'🚫 Not private','sys'); return; } break;
        case 'if_admin': {
          if (!['group','supergroup'].includes(msg.chat?.type)) break;
          const r = await bot.getChatMember(chatId, msg.from?.id).catch(()=>null);
          if (!['creator','administrator'].includes(r?.status)) { addLog(botId,'🛡 Not admin','sys'); return; } break;
        }
        case 'if_not_admin': {
          if (!['group','supergroup'].includes(msg.chat?.type)) break;
          const r = await bot.getChatMember(chatId, msg.from?.id).catch(()=>null);
          if (['creator','administrator'].includes(r?.status)) { addLog(botId,'🛡 Is admin — stop','sys'); return; } break;
        }
        case 'ban':
          if (!['group','supergroup'].includes(msg.chat?.type)) break;
          await bot.banChatMember(chatId, msg.from?.id).catch(()=>{});
          addLog(botId,'🚫 Banned','out'); break;
        case 'kick':
          if (!['group','supergroup'].includes(msg.chat?.type)) break;
          await bot.banChatMember(chatId, msg.from?.id).catch(()=>{});
          await sleep(300);
          await bot.unbanChatMember(chatId, msg.from?.id).catch(()=>{});
          addLog(botId,'👢 Kicked','out'); break;
        case 'mute':
          if (!['group','supergroup'].includes(msg.chat?.type)) break;
          await bot.restrictChatMember(chatId, msg.from?.id, {permissions:{can_send_messages:false}}).catch(()=>{});
          addLog(botId,'🔇 Muted','out'); break;
        case 'unmute':
          await bot.restrictChatMember(chatId, msg.from?.id, {permissions:{can_send_messages:true,can_send_media_messages:true,can_send_polls:true,can_send_other_messages:true}}).catch(()=>{});
          addLog(botId,'🔊 Unmuted','out'); break;
        case 'del_user_msg':
          if (msg.message_id) await bot.deleteMessage(chatId, msg.message_id).catch(()=>{}); break;
        case 'http': {
          const opts = {method: c.method||'GET'};
          if (c.headers) try { opts.headers = JSON.parse(c.headers); } catch(_) {}
          if (c.body) opts.body = s(c.body);
          const res = await fetch(s(c.url||''), opts);
          const text = await res.text();
          if (c.save_to) setVar(botId, chatId, c.save_to, text, 'local');
          addLog(botId,'🔗 HTTP '+res.status,'sys'); break;
        }
        case 'random': {
          let result;
          if (c.mode==='choice') {
            const items=(c.items||'').split(',').map(x=>x.trim()).filter(Boolean);
            result=items.length?items[Math.floor(Math.random()*items.length)]:'';
          } else {
            const mn=parseInt(c.min||'1'),mx=parseInt(c.max||'100');
            result=String(Math.floor(Math.random()*(mx-mn+1))+mn);
          }
          setVar(botId, chatId, c.save_to||'random', result, c.var_type||'local');
          addLog(botId,'🎲 Random: '+result,'sys'); break;
        }

        // ── PAYMENT BLOCKS ───────────────────────────────────────────────────
        case 'stars_payment': {
          await bot.sendInvoice(chatId, s(c.title||'Premium'), s(c.description||'Premium 30 days'), c.payload||'premium_30', '', 'XTR', [{label:'Premium',amount:parseInt(c.amount||100)}]);
          addLog(botId,'⭐ Stars invoice sent','out'); break;
        }
        case 'check_payment': {
          const payment = msg.successful_payment;
          const ok = payment && (!c.payload || payment.invoice_payload===c.payload);
          if (c.save_to) setVar(botId, chatId, c.save_to, ok?'ok':'fail', 'local');
          addLog(botId, ok?'✅ Payment verified':'❌ No payment','sys');
          if (!ok) return; break;
        }
        case 'send_receipt': {
          const code=(c.prefix||'TC')+'-'+Math.random().toString(36).slice(2,6).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
          if (c.save_to) setVar(botId, chatId, c.save_to, code, 'local');
          if (c.send_to_user!==false) {
            const text = s((c.text||'🧾 Your receipt: {{receipt}}').replace('{{receipt}}', code));
            await bot.sendMessage(chatId, text, {parse_mode:'HTML'});
          }
          addLog(botId,'🧾 Receipt: '+code,'out'); break;
        }

        case 'custom_script': {
          const code = (c.code||'').trim();
          if (!code) break;
          try {
            const AsyncFunc = Object.getPrototypeOf(async function(){}).constructor;
            const fn = new AsyncFunc(
              'bot','chatId','msg','sub','setVar','getVar','sleep','fetch','log',
              code
            );
            await fn(
              bot, chatId, msg,
              (t) => s(t),
              (k,v,t='local') => setVar(botId,chatId,k,v,t),
              (k,t='local')   => getVar(botId,chatId,k,t),
              sleep,
              fetch,
              (text,type='sys') => addLog(botId,'📜 '+text,type)
            );
          } catch(e) { addLog(botId,'⚠ Script error: '+e.message,'err'); }
          break;
        }

        default: break;
      }
    } catch(e) {
      addLog(botId, `⚠ Block ${b.type}: ${e.message}`, 'err');
    }
  }
}

// ── Match message to flow ──────────────────────────────────────────────────────
async function matchFlow(botId, chatId, msg, flows) {
  for (const flow of flows) {
    const blocks = flow.blocks||[];
    if (!blocks.length) continue;
    const t = blocks[0];
    switch(t.type) {
      case 'cmd': {
        const cmd='/'+( t.config?.cmd||'');
        if (msg.text===cmd||msg.text?.startsWith(cmd+' ')) return flow; break;
      }
      case 'on_text': {
        const txt=msg.text||'';
        const ptns=t.config?.patterns||[{match:t.config?.match||'',mode:'contains'}];
        const hit=ptns.some(p=>{
          const m=p.match||'',mode=p.mode||'contains';
          if(!m) return false;
          return mode==='contains'?txt.includes(m):mode==='equals'?txt===m:mode==='starts'?txt.startsWith(m):mode==='ends'?txt.endsWith(m):mode==='regex'?(()=>{try{return new RegExp(m).test(txt)}catch(_){return false}})():false;
        });
        if(hit) return flow; break;
      }
      case 'on_photo': if(msg.photo?.length) return flow; break;
      case 'on_doc':   if(msg.document)      return flow; break;
      case 'on_var': {
        const c=t.config||{};
        const vv=String(getVar(botId,chatId,c.var_name||'',c.var_type||'local'));
        const cv=c.val||'';
        const hit=c.op==='='?vv===cv:c.op==='!='?vv!==cv:c.op==='contains'?vv.includes(cv):c.op==='>'?+vv>+cv:c.op==='<'?+vv<+cv:false;
        if(hit) return flow; break;
      }
      case 'on_payment':
        // This trigger is handled separately in the successful_payment block above
        break;
      case 'on_username': {
        const c=t.config||{};
        const uname=(msg.from?.username||'').toLowerCase();
        const target=(c.username||'').toLowerCase().replace(/^@/,'');
        const mode=c.mode||'equals';
        const hit=mode==='list'?target.split(',').map(s=>s.trim()).includes(uname):mode==='contains'?uname.includes(target):uname===target;
        if(hit) return flow; break;
      }
    }
  }
  return null;
}

function buildKb(buttons, flows) {
  if (!buttons?.length) return null;
  const rows = (buttons).map(row=>(row||[]).map(btn=>{
    if(btn.btype==='url')  return {text:btn.text||'',url:btn.url||''};
    if(btn.btype==='flow') return {text:btn.text||'',callback_data:'__flow__'+(btn.flow_id||btn.flow||'')};
    return {text:btn.text||'',callback_data:btn.callback_data||btn.text||'btn'};
  })).filter(r=>r.length);
  return rows.length ? {inline_keyboard:rows} : null;
}

// ── API Routes ────────────────────────────────────────────────────────────────

// Health check
app.get('/api/ping', auth, (req, res) => {
  res.json({ ok: true, version: '1.0', bots: runningBots.size });
});

// Start bot
app.post('/api/start', auth, async (req, res) => {
  const { botId, token, flows, vars } = req.body;
  if (!botId || !token) return res.status(400).json({ error: 'Missing botId or token' });

  // Stop existing
  if (runningBots.has(botId)) {
    try { runningBots.get(botId).bot.stopPolling(); } catch(_) {}
    runningBots.delete(botId);
  }

  try {
    const bot = new TelegramBot(token, { polling: true });
    botLogs.set(botId, []);
    addLog(botId, '✅ Bot started on server', 'sys');

    const allFlows = flows || [];

    // ── pre_checkout_query (CRITICAL for Stars payments) ─────────────────────
    bot.on('pre_checkout_query', async (query) => {
      addLog(botId, '💳 Pre-checkout: '+query.invoice_payload, 'sys');
      await bot.answerPreCheckoutQuery(query.id, true).catch(e=>addLog(botId,'⚠ Pre-checkout error: '+e.message,'err'));
    });

    // ── Messages ──────────────────────────────────────────────────────────────
    bot.on('message', async (msg) => {
      if (!msg.from) return; // skip channel posts
      const chatId = msg.chat.id;
      const name = msg.from.first_name || msg.from.username || String(msg.from.id);
      const chatLabel = msg.chat.type==='private'?'💬 ЛС':'👥 '+(msg.chat.title||'group');
      addLog(botId, `📩 [${chatLabel}] ${name}: ${msg.text||'[media]'}`, 'in');

      // Check waiting for input
      const wkey = String(msg.from.id)+':'+String(chatId);
      if (waiting.has(wkey)) {
        const p = waiting.get(wkey);
        clearTimeout(p.timer);
        waiting.delete(wkey);
        setVar(botId, chatId, p.varName, msg.text||'', 'local');
        if (p.resolve) p.resolve(msg.text||'');
        return;
      }

      // Handle successful_payment
      if (msg.successful_payment) {
        const payload = msg.successful_payment.invoice_payload;
        addLog(botId, '💰 Payment received! payload: '+payload, 'sys');
        // Look for on_payment trigger (any payload or matching payload)
        const payFlow = allFlows.find(f=>{
          const t=f.blocks?.[0];
          if (t?.type==='on_payment') {
            // Match if no payload filter, or payload matches
            return !t.config?.payload || t.config.payload===payload;
          }
          // Fallback: old on_cb style
          return t?.type==='on_cb' && t?.config?.data===payload;
        });
        if (payFlow) {
          addLog(botId, '⚡ Running payment flow: '+payFlow.name, 'sys');
          await runFlow(botId, bot, msg, payFlow, allFlows);
        } else {
          addLog(botId, '⚠ No flow found for payload: '+payload+'. Create a flow with "Payment received ⭐" trigger!', 'err');
        }
        return;
      }

      const flow = await matchFlow(botId, chatId, msg, allFlows);
      if (flow) {
        addLog(botId, '⚡ Flow: '+flow.name, 'sys');
        await runFlow(botId, bot, msg, flow, allFlows).catch(e=>addLog(botId,'⚠ Flow error: '+e.message,'err'));
      }
    });

    // ── Callback queries ──────────────────────────────────────────────────────
    bot.on('callback_query', async (query) => {
      const msg = {...query.message, from: query.from, callback_data: query.data};
      const chatId = msg.chat.id;
      await bot.answerCallbackQuery(query.id).catch(()=>{});

      // Direct flow buttons
      if (query.data?.startsWith('__flow__')) {
        const flowId = query.data.replace('__flow__','');
        const target = allFlows.find(f=>f.id===flowId);
        if (target) await runFlow(botId, bot, msg, target, allFlows).catch(e=>addLog(botId,'⚠ '+e.message,'err'));
        return;
      }

      const flow = allFlows.find(f=>f.blocks?.[0]?.type==='on_cb'&&f.blocks[0]?.config?.data===query.data);
      if (flow) {
        addLog(botId, '⚡ Callback: '+query.data, 'sys');
        await runFlow(botId, bot, msg, flow, allFlows).catch(e=>addLog(botId,'⚠ '+e.message,'err'));
      }
    });

    // ── Group events ──────────────────────────────────────────────────────────
    bot.on('new_chat_members', async (msg) => {
      const flow = allFlows.find(f=>f.blocks?.[0]?.type==='on_join');
      if (flow) await runFlow(botId, bot, msg, flow, allFlows).catch(()=>{});
    });
    bot.on('left_chat_member', async (msg) => {
      const flow = allFlows.find(f=>f.blocks?.[0]?.type==='on_leave');
      if (flow) await runFlow(botId, bot, msg, flow, allFlows).catch(()=>{});
    });

    bot.on('polling_error', (e) => addLog(botId, '⚠ Polling: '+e.message, 'err'));

    runningBots.set(botId, { bot, startedAt: Date.now() });
    res.json({ ok: true, message: 'Bot started' });

  } catch(e) {
    addLog(botId, '❌ Start failed: '+e.message, 'err');
    res.status(500).json({ error: e.message });
  }
});

// Stop bot
app.post('/api/stop', auth, (req, res) => {
  const { botId } = req.body;
  if (runningBots.has(botId)) {
    try { runningBots.get(botId).bot.stopPolling(); } catch(_) {}
    runningBots.delete(botId);
    addLog(botId, '⛔ Bot stopped', 'sys');
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Bot not running' });
  }
});

// Status
app.get('/api/status/:botId', auth, (req, res) => {
  const data = runningBots.get(req.params.botId);
  res.json({ running: !!data, startedAt: data?.startedAt || null });
});

// Logs
app.get('/api/logs/:botId', auth, (req, res) => {
  const since = parseInt(req.query.since || '0');
  const logs   = (botLogs.get(req.params.botId) || []).filter(l => l.ts > since);
  res.json({ logs });
});

// List all running bots
app.get('/api/bots', auth, (req, res) => {
  const bots = [...runningBots.entries()].map(([id, data]) => ({
    id, startedAt: data.startedAt, logs: (botLogs.get(id)||[]).length
  }));
  res.json({ bots });
});

// Root — health page
app.get('/', (req, res) => {
  res.send(`
    <h2>🤖 TeleBot Creator Server</h2>
    <p>Running ${runningBots.size} bot(s)</p>
    <p>Connect from Telebot Creator → ☁️ Server button</p>
    <p>Server Key: set <code>SERVER_KEY</code> environment variable on Render</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TeleBot Creator Server running on port ${PORT}`);
  console.log(`SERVER_KEY: ${SERVER_KEY}`);
});
