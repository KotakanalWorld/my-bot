// ═══════════════════════════════════════════════════════════
// TeleBot Creator — Server v2 (Render.com)
// Simple, no database required!
//
// Deploy on Render.com:
// 1. Upload this file + package.json to GitHub
// 2. Create Web Service on render.com → connect GitHub repo
// 3. Build: npm install | Start: node server.js
// 4. Add environment variable: SERVER_KEY = any secret password
// ═══════════════════════════════════════════════════════════

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','Content-Type,x-server-key');
  res.header('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(200);
  next();
});

// Auth
const SERVER_KEY = process.env.SERVER_KEY || 'tc-key-xd117doh';
const auth = (req,res,next) => {
  if(req.headers['x-server-key']!==SERVER_KEY) return res.status(401).json({error:'Wrong key'});
  next();
};

// Storage (in-memory, resets on restart)
const bots    = new Map(); // botId → {bot, startedAt}
const logs    = new Map(); // botId → [{ts,time,type,text}]
const lVars   = new Map(); // botId:chatId → {k:v}
const gVars   = new Map(); // botId → {k:v}
const grpVars = new Map(); // botId:chatId → {k:v}
const waiting = new Map(); // uid:chatId → {resolve,timer}
const groqCtx = new Map(); // key → [{role,content}]

function log(id,text,type='sys'){
  if(!logs.has(id)) logs.set(id,[]);
  const arr=logs.get(id);
  arr.push({ts:Date.now(),time:new Date().toLocaleTimeString(),type,text});
  if(arr.length>300) arr.splice(0,arr.length-300);
}
function getV(bid,cid,k,t='local'){
  if(t==='global') return (gVars.get(bid)||{})[k]??'';
  if(t==='group')  return (grpVars.get(bid+':'+cid)||{})[k]??'';
  return (lVars.get(bid+':'+cid)||{})[k]??'';
}
function setV(bid,cid,k,v,t='local'){
  if(!k) return;
  if(t==='global'){const m=gVars.get(bid)||{};m[k]=v;gVars.set(bid,m);return;}
  if(t==='group') {const m=grpVars.get(bid+':'+cid)||{};m[k]=v;grpVars.set(bid+':'+cid,m);return;}
  const m=lVars.get(bid+':'+cid)||{};m[k]=v;lVars.set(bid+':'+cid,m);
}
function sub(bid,cid,msg,text){
  const all={
    first_name:msg.from?.first_name||'',last_name:msg.from?.last_name||'',
    username:msg.from?.username||'',user_id:String(msg.from?.id||''),
    chat_id:String(cid),text:msg.text||'',date:new Date().toLocaleDateString(),
    message_id:String(msg.message_id||''),callback_data:msg.callback_data||'',
    ...(lVars.get(bid+':'+cid)||{}),...(grpVars.get(bid+':'+cid)||{}),...(gVars.get(bid)||{})
  };
  return String(text||'').replace(/\{\{(\w+)\}\}/g,(_,k)=>all[k]??'');
}
const sleep=ms=>new Promise(r=>setTimeout(r,parseInt(ms)||0));
function buildKb(buttons){
  if(!buttons?.length) return null;
  const rows=(buttons).map(row=>(row||[]).map(btn=>{
    if(btn.btype==='url') return {text:btn.text||'',url:btn.url||''};
    if(btn.btype==='flow') return {text:btn.text||'',callback_data:'__flow__'+(btn.flow_id||btn.flow||'')};
    return {text:btn.text||'',callback_data:btn.callback_data||btn.text||''};
  })).filter(r=>r.length);
  return rows.length?{inline_keyboard:rows}:null;
}

