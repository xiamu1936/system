'use strict';
const $ = selector => document.querySelector(selector);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => '¥' + (n / 100).toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2});
const value = n => (n / 100).toFixed(2);
const date = v => v ? v.slice(0,16).replace('T',' ') : '—';
const methods = '<option>微信</option><option>现金</option><option>支付宝</option><option>银行卡</option>';
let state = {products:[],orders:[],payments:[],movements:[],categories:[]}, cart = [], page = 'overview';
let range = {start:'', end:''}, scanCounts = {}, scanOrder = null, busy = false;
let keyboardCode = '', lastKeyAt = 0;
const listPages = {inventory:1, orders:1, payments:1, movements:1};
const listNames = {inventory:'商品', orders:'订单', payments:'收款', movements:'库存流水'};
function scannerFocus(selector) {
  if(!window.matchMedia('(max-width: 720px)').matches) $(selector)?.focus({preventScroll:true});
}
function configureInputs(root) {
  root.querySelectorAll('input[type="number"]').forEach(input=>{
    input.inputMode=input.step && input.step!=='1' ? 'decimal' : 'numeric';
  });
}
const requestKeys = new Map();
function cents(s) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(s))) throw Error('金额请填写非负数字，最多两位小数');
  const [whole, fraction=''] = String(s).split('.');
  const n = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(n) || n > 100000000) throw Error('金额超出范围');
  return n;
}
function number(s) {
  if (!/^\d+$/.test(String(s))) throw Error('数量请填写非负整数');
  return Number(s);
}
function notify(message, error=false) {
  if($('#dialog').open) {
    $('#dialog-notice').textContent=message;
    $('#dialog-notice').hidden=false;
  }
  $('#toast').textContent = message; $('#toast').hidden = false;
  $('#toast').classList.toggle('error',error);
  clearTimeout(notify.timer); notify.timer=setTimeout(()=>$('#toast').hidden=true,6000);
}
async function refresh() {
  const response = await fetch('/api/state');
  if (!response.ok) throw Error('无法读取账本，请检查本机服务是否运行');
  state = await response.json();
  $('#sync-time').textContent = '更新于 ' + date(state.as_of);
  $('#data-notice').textContent = (state.demo ? '演示账本 · 商品、价格、安装费均为虚构；与正式账本分开保存。' : '正式本机账本 · 数据保存在当前电脑。') + ' 收款操作只登记账目，请先确认钱已到账。';
  render();
}
async function mutate(action, payload) {
  const signature=JSON.stringify([action,payload]);
  if (!requestKeys.has(signature)) requestKeys.set(signature,crypto.randomUUID());
  const options={method:'POST',headers:{'Content-Type':'application/json','X-Store-Request':'local','Idempotency-Key':requestKeys.get(signature)},body:JSON.stringify(payload)};
  let response;
  for(let attempt=0;attempt<2;attempt++) {
    try { response=await fetch('/api/'+action,options); break; }
    catch(e) { if(attempt) throw Error('连接中断。请刷新核对；原操作再次提交会使用相同请求编号。'); }
  }
  const result=await response.json();
  if (!response.ok) {
    if(response.status < 500) requestKeys.delete(signature);
    throw Error(result.error || '操作失败');
  }
  requestKeys.delete(signature);
  return result;
}
async function work(fn) {
  if(busy) return;
  busy=true;
  const buttons=[...document.querySelectorAll('button[type="submit"],#sale-form button,#dialog-body button,#inbound-scan button')].map(b=>[b,b.disabled]);
  buttons.forEach(([b])=>b.disabled=true);
  try { await fn(); } catch(e) { notify(e.message,true); }
  finally { busy=false;buttons.forEach(([b,disabled])=>b.disabled=disabled); }
}
function formData(form) { return Object.fromEntries(new FormData(form)); }
function product(id) { return state.products.find(p=>p.id===Number(id)); }
function order(id) { return state.orders.find(o=>o.id===Number(id)); }
function fee(p) { return state.categories.find(c=>c.name===p.category)?.fee || 0; }
function table(head, rows, empty='暂无记录') {
  const labelled=rows.map(row=>{
    let index=0;
    return row.replace(/<td(\s[^>]*)?>/g,(_,attrs='')=>'<td'+attrs+' data-label="'+esc(head[index++]||'')+'">');
  });
  return '<table class="responsive-table"><thead><tr>'+head.map(h=>'<th scope="col">'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?labelled.join(''):'<tr><td colspan="'+head.length+'" class="empty">'+esc(empty)+'</td></tr>')+'</tbody></table>';
}
function listSlice(key, items) {
  const totalPages=Math.max(1,Math.ceil(items.length/20));
  listPages[key]=Math.min(totalPages,Math.max(1,listPages[key]));
  const current=listPages[key], start=(current-1)*20;
  const footer=totalPages===1?'<div class="record-count">共 '+items.length+' 条记录</div>':
    '<nav class="pagination" aria-label="'+listNames[key]+'分页"><small>共 '+items.length+' 条 · 第 '+current+' / '+totalPages+' 页</small><div><button class="secondary" data-action="paginate" data-list="'+key+'" data-direction="-1" '+(current===1?'disabled':'')+'>上一页</button><button class="secondary" data-action="paginate" data-list="'+key+'" data-direction="1" '+(current===totalPages?'disabled':'')+'>下一页</button></div></nav>';
  return {items:items.slice(start,start+20),footer};
}
function badge(o) { return '<span class="badge '+(o.status==='已完成'?'':o.status==='已取消'?'gray':'warn')+'">'+esc(o.status)+'</span>'; }
function showPage(next) {
  document.body.dataset.page=next;
  page=next; $('.page:not([hidden])')?.setAttribute('hidden','');
  $('#'+page).hidden=false;
  document.querySelectorAll('nav [data-page]').forEach(b=>{
    b.classList.toggle('active',b.dataset.page===page);
    if(b.dataset.page===page) b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  });
  const names={overview:['经营概览','看清生意，做好每一单。','区分成交、到账和欠款，掌握库存与交付。'],checkout:['开单收银','把每一单，记清楚。','扫码选货、商谈成交价，登记实收或定金。'],inventory:['商品与库存','有多少货，一查便知。','每次入库记录实际进价，每次出库留下流水。'],orders:['订单与交付','货送到，账收齐。','订单交付和收款各自留痕，结清后自动显示已完成。'],ledger:['收支与流水','每一笔，都有来处。','核对实际收款与库存变动。']};
  $('#breadcrumb').textContent=names[page][0];$('#page-title').textContent=names[page][1];$('#page-subtitle').textContent=names[page][2];
  $('#heading-action').hidden=page==='checkout';render();
  window.scrollTo({top:0,behavior:'instant'});
  if(page==='checkout') scannerFocus('#sale-search');
  if(page==='inventory') scannerFocus('#receive-code');
}
function render() {
  if(page==='overview') renderOverview();
  if(page==='checkout') {renderCatalog();renderCart();}
  if(page==='inventory') renderInventory();
  if(page==='orders') renderOrders();
  if(page==='ledger') renderLedger();
}
function inRange(timestamp) {
  const day=timestamp.slice(0,10);
  return (!range.start || day>=range.start)&&(!range.end || day<=range.end);
}
function renderOverview() {
  const orders=state.orders.filter(o=>!o.canceled&&inRange(o.created_at));
  const receipts=state.payments.filter(p=>inRange(p.created_at));
  const shipped=state.orders.filter(o=>!o.canceled&&o.shipped_at&&inRange(o.shipped_at));
  const sales=orders.reduce((a,o)=>a+o.goods_total,0), paid=receipts.reduce((a,p)=>a+p.amount,0);
  const gross=shipped.reduce((a,o)=>a+o.lines.reduce((s,l)=>s+(l.price-l.cost)*l.qty,0),0);
  const owed=state.orders.reduce((a,o)=>a+o.owed,0), stock=state.products.reduce((a,p)=>a+p.stock*p.cost,0);
  const pending=state.orders.filter(o=>o.status==='待出库').length, unfinished=state.orders.filter(o=>!o.canceled&&!o.fulfilled_at&&o.shipped_at).length;
  const low=state.products.filter(p=>p.available<=p.threshold);
  const ranking=new Map();
  for(const o of orders) for(const l of o.lines) {
    const r=ranking.get(l.product_id)||{name:l.name,qty:0,amount:0};r.qty+=l.qty;r.amount+=l.qty*l.price;ranking.set(l.product_id,r);
  }
  const ranks=[...ranking.values()].sort((a,b)=>b.amount-a.amount).slice(0,5);
  const metric=(label,n,caption)=>'<div class="metric"><span class="label">'+label+'</span><strong>'+money(n)+'</strong><small>'+caption+'</small></div>';
  $('#overview').innerHTML='<div class="panel period"><form id="period-form" class="filters"><label>从<input type="date" name="start" value="'+esc(range.start)+'"></label><label>至<input type="date" name="end" value="'+esc(range.end)+'"></label><button class="primary">查询</button><button type="button" data-action="today" class="quiet">今日</button><button type="button" data-action="all-time" class="quiet">全部时间</button></form><p class="muted">商品成交额按开单日；到账按收款日；商品毛利按出库日。毛利不含安装收入与送装人工等费用。</p></div><div class="cards">'+
    metric('商品成交额',sales,orders.length+' 笔有效订单 · 不含安装费')+metric('实际到账',paid,'其中安装费 '+money(receipts.reduce((a,p)=>a+p.installation,0)))+metric('商品毛利',gross,'出库时的移动加权平均进价')+metric('当前未收款',owed,'全部订单余额 · 不受日期筛选影响')+'</div>'+
    '<div class="overview-grid"><div class="panel"><div class="panel-head"><h2>今天该关注什么</h2><span>当前全部业务</span></div><div class="quick-row"><button class="quick-item" data-action="pending"><strong>'+pending+'</strong><span>订单待装车出库 ↗</span></button><button class="quick-item" data-action="orders"><strong>'+unfinished+'</strong><span>订单待送装完成 ↗</span></button><button class="quick-item" data-action="low-stock"><strong>'+low.length+'</strong><span>型号可售库存预警 ↗</span></button></div><div class="summary-strip"><span>现存库存成本估值 <b>'+money(stock)+'</b></span><span>展示机数量 <b>'+state.products.reduce((a,p)=>a+p.showroom,0)+' 件</b></span></div><h3>商品成交排行</h3>'+ (ranks.map((r,i)=>'<div class="mini-row"><span class="index">'+(i+1)+'</span><span class="grow">'+esc(r.name)+'<small> '+r.qty+' 件</small></span><b>'+money(r.amount)+'</b></div>').join('')||'<div class="empty">扫码开出第一笔订单，这里就会出现经营数据。</div>')+
    '</div><div class="panel"><div class="panel-head"><h2>可售库存预警</h2><button class="quiet" data-action="inventory">查看库存 ↗</button></div>'+ (low.map(p=>'<div class="mini-row"><span class="grow">'+esc(p.name)+'<small> 预警线 '+p.threshold+' 件</small></span><span class="badge warn">'+p.available+' 件</span></div>').join('')||'<div class="empty">当前库存充足</div>')+'</div></div><div class="panel"><div class="panel-head"><h2>最近订单</h2><button class="quiet" data-action="orders">全部订单 ↗</button></div><div class="table-wrap">'+orderTable(state.orders.slice(0,5))+'</div></div>';
}
function renderCatalog() {
  const q=$('#sale-search').value.trim().toLowerCase();
  const products=state.products.filter(p=>(p.name+p.code+p.brand+p.category).toLowerCase().includes(q));
  $('#sale-catalog').innerHTML=products.map(p=>'<button class="product-card" data-action="add" data-id="'+p.id+'" '+(p.available===0?'disabled':'')+'><span class="product-category">'+esc(p.category)+' · 可售 '+p.available+'</span><strong class="product-name">'+esc(p.name)+'</strong><small>'+esc(p.code)+'</small><span class="product-foot"><b>'+money(p.price)+'</b><span>＋ 加入</span></span></button>').join('')||'<div class="empty">未找到商品，请先在商品与库存中建立档案。</div>';
}
function addCart(p) {
  const line=cart.find(l=>l.product_id===p.id);
  if((line?.qty||0)>=p.available) return notify('该型号可售库存不足',true);
  if(line) line.qty++; else cart.push({product_id:p.id,qty:1,price:p.price});
  renderCart();notify('已加入 '+p.name);$('#sale-search').value='';renderCatalog();scannerFocus('#sale-search');
}
function inboundCode(code) {
  const p=state.products.find(p=>p.code===code);
  if(p) receiveDialog(p);else {notify('未找到条码，请先建立商品档案');newProduct(code);}
}
function shipmentCode(code) {
  const line=scanOrder.lines.find(l=>l.code===code);
  if(!line) throw Error('该条码不属于本单，未计入出库');
  if((scanCounts[code]||0)>=line.qty) throw Error('该型号已核对齐全，不能多扫');
  scanCounts[code]=(scanCounts[code]||0)+1;renderScans();$('#ship-code').value='';scannerFocus('#ship-code');
}
function routeCode(code) {
  if(busy) throw Error('正在保存操作，请稍后扫码');
  if($('#dialog').open && scanOrder && $('#ship-code')) return shipmentCode(code);
  if($('#dialog').open) throw Error('请先完成或关闭当前表单，再扫描商品');
  if(page==='inventory') return inboundCode(code);
  const p=state.products.find(p=>p.code===code);
  if(!p) throw Error('条码未匹配，请先建立商品档案');
  if(page!=='checkout') showPage('checkout');
  addCart(p);
}
function cartTotals() {
  const goods=cart.reduce((a,l)=>a+l.qty*l.price,0);
  const installation=$('#fulfillment').value==='稍后送货'?cart.reduce((a,l)=>a+l.qty*fee(product(l.product_id)),0):0;
  return {goods,installation};
}
function renderCart() {
  $('#cart').innerHTML=cart.map(l=>{const p=product(l.product_id);return '<div class="cart-line"><div class="cart-line-head"><strong>'+esc(p.name)+'</strong><button type="button" class="quiet" data-action="remove" data-id="'+p.id+'">移除</button></div><div class="cart-line-inputs"><label>件数<input class="cart-qty" data-id="'+p.id+'" type="number" min="1" max="'+p.available+'" step="1" value="'+l.qty+'"></label><label>成交单价（元）<input class="cart-price" data-id="'+p.id+'" type="number" min="0" step=".01" value="'+value(l.price)+'"></label><b>'+money(l.qty*l.price)+'</b></div></div>';}).join('')||'<div class="empty">扫码或点击商品加入本次销售。</div>';
  renderTotal();
  configureInputs($('#cart'));
}
function renderTotal() {
  const t=cartTotals();$('#cart-total').textContent=money(t.goods+t.installation);
  $('#mobile-cart-jump').disabled=!cart.length;
  $('#mobile-cart-label').textContent=cart.length?cart.reduce((sum,l)=>sum+l.qty,0)+' 件 · '+money(t.goods+t.installation):'尚未选择商品';
  $('#schedule-label').hidden=$('#fulfillment').value!=='稍后送货';
  let paid=0;try {paid=cents($('#sale-paid').value);}catch(e){}
  $('#sale-balance').textContent='商品款 '+money(t.goods)+'；安装费 '+money(t.installation)+'。本次登记商品款，商品未收 '+money(Math.max(0,t.goods-paid))+'，安装费送装后收取。';
}
function renderInventory() {
  const q=$('#inventory-search').value.trim().toLowerCase(), low=$('#low-only').checked;
  const rows=state.products.filter(p=>(p.name+p.code+p.brand+p.category).toLowerCase().includes(q)&&(!low||p.available<=p.threshold));
  const listed=listSlice('inventory',rows);
  $('#inventory-table').innerHTML=table(['商品 / 型号条码','品类','参考售价','平均进价','仓库','展厅','已预留','可售','操作'],listed.items.map(p=>'<tr><td><b>'+esc(p.name)+'</b><small>'+esc(p.code)+'</small></td><td>'+esc(p.category)+'</td><td>'+money(p.price)+'</td><td>'+money(p.cost)+'</td><td>'+p.warehouse+'</td><td>'+p.showroom+'</td><td>'+p.reserved+'</td><td><span class="badge '+(p.available<=p.threshold?'warn':'')+'">'+p.available+'</span></td><td class="table-actions"><button class="quiet" data-action="receive" data-id="'+p.id+'">入库</button><button class="quiet" data-action="count" data-id="'+p.id+'">盘点</button><button class="quiet" data-action="transfer" data-id="'+p.id+'">移库</button></td></tr>'))+listed.footer;
}
function orderTable(orders) {
  return table(['订单 / 时间','客户','交付状态','应收合计','已收','未收','操作'],orders.map(o=>'<tr><td><b>'+o.number+'</b><small>'+date(o.created_at)+'</small></td><td>'+esc(o.customer||'到店客户')+'<small>'+esc(o.phone)+'</small></td><td>'+badge(o)+(o.scheduled_at?'<small>预约 '+date(o.scheduled_at)+'</small>':'')+'</td><td>'+money(o.total)+'</td><td>'+money(o.paid)+'</td><td class="'+(o.owed?'debt':'')+'">'+money(o.owed)+'</td><td><button class="quiet" data-action="order" data-id="'+o.id+'">查看 / 办理 ↗</button></td></tr>'));
}
function renderOrders() {
  const q=$('#order-search').value.toLowerCase(), filter=$('#order-filter').value;
  const listed=listSlice('orders',state.orders.filter(o=>(o.number+o.customer+o.phone).toLowerCase().includes(q)&&(filter==='all'||filter==='pending'&&o.status==='待出库'||filter==='owed'&&o.owed>0||filter==='delivered'&&o.shipped_at&&!o.canceled||filter==='complete'&&o.status==='已完成')));
  $('#orders-table').innerHTML=orderTable(listed.items)+listed.footer;
}
function renderLedger() {
  const receipts=listSlice('payments',state.payments), movements=listSlice('movements',state.movements);
  $('#ledger').innerHTML='<div class="panel" id="payments-panel"><div class="panel-head"><h2>收款与退款记录</h2><a href="/api/export" class="button" download>导出完整账本 JSON</a></div><p class="muted">商品款与安装费分列；退款记为负数。此处不包含进货付款、房租、工资等支出。</p><div class="table-wrap">'+table(['时间','订单 / 客户','商品款','安装费','合计','方式','业务'],receipts.items.map(p=>'<tr><td>'+date(p.created_at)+'</td><td><button class="quiet" data-action="order" data-id="'+p.order_id+'">XS'+String(p.order_id).padStart(6,'0')+'</button><small>'+esc(p.customer)+'</small></td><td>'+money(p.goods)+'</td><td>'+money(p.installation)+'</td><td>'+money(p.amount)+'</td><td>'+esc(p.method)+'</td><td>'+esc(p.kind)+'</td></tr>'))+'</div>'+receipts.footer+'</div><div class="panel" id="movements-panel"><div class="panel-head"><h2>出入库与预留流水</h2><span>'+state.movements.length+' 条记录</span></div><div class="table-wrap">'+table(['时间','商品','业务 / 位置','数量变化','预留变化','现存 / 预留','本批单价','单号 / 备注'],movements.items.map(m=>'<tr><td>'+date(m.created_at)+'</td><td>'+esc(m.name)+'<small>'+esc(m.code)+'</small></td><td>'+esc(m.kind)+'<small>'+esc(m.location)+'</small></td><td>'+m.qty+'</td><td>'+m.reserved_delta+'</td><td>'+m.balance+' / '+m.reserved_balance+'</td><td>'+(m.unit_cost===null?'—':money(m.unit_cost))+'</td><td>'+esc(m.reference)+'<small>'+esc(m.reason)+'</small></td></tr>'))+'</div>'+movements.footer+'</div>';
}
function dialog(title, body) {
  $('#dialog-notice').hidden=true;
  $('#dialog-title').textContent=title;$('#dialog-body').innerHTML=body;
  configureInputs($('#dialog-body'));
  $('#dialog-body').querySelectorAll('[autofocus]').forEach(input=>{if(window.matchMedia('(max-width:720px)').matches) input.removeAttribute('autofocus');});
  if(!$('#dialog').open) $('#dialog').showModal();
  document.body.classList.add('dialog-open');
}
function close() {$('#dialog').close();$('#dialog-body').innerHTML='';scanOrder=null;scanCounts={};}
function newProduct(code='') {
  dialog('建立商品档案','<form id="product-form"><p class="muted">使用能代表同一型号的固定条码。每台机器各不相同的序列号不能直接作为型号条码。</p><label>型号条码／门店编码<input name="code" required maxlength="80" value="'+esc(code)+'"></label><label>商品名称与完整型号<input name="name" required maxlength="120"></label><div class="form-grid"><label>品牌<input name="brand" maxlength="80"></label><label>品类<input name="category" required maxlength="80" list="category-list"><datalist id="category-list">'+state.categories.map(c=>'<option value="'+esc(c.name)+'">').join('')+'</datalist></label></div><div class="form-grid"><label>参考售价（元）<input name="price" required type="number" min="0" step=".01"></label><label>低库存预警线<input name="threshold" type="number" min="0" step="1" value="2" required></label></div><label>给客户的保修说明<textarea name="warranty" maxlength="500" placeholder="请填写实际保修约定"></textarea></label><button type="submit" class="primary full">保存商品，继续入库</button></form>');
}
function receiveDialog(p) {
  dialog('入库 · '+p.name,'<form id="receive-form" data-id="'+p.id+'"><p class="muted">条码 '+esc(p.code)+' · 当前现存 '+p.stock+' 件；本批实际进价会单独留档。</p><div class="form-grid"><label>入库位置<select name="location"><option>仓库</option><option>展厅</option></select></label><label>入库件数<input name="qty" type="number" min="1" step="1" value="1" required autofocus></label></div><label>本批单件进价（元）<input name="cost" type="number" min="0" step=".01" required placeholder="按本次进货单填写"></label><label>进货单号（选填）<input name="reference" maxlength="80"></label><label>备注<input name="reason" maxlength="500"></label><button type="submit" class="primary full">确认扫码入库</button></form>');
}
function adjustDialog(p, type) {
  const isCount=type==='count';
  dialog((isCount?'盘点 · ':'移库 · ')+p.name,'<form id="'+type+'-form" data-id="'+p.id+'"><p class="muted">仓库 '+p.warehouse+' 件 / 展厅 '+p.showroom+' 件 / 型号预留 '+p.reserved+' 件</p><label>'+ (isCount?'盘点位置':'从此位置移出')+'<select name="'+(isCount?'location':'source')+'"><option>仓库</option><option>展厅</option></select></label><label>'+(isCount?'该位置实际数量':'移至另一位置的数量')+'<input name="'+(isCount?'actual':'qty')+'" required type="number" min="'+(isCount?0:1)+'" step="1"></label>'+(isCount?'<label>调整原因<input name="reason" required maxlength="500"></label>':'')+'<button type="submit" class="primary full">确认'+(isCount?'盘点调整':'移库')+'</button></form>');
}
function categoriesDialog() {
  dialog('按品类设置固定安装费','<p class="muted">金额为每件商品的固定安装费。新订单开单时保存当时的费用，调整不会修改历史订单。无需收费的品类填 0。</p>'+state.categories.map(c=>'<form class="category-form filters"><input name="name" readonly value="'+esc(c.name)+'"><input aria-label="'+esc(c.name)+'安装费" name="fee" type="number" min="0" step=".01" value="'+value(c.fee)+'" required><span>元 / 件</span><button class="primary">保存</button></form>').join(''));
}
function orderDialog(o) {
  const actions=(o.status==='待出库'?'<button class="primary" data-action="ship" data-id="'+o.id+'">装车扫码出库</button>':'')+(!o.canceled&&o.shipped_at&&!o.fulfilled_at?'<button class="primary" data-action="complete" data-id="'+o.id+'">确认送装完成</button>':'')+(!o.canceled&&o.owed?'<button class="primary" data-action="collect" data-id="'+o.id+'">登记尾款 / 安装费</button>':'')+'<button class="quiet" data-action="receipt" data-id="'+o.id+'">客户单据 / 打印</button>'+(o.status==='待出库'?'<button class="quiet danger" data-action="cancel" data-id="'+o.id+'">取消并登记退款</button>':'');
  dialog(o.number+' · '+o.status,'<div class="detail-contact"><b>'+esc(o.customer||'到店客户')+'</b> '+esc(o.phone)+' '+esc(o.backup_phone)+'<p>'+esc(o.address)+'</p><p>预约 '+date(o.scheduled_at)+' · 来源 '+esc(o.source||'未记录')+'</p><p>'+esc(o.note)+'</p></div><div class="table-wrap">'+table(['商品 / 条码','件数','成交单价','安装费 / 件'],o.lines.map(l=>'<tr><td>'+esc(l.name)+'<small>'+esc(l.code)+(l.display_qty?' · 含展示机 '+l.display_qty+' 件':'')+'</small></td><td>'+l.qty+'</td><td>'+money(l.price)+'</td><td>'+money(l.fee)+'</td></tr>'))+'</div><div class="summary-strip"><span>商品 '+money(o.goods_total)+'</span><span>安装 '+money(o.installation_total)+'</span><span>已收 '+money(o.paid)+'</span><strong>未收 '+money(o.owed)+'</strong></div><div class="order-actions">'+actions+'</div><p class="muted">出库 '+date(o.shipped_at)+' · 送装完成 '+date(o.fulfilled_at)+'</p><h3>收款记录</h3>'+table(['时间','商品款','安装费','方式'],o.payments.map(p=>'<tr><td>'+date(p.created_at)+'</td><td>'+money(p.goods)+'</td><td>'+money(p.installation)+'</td><td>'+esc(p.method)+'</td></tr>')));
}
function collectDialog(o) {
  dialog('登记收款 · '+o.number,'<form id="collect-form" data-id="'+o.id+'"><p class="muted">请确认钱已到账。'+(!o.fulfilled_at?'安装费需先确认送装完成。':'')+'</p><div class="form-grid"><label>本次商品款（元）<input name="goods" type="number" min="0" step=".01" max="'+value(o.goods_owed)+'" value="'+value(o.goods_owed)+'" required></label><label>本次安装费（元）<input name="installation" type="number" min="0" step=".01" max="'+value(o.fulfilled_at?o.installation_owed:0)+'" value="'+value(o.fulfilled_at?o.installation_owed:0)+'" required></label></div><p>商品未收 '+money(o.goods_owed)+' / 安装费未收 '+money(o.installation_owed)+'</p><label>收款方式<select name="method">'+methods+'</select></label><button type="submit" class="primary full">确认实际收款</button></form>');
}
function shipDialog(o) {
  scanOrder=o;scanCounts={};
  dialog('装车扫码 · '+o.number,'<form id="ship-scan" class="filters"><input name="code" id="ship-code" required placeholder="扫描商品型号条码，每扫一次增加 1 件" autocomplete="off" aria-label="出库扫码条码"><button class="primary">核对一件</button></form><div id="scan-list"></div><p class="muted">先从仓库取货，仓库不足部分使用展厅展示机。所有商品核对一致后，一次性登记整单装车出库。</p><form id="ship-form" data-id="'+o.id+'"><label class="check"><input name="display_disclosed" type="checkbox"> 涉及展示机时，已提前告知客户</label><button id="confirm-ship" type="submit" class="primary full" disabled>核对齐全后确认出库</button></form>');
  renderScans();scannerFocus('#ship-code');
}
function renderScans() {
  $('#scan-list').innerHTML=table(['商品','应装','已扫码','操作'],scanOrder.lines.map(l=>'<tr><td>'+esc(l.name)+'<small>'+esc(l.code)+'</small></td><td>'+l.qty+'</td><td>'+ (scanCounts[l.code]||0)+'</td><td><button class="quiet" data-action="undo-scan" data-code="'+esc(l.code)+'">减一件</button></td></tr>'));
  $('#confirm-ship').disabled=!scanOrder.lines.every(l=>scanCounts[l.code]===l.qty);
}
function receipt(o) {
  dialog('客户销售单 · '+o.number,'<article id="receipt"><h2>邻里家电 · 销售与送装单</h2><p>单号 '+o.number+' · 开单 '+date(o.created_at)+'</p><p>客户 '+esc(o.customer||'到店客户')+' · 电话 '+esc(o.phone)+' · 备用电话 '+esc(o.backup_phone)+'</p><p>地址 '+esc(o.address||'店内提货')+' · 预约 '+date(o.scheduled_at)+'</p>'+table(['商品 / 型号','件数','成交单价','商品金额','安装费'],o.lines.map(l=>'<tr><td>'+esc(l.name)+'<small>'+esc(l.code)+(l.display_qty?' · 展示机 '+l.display_qty+' 件（已告知）':'')+'</small></td><td>'+l.qty+'</td><td>'+money(l.price)+'</td><td>'+money(l.price*l.qty)+'</td><td>'+money(l.fee*l.qty)+'</td></tr>'))+'<p>商品合计 '+money(o.goods_total)+' + 安装费 '+money(o.installation_total)+' = 应收 '+money(o.total)+'</p><p>商品已收 '+money(o.goods_paid)+'，商品未收 '+money(o.goods_owed)+'；安装已收 '+money(o.installation_paid)+'，安装未收 '+money(o.installation_owed)+'</p><h3>保修说明</h3>'+o.lines.map(l=>'<p>'+esc(l.name)+'：'+esc(l.warranty||'未填写，请与门店确认实际保修约定')+'</p>').join('')+'<p>备注 '+esc(o.note)+'</p><p>状态 '+esc(o.status)+' · 客户签字：________________</p></article><div class="order-actions no-print"><button class="primary" data-action="print">打印 / 保存 PDF</button><button class="quiet" data-action="order" data-id="'+o.id+'">返回订单</button></div>');
}
document.addEventListener('click',e=>{
  const nav=e.target.closest('nav button[data-page]');if(nav) return showPage(nav.dataset.page);
  const b=e.target.closest('[data-action]');if(!b || busy) return;
  const id=Number(b.dataset.id), action=b.dataset.action;
  if(action==='paginate') {
    listPages[b.dataset.list]+=Number(b.dataset.direction);
    render();
    const container=b.dataset.list==='orders'?'#orders-table':b.dataset.list==='inventory'?'#inventory-table':b.dataset.list==='payments'?'#payments-panel':'#movements-panel';
    $(container).scrollIntoView({block:'start',behavior:'instant'});
    return;
  }
  if(action==='add') addCart(product(id));
  if(action==='remove') {cart=cart.filter(l=>l.product_id!==id);renderCart();}
  if(action==='receive') receiveDialog(product(id));
  if(action==='count'||action==='transfer') adjustDialog(product(id),action);
  if(action==='order') orderDialog(order(id));
  if(action==='collect') collectDialog(order(id));
  if(action==='ship') shipDialog(order(id));
  if(action==='receipt') receipt(order(id));
  if(action==='print') window.print();
  if(action==='complete') work(async()=>{await mutate('complete',{order_id:id});await refresh();orderDialog(order(id));notify('已记录送装完成');});
  if(action==='cancel') dialog('取消订单 · '+order(id).number,'<form id="cancel-form" data-id="'+id+'"><p>此操作释放预留，并登记实际退款 '+money(order(id).paid)+'。请先完成原渠道退款。</p><label>取消原因<input name="reason" required maxlength="500"></label><label>退款方式<select name="method">'+methods+'</select></label><button type="submit" class="primary full">已退款，确认取消</button></form>');
  if(action==='undo-scan') {scanCounts[b.dataset.code]=Math.max(0,(scanCounts[b.dataset.code]||0)-1);renderScans();}
  if(action==='today') {const today=state.as_of.slice(0,10);range={start:today,end:today};renderOverview();}
  if(action==='all-time') {range={start:'',end:''};renderOverview();}
  if(['orders','inventory','pending','low-stock'].includes(action)) {
    if(action==='pending') $('#order-filter').value='pending';
    if(action==='orders') $('#order-filter').value='all';
    if(action==='low-stock') $('#low-only').checked=true;
    showPage(action==='low-stock'?'inventory':action==='pending'?'orders':action);
  }
});
document.addEventListener('submit',e=>{
  const f=e.target;e.preventDefault();
  try {
    const d=formData(f), id=Number(f.dataset.id);
    if(f.id==='period-form') {
      if(d.start&&d.end&&d.start>d.end) throw Error('起始日期不能晚于结束日期');
      range={start:d.start,end:d.end};return renderOverview();
    }
    if(f.id==='inbound-scan') {
      inboundCode($('#receive-code').value.trim());return;
    }
    if(f.id==='ship-scan') {
      shipmentCode(d.code.trim());return;
    }
    if(f.id==='sale-form') {
      if(!cart.length) throw Error('请先添加商品');
      const payload={...d,items:cart.map(l=>({...l})),paid:cents(d.paid),display_disclosed:d.display_disclosed==='on'};
      return work(async()=>{const result=await mutate('sale',payload);cart=[];f.reset();await refresh();orderDialog(order(result.id));notify('开单成功，库存与收款已同步');});
    }
    if(f.id==='product-form') return work(async()=>{const result=await mutate('product',{...d,price:cents(d.price),threshold:number(d.threshold)});await refresh();receiveDialog(product(result.product_id));notify('商品已建立，请填写本次入库');});
    if(f.id==='receive-form') return work(async()=>{await mutate('receive',{...d,product_id:id,qty:number(d.qty),cost:cents(d.cost)});close();$('#receive-code').value='';await refresh();scannerFocus('#receive-code');notify('入库成功，库存与批次进价已记录');});
    if(f.id==='count-form'||f.id==='transfer-form') {const action=f.id.split('-')[0],payload={...d,product_id:id};if(action==='count') payload.actual=number(d.actual);else payload.qty=number(d.qty);return work(async()=>{await mutate(action,payload);close();await refresh();notify('库存已更新，流水已保留');});}
    if(f.classList.contains('category-form')) return work(async()=>{await mutate('category',{name:d.name,fee:cents(d.fee)});await refresh();notify('安装费已保存，适用于之后的新订单');});
    if(f.id==='collect-form') return work(async()=>{await mutate('collect',{...d,order_id:id,goods:cents(d.goods),installation:cents(d.installation)});await refresh();orderDialog(order(id));notify('收款已记账');});
    if(f.id==='ship-form') return work(async()=>{await mutate('deliver',{order_id:id,scans:{...scanCounts},display_disclosed:d.display_disclosed==='on'});await refresh();scanOrder=null;orderDialog(order(id));notify('装车出库成功，预留已释放');});
    if(f.id==='cancel-form') return work(async()=>{await mutate('cancel',{...d,order_id:id});await refresh();orderDialog(order(id));notify('已取消，预留与退款已登记');});
  } catch(e) {notify(e.message,true);}
});
$('#sale-search').addEventListener('input',renderCatalog);
// USB HID scanners and ordinary keyboard simulations share this global path.
// Normal customer/amount inputs retain their editing and Enter behavior.
document.addEventListener('keydown',e=>{
  if(e.isComposing||e.ctrlKey||e.metaKey||e.altKey) {keyboardCode='';return;}
  const target=e.target, scannerInput=['sale-search','receive-code','ship-code'].includes(target.id);
  const editable=target.closest('input,textarea,select,[contenteditable="true"]');
  if(editable) {
    keyboardCode='';
    if(scannerInput&&e.key==='Enter') {
      e.preventDefault();
      const code=target.value.trim();
      if(code) try {routeCode(code);} catch(error) {notify(error.message,true);}
    }
    return;
  }
  if(e.key==='Enter' && keyboardCode) {
    e.preventDefault();
    const code=keyboardCode;keyboardCode='';$('#keyboard-scan-status').textContent='键盘扫码已开启';
    try {routeCode(code);} catch(error) {notify(error.message,true);}
    return;
  }
  if(e.key==='Escape') keyboardCode='';
  if(e.key==='Backspace'&&keyboardCode) {e.preventDefault();keyboardCode=keyboardCode.slice(0,-1);}
  if(e.key.length===1 && !e.repeat) {
    if(Date.now()-lastKeyAt>2000) keyboardCode='';
    if(keyboardCode.length<80) keyboardCode+=e.key;
    lastKeyAt=Date.now();
  }
  $('#keyboard-scan-status').textContent=keyboardCode?'待识别 '+keyboardCode+' ↵':'键盘扫码已开启';
},true);
$('#cart').addEventListener('change',e=>{
  const l=cart.find(l=>l.product_id===Number(e.target.dataset.id));if(!l) return;
  try {
    if(e.target.classList.contains('cart-qty')) {const n=number(e.target.value);if(!n||n>product(l.product_id).available) throw Error('件数超出可售库存');l.qty=n;}
    if(e.target.classList.contains('cart-price')) l.price=cents(e.target.value);
  }catch(err){notify(err.message,true);}renderCart();
});
$('#fulfillment').addEventListener('change',renderTotal);
$('#sale-paid').addEventListener('input',renderTotal);
$('#pay-full').addEventListener('click',()=>{$('#sale-paid').value=value(cartTotals().goods);renderTotal();});
$('#clear-cart').addEventListener('click',()=>{cart=[];renderCart();});
$('#inventory-search').addEventListener('input',()=>{listPages.inventory=1;renderInventory();});
$('#low-only').addEventListener('change',()=>{listPages.inventory=1;renderInventory();});
$('#order-search').addEventListener('input',()=>{listPages.orders=1;renderOrders();});
$('#order-filter').addEventListener('change',()=>{listPages.orders=1;renderOrders();});
$('#new-product').addEventListener('click',()=>newProduct());
$('#category-settings').addEventListener('click',categoriesDialog);
$('#close-dialog').addEventListener('click',close);
$('#dialog').addEventListener('close',()=>{
  document.body.classList.remove('dialog-open');scanOrder=null;scanCounts={};$('#dialog-body').innerHTML='';
});
$('#mobile-cart-jump').addEventListener('click',()=>{
  $('.cart-panel').scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});
});
$('#heading-action').addEventListener('click',()=>showPage('checkout'));
$('#refresh').addEventListener('click',()=>work(async()=>{await refresh();notify('账本已刷新');}));
configureInputs(document);
refresh().catch(e=>notify(e.message,true));