async function runFlow(bid,bot,msg,flow,allFlows){
  const chatId=msg.chat?.id;
  const s=t=>sub(bid,chatId,msg,t);
  for(let i=1;i<(flow.blocks||[]).length;i++){
    const b=flow.blocks[i];const c=b.config||{};
    try{
      switch(b.type){
        case'send_text':{
          const opts={};
          if(c.parse_mode) opts.parse_mode=c.parse_mode;
          if(c.no_preview) opts.disable_web_page_preview=true;
          const kb=buildKb(c.buttons);
          if(kb) opts.reply_markup=kb;
          await bot.sendMessage(chatId,s(c.text||''),opts);
          log(bid,'📤 '+s(c.text||'').substring(0,40),'out');break;
        }
        case'send_img':   await bot.sendPhoto(chatId,s(c.url||''),{caption:s(c.caption||'')});break;
        case'inline_kb':{ const kb=buildKb(c.buttons);await bot.sendMessage(chatId,s(c.text||'⌨'),{reply_markup:kb||{inline_keyboard:[]}});break;}
        case'reply_kb':{  const rows=(c.buttons||[]).map(r=>(r||[]).map(b=>({text:b.text||''})));await bot.sendMessage(chatId,s(c.text||'⌨'),{reply_markup:{keyboard:rows,resize_keyboard:!!c.resize}});break;}
        case'remove_kb':  await bot.sendMessage(chatId,'​',{reply_markup:{remove_keyboard:true}});break;
        case'delay':      await sleep(c.ms||1000);break;
        case'set_var':    setV(bid,chatId,c.var_name||c.name||'',s(c.val||''),c.var_type||'local');break;
        case'var_math':{
          const cur=getV(bid,chatId,c.var_name||'',c.var_type||'local');
          const val=s(c.value||'1');
          let res;
          switch(c.operation||'+'){
            case'+':res=(parseFloat(cur)||0)+(parseFloat(val)||0);break;
            case'-':res=(parseFloat(cur)||0)-(parseFloat(val)||0);break;
            case'*':res=(parseFloat(cur)||0)*(parseFloat(val)||1);break;
            case'/':res=parseFloat(val)?((parseFloat(cur)||0)/parseFloat(val)):cur;break;
            case'set':res=val;break;
            case'concat':res=String(cur)+val;break;
            case'prepend':res=val+String(cur);break;
            default:res=val;
          }
          setV(bid,chatId,c.var_name||'',String(res),c.var_type||'local');break;
        }
        case'if_else':{
          const vv=String(getV(bid,chatId,(c.var||'').replace(/[{}]/g,''),c.var_type||'local'));
          const cv=s(c.val||'');
          const ok=c.op==='='?vv===cv:c.op==='!='?vv!==cv:c.op==='contains'?vv.includes(cv):c.op==='>'?+vv>+cv:c.op==='<'?+vv<+cv:false;
          if(!ok) return;break;
        }
        case'wait_input':{
          const wk=String(msg.from?.id||chatId)+':'+String(chatId);
          const answer=await new Promise(resolve=>{
            const timer=c.timeout&&parseInt(c.timeout)>0?setTimeout(()=>{waiting.delete(wk);resolve(s(c.timeout_msg||'Time is up!'));},parseInt(c.timeout)*1000):null;
            waiting.set(wk,{resolve,timer,varName:c.save_to||'input'});
          });
          setV(bid,chatId,c.save_to||'input',answer,'local');break;
        }
        case'jump':{const t=allFlows.find(f=>f.id===c.flow);if(t)await runFlow(bid,bot,msg,t,allFlows);return;}
        case'if_admin':{
          if(!['group','supergroup'].includes(msg.chat?.type))break;
          const r=await bot.getChatMember(chatId,msg.from?.id).catch(()=>null);
          if(!['creator','administrator'].includes(r?.status)){log(bid,'🛡 Not admin — stop','sys');return;}break;
        }
        case'ban':    await bot.banChatMember(chatId,msg.from?.id).catch(()=>{});break;
        case'kick':   await bot.banChatMember(chatId,msg.from?.id).catch(()=>{});await sleep(300);await bot.unbanChatMember(chatId,msg.from?.id).catch(()=>{});break;
        case'mute':   await bot.restrictChatMember(chatId,msg.from?.id,{permissions:{can_send_messages:false}}).catch(()=>{});break;
        case'unmute': await bot.restrictChatMember(chatId,msg.from?.id,{permissions:{can_send_messages:true,can_send_media_messages:true,can_send_other_messages:true}}).catch(()=>{});break;
        case'del_user_msg': if(msg.message_id) await bot.deleteMessage(chatId,msg.message_id).catch(()=>{});break;
        case'http':{
          const opts={method:c.method||'GET'};
          if(c.headers) try{opts.headers=JSON.parse(c.headers)}catch(_){}
          if(c.body) opts.body=s(c.body);
          const res=await fetch(s(c.url||''),opts);
          const txt=await res.text();
          if(c.save_to) setV(bid,chatId,c.save_to,txt,'local');break;
        }
        case'random':{
          let result;
          if(c.mode==='choice'){const items=(c.items||'').split(',').map(x=>x.trim()).filter(Boolean);result=items.length?items[Math.floor(Math.random()*items.length)]:''}
          else{const mn=parseInt(c.min||'1'),mx=parseInt(c.max||'100');result=String(Math.floor(Math.random()*(mx-mn+1))+mn);}
          setV(bid,chatId,c.save_to||'random',result,c.var_type||'local');break;
        }
        case'stars_payment':{
          await bot.sendInvoice(chatId,s(c.title||'Premium'),s(c.description||'Premium 30 days'),c.payload||'premium_30','','XTR',[{label:'Premium',amount:parseInt(c.amount||100)}]);
          log(bid,'⭐ Stars invoice sent','out');break;
        }
        case'check_payment':{
          const payment=msg.successful_payment;
          const ok=payment&&(!c.payload||payment.invoice_payload===c.payload);
          if(c.save_to) setV(bid,chatId,c.save_to,ok?'ok':'fail','local');
          if(!ok) return;break;
        }
        case'send_receipt':{
          const code=(c.prefix||'TC')+'-'+Math.random().toString(36).slice(2,6).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
          if(c.save_to) setV(bid,chatId,c.save_to,code,'local');
          // Save to Supabase if configured
          const SB_URL=process.env.SUPABASE_URL,SB_KEY=process.env.SUPABASE_SERVICE_KEY;
          if(SB_URL&&SB_KEY){
            await fetch(SB_URL+'/rest/v1/premium_codes',{method:'POST',headers:{'Content-Type':'application/json','apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Prefer':'return=minimal'},body:JSON.stringify({code,email:'pending',granted_by:'bot_payment',expires_at:new Date(Date.now()+30*24*60*60*1000).toISOString(),used_at:null})}).catch(()=>{});
            log(bid,'✅ Code saved: '+code,'sys');
          }
          if(c.send_to_user!==false){
            const text=s((c.text||'🧾 Your receipt: {{receipt}}').replace('{{receipt}}',code));
            await bot.sendMessage(chatId,text,{parse_mode:'HTML'});
          }
          log(bid,'🧾 Receipt: '+code,'out');break;
        }
        case'groq':{
          if(!c.api_key){log(bid,'⚠ Groq: API key not set','err');break;}
          const model=c.model||'llama-3.3-70b-versatile';
          const userMsg=msg.text||'';
          const ctxMode=c.context_mode||'last';
          const ctxKey=bid+':'+String(msg.from?.id||chatId)+':'+String(chatId)+':'+(c.session_id||'default');
          log(bid,'🤖 Groq → '+model,'sys');
          const messages=[{role:'system',content:s(c.prompt||'You are a helpful assistant.')}];
          if(ctxMode==='history'){
            messages.push(...(groqCtx.get(ctxKey)||[]));
            if(userMsg.trim()) messages.push({role:'user',content:userMsg});
          } else {
            messages.push({role:'user',content:userMsg.trim()||'Hello'});
          }
          await bot.sendChatAction(chatId,'typing').catch(()=>{});
          const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+c.api_key},body:JSON.stringify({model,messages,max_tokens:parseInt(c.max_tokens||1024),temperature:parseFloat(c.temperature||1.0)})});
          const data=await res.json();
          if(!res.ok){log(bid,'⚠ Groq: '+( data.error?.message||res.status),'err');break;}
          const reply=data.choices?.[0]?.message?.content||'(no response)';
          if(ctxMode==='history'){const h=groqCtx.get(ctxKey)||[];if(userMsg.trim())h.push({role:'user',content:userMsg});h.push({role:'assistant',content:reply});while(h.length>parseInt(c.max_history||10)*2)h.splice(0,2);groqCtx.set(ctxKey,h);}
          if(c.save_to) setV(bid,chatId,c.save_to,reply,'local');
          if(c.send_response!==false) await bot.sendMessage(chatId,reply);
          log(bid,'⚡ Groq: '+reply.substring(0,60),'out');break;
        }
        case'groq_clear':{
          const prefix=bid+':'+String(msg.from?.id||chatId)+':'+String(chatId)+':';
          for(const k of groqCtx.keys()) if(k.startsWith(prefix)) groqCtx.delete(k);
          log(bid,'🗑 Groq cleared','sys');break;
        }
        case'custom_script':{
          const code=(c.code||'').trim();if(!code)break;
          const AsyncFunc=Object.getPrototypeOf(async function(){}).constructor;
          const fn=new AsyncFunc('bot','chatId','msg','sub','setVar','getVar','sleep','fetch','log',code);
          await fn(bot,chatId,msg,t=>s(t),(k,v,t='local')=>setV(bid,chatId,k,v,t),(k,t='local')=>getV(bid,chatId,k,t),sleep,fetch,(txt,type='sys')=>log(bid,'📜 '+txt,type));
          break;
        }
        default:break;
      }
    }catch(e){log(bid,'⚠ '+b.type+': '+e.message,'err');}
  }
}

async function matchFlow(bid,chatId,msg,flows){
  for(const flow of flows){
    const t=(flow.blocks||[])[0];if(!t)continue;
    switch(t.type){
      case'cmd':{const cmd='/'+(t.config?.cmd||'');if(msg.text===cmd||msg.text?.startsWith(cmd+' '))return flow;break;}
      case'on_text':{
        if(msg.from?.is_bot&&!t.config?.allow_bots)break;
        const txt=msg.text||'';
        const ptns=t.config?.patterns||[{match:t.config?.match||'',mode:'contains'}];
        if(ptns.some(p=>{const m=p.match||'',mode=p.mode||'contains';if(!m)return false;return mode==='contains'?txt.includes(m):mode==='equals'?txt===m:mode==='starts'?txt.startsWith(m):mode==='ends'?txt.endsWith(m):mode==='regex'?(()=>{try{return new RegExp(m).test(txt)}catch(_){return false}})():false;}))return flow;break;
      }
      case'on_photo': if(msg.photo?.length)return flow;break;
      case'on_doc':   if(msg.document)return flow;break;
      case'on_payment': if(msg.successful_payment&&(!t.config?.payload||t.config.payload===msg.successful_payment.invoice_payload))return flow;break;
    }
  }
  return null;
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/ping',auth,(req,res)=>res.json({ok:true,version:'2.0',bots:bots.size}));

app.post('/api/start',auth,async(req,res)=>{
  const{botId,token,flows,vars=[]}=req.body;
  if(!botId||!token) return res.status(400).json({error:'Missing botId or token'});
  if(bots.has(botId)){try{bots.get(botId).bot.stopPolling()}catch(_){}; bots.delete(botId);}
  try{
    const bot=new TelegramBot(token,{polling:true});
    logs.set(botId,[]);
    log(botId,'✅ Bot started','sys');
    const allFlows=flows||[];

    bot.on('pre_checkout_query',async q=>{
      log(botId,'💳 Pre-checkout: '+q.invoice_payload,'sys');
      await bot.answerPreCheckoutQuery(q.id,true).catch(e=>log(botId,'⚠ '+e.message,'err'));
    });

    bot.on('message',async msg=>{
      if(!msg.from) return;
      const chatId=msg.chat.id;
      log(botId,'📩 '+( msg.from.first_name||'?')+': '+(msg.text||'[media]'),'in');
      // Waiting for input
      const wk=String(msg.from.id)+':'+String(chatId);
      if(waiting.has(wk)){const p=waiting.get(wk);clearTimeout(p.timer);waiting.delete(wk);setV(botId,chatId,p.varName,msg.text||'','local');p.resolve(msg.text||'');return;}
      const flow=await matchFlow(botId,chatId,msg,allFlows);
      if(flow){log(botId,'⚡ Flow: '+flow.name,'sys');await runFlow(botId,bot,msg,flow,allFlows).catch(e=>log(botId,'⚠ '+e.message,'err'));}
    });

    bot.on('callback_query',async q=>{
      const chatId=q.message.chat.id;
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      if(q.data?.startsWith('__flow__')){const t=allFlows.find(f=>f.id===q.data.replace('__flow__',''));if(t)await runFlow(botId,bot,{...q.message,from:q.from,callback_data:q.data},t,allFlows).catch(()=>{});return;}
      const flow=allFlows.find(f=>f.blocks?.[0]?.type==='on_cb'&&f.blocks[0]?.config?.data===q.data);
      if(flow){log(botId,'⚡ CB: '+q.data,'sys');await runFlow(botId,bot,{...q.message,from:q.from,callback_data:q.data},flow,allFlows).catch(e=>log(botId,'⚠ '+e.message,'err'));}
    });

    bot.on('new_chat_members',async msg=>{const f=allFlows.find(f=>f.blocks?.[0]?.type==='on_join');if(f)await runFlow(botId,bot,msg,f,allFlows).catch(()=>{});});
    bot.on('left_chat_member',async msg=>{const f=allFlows.find(f=>f.blocks?.[0]?.type==='on_leave');if(f)await runFlow(botId,bot,msg,f,allFlows).catch(()=>{});});
    bot.on('polling_error',e=>log(botId,'⚠ Polling: '+e.message,'err'));

    bots.set(botId,{bot,startedAt:Date.now()});
    res.json({ok:true});
  }catch(e){log(botId,'❌ '+e.message,'err');res.status(500).json({error:e.message});}
});

app.post('/api/stop',auth,(req,res)=>{
  const{botId}=req.body;
  if(bots.has(botId)){try{bots.get(botId).bot.stopPolling()}catch(_){}; bots.delete(botId);log(botId,'⛔ Stopped','sys');res.json({ok:true});}
  else res.status(404).json({error:'Not running'});
});

app.get('/api/status/:botId',auth,(req,res)=>{const d=bots.get(req.params.botId);res.json({running:!!d,startedAt:d?.startedAt||null});});

app.get('/api/logs/:botId',auth,(req,res)=>{
  const since=parseInt(req.query.since||'0');
  res.json({logs:(logs.get(req.params.botId)||[]).filter(l=>l.ts>since)});
});

app.get('/',(req,res)=>res.send(`<h2>🤖 TeleBot Creator Server v2</h2><p>Running ${bots.size} bot(s)</p><p>Status: OK ✅</p>`));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`TeleBot Creator Server running on port ${PORT}`);
  console.log(`SERVER_KEY: ${SERVER_KEY}`);
  console.log(`SUPABASE_URL: ${process.env.SUPABASE_URL||'NOT SET (optional)'}`);
});
