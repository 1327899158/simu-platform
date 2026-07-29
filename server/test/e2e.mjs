/**
 * 端到端闭环测试：从零库启动服务，走完
 * 登录 → 发需求(含文件) → 大厅 → 报价 → 选标 → 支付(幂等) → 会话 → 交付 → 确认
 * 以及：越权三连、内容拦截、支付超时回退、服务重启数据无损。
 * 运行：npm run e2e
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}/api`;
const DB = path.join(__dirname, 'e2e.db');
const results = [];
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  const okFlag = !!cond;
  results.push({ name, ok: okFlag, detail });
  if (okFlag) passed++; else failed++;
  console.log(`${okFlag ? '✅' : '❌'} ${name}${detail && !okFlag ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { /* raw 下载等非 JSON */ }
  return { status: res.status, json };
}

function startServer(env = {}) {
  const child = spawn(process.execPath, ['--experimental-sqlite', 'src/main.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_FILE: DB,
      UPLOAD_DIR: path.join(__dirname, 'e2e-uploads'),
      WX_MOCK: '1',
      PAY_PROVIDER: 'mock',
      PAY_TIMEOUT_SEC: '2', // 测试：2 秒未支付即回退
      JWT_SECRET: 'e2e-secret',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

async function waitReady(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await api('GET', '/health');
      if (r.json?.data?.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server not ready');
}

// ---------- 清理旧测试数据 ----------
for (const f of [DB, DB + '-wal', DB + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
fs.rmSync(path.join(__dirname, 'e2e-uploads'), { recursive: true, force: true });

let server = startServer();
try {
  await waitReady();
  console.log('—— 服务已启动，开始闭环用例 ——\n');

  // 1. 登录：客户 / 工程师1 / 工程师2 / 客户2（越权用）
  const login = async (code, roleHint) =>
    (await api('POST', '/auth/wx-login', { body: { code, roleHint } })).json.data;
  const cust = await login('device-A-customer', 'customer');
  const eng1 = await login('device-B-engineer', 'engineer');
  const eng2 = await login('device-C-engineer', 'engineer');
  const cust2 = await login('device-D-customer', 'customer');
  check('用例1 新用户登录成功并返回角色', cust?.user?.role === 'CUSTOMER' && eng1?.user?.role === 'ENGINEER');
  const again = await login('device-A-customer', 'customer');
  check('用例1b 同设备重复登录得到同一账号', again.user.id === cust.user.id && again.isNew === false);

  // 2. 客户上传文件 + 发布需求
  const form = new FormData();
  form.append('kind', 'MODEL');
  form.append('file', new Blob([Buffer.alloc(256 * 1024, 7)], { type: 'application/zip' }), '支架模型.step.zip');
  const up = await api('POST', '/files/upload', { token: cust.accessToken, form });
  check('用例2a 模型文件上传成功', up.json?.code === 0 && up.json.data.sizeBytes === 256 * 1024, JSON.stringify(up.json));
  const fileId = up.json?.data?.fileId;

  const orderBody = {
    projectName: '支架静力学分析',
    description: '对铝合金支架进行静力学强度校核，输出应力云图与安全系数报告，要求给出网格无关性说明。',
    softwareTags: ['ANSYS全系列'],
    directionTags: ['结构分析'],
    budgetFen: 500000,
    budgetFlexible: true,
    deliveryDays: 5,
    fileIds: [fileId],
  };
  const created = await api('POST', '/orders', { token: cust.accessToken, body: orderBody });
  check('用例2b 发布需求成功(状态QUOTING)', created.json?.data?.status === 'QUOTING', JSON.stringify(created.json));
  const orderId = created.json?.data?.id;
  const badOrder = await api('POST', '/orders', { token: cust.accessToken, body: { ...orderBody, projectName: 'ab' } });
  check('用例2c 参数校验拦截(名称过短400)', badOrder.status === 400);

  // 3. 工程师大厅可见并筛选命中
  const hall = await api('GET', '/market/orders?direction=结构分析&software=ANSYS全系列', { token: eng1.accessToken });
  check('用例3 大厅筛选「结构+ANSYS」命中该单', hall.json?.data?.items?.some((x) => x.id === orderId));
  const hallByCust = await api('GET', '/market/orders', { token: cust.accessToken });
  check('用例3b 客户访问大厅被拒(403)', hallByCust.status === 403);

  // 4. 报价：提交→修改→撤回→重报
  const quote1 = await api('POST', `/orders/${orderId}/quotes`, {
    token: eng1.accessToken,
    body: { amountFen: 480000, days: 5, solution: '采用 Workbench 静力学模块，二阶四面体网格，接触对绑定处理。' },
  });
  check('用例4a 工程师1报价成功', quote1.json?.code === 0, JSON.stringify(quote1.json));
  const q1id = quote1.json?.data?.id;
  const patched = await api('PATCH', `/quotes/${q1id}`, { token: eng1.accessToken, body: { amountFen: 460000 } });
  check('用例4b 修改报价成功(46万分)', patched.json?.data?.amountFen === 460000);
  const withdrawn = await api('DELETE', `/quotes/${q1id}`, { token: eng1.accessToken });
  check('用例4c 撤回报价成功', withdrawn.json?.data?.withdrawn === true);
  const requote = await api('POST', `/orders/${orderId}/quotes`, {
    token: eng1.accessToken,
    body: { amountFen: 480000, days: 5, solution: '重报：Workbench 静力学模块，网格无关性三档验证。' },
  });
  check('用例4d 撤回后重报成功', requote.json?.data?.status === 'PENDING');

  // 5. 第二工程师报价，客户可见两条，工程师互相不可见
  const quote2 = await api('POST', `/orders/${orderId}/quotes`, {
    token: eng2.accessToken,
    body: { amountFen: 520000, days: 4, solution: 'ABAQUS 隐式求解，六面体主导网格，含疲劳初评。' },
  });
  check('用例5a 工程师2报价成功', quote2.json?.code === 0);
  const custQuotes = await api('GET', `/orders/${orderId}/quotes`, { token: cust.accessToken });
  check('用例5b 客户可见全部2条报价', custQuotes.json?.data?.length === 2);
  const eng2View = await api('GET', `/market/orders/${orderId}`, { token: eng2.accessToken });
  const seesOthersAmount = JSON.stringify(eng2View.json?.data?.myQuote || {}).includes('480000');
  check('用例5c 工程师2看不到工程师1的报价金额', !seesOthersAmount && eng2View.json?.data?.quoteCount === 2);
  const engListQuotes = await api('GET', `/orders/${orderId}/quotes`, { token: eng1.accessToken });
  check('用例5d 工程师访问报价全列表被拒(403)', engListQuotes.status === 403);

  // 6. 选标：并发第二次选标失败；未选中报价自动拒绝
  const sel = await api('POST', `/orders/${orderId}/select-quote`, {
    token: cust.accessToken, body: { quoteId: requote.json.data.id },
  });
  check('用例6a 选标成功(AWAITING_PAYMENT,锁定48万分)',
    sel.json?.data?.status === 'AWAITING_PAYMENT' && sel.json?.data?.finalAmountFen === 480000);
  const selAgain = await api('POST', `/orders/${orderId}/select-quote`, {
    token: cust.accessToken, body: { quoteId: quote2.json.data.id },
  });
  check('用例6b 重复选标被乐观锁拒绝(409)', selAgain.status === 409);
  const eng2Mine = await api('GET', '/quotes/mine?status=REJECTED', { token: eng2.accessToken });
  check('用例6c 工程师2报价自动变REJECTED', eng2Mine.json?.data?.some((x) => x.orderId === orderId));

  // 7. 支付：下单→模拟回调→幂等重放
  const pay = await api('POST', `/orders/${orderId}/pay`, { token: cust.accessToken });
  check('用例7a 创建支付单(mock通道)', pay.json?.data?.provider === 'mock' && pay.json.data.amountFen === 480000);
  const outTradeNo = pay.json?.data?.outTradeNo;
  const notify1 = await api('POST', '/payments/mock-notify', { body: { outTradeNo } });
  check('用例7b 支付回调落账(applied=true)', notify1.json?.data?.applied === true, JSON.stringify(notify1.json));
  const notify2 = await api('POST', '/payments/mock-notify', { body: { outTradeNo } });
  check('用例7c 重复回调幂等(already-success)', notify2.json?.data?.reason === 'already-success');
  const afterPay = await api('GET', `/orders/${orderId}`, { token: cust.accessToken });
  check('用例7d 订单进入执行中(IN_PROGRESS)', afterPay.json?.data?.status === 'IN_PROGRESS');

  // 8. 超时回退：第二单选标后不支付，2秒超时+清扫周期后回退
  const order2 = await api('POST', '/orders', {
    token: cust.accessToken,
    body: { ...orderBody, projectName: '风机叶片模态分析', fileIds: [] },
  });
  const o2 = order2.json.data.id;
  const q2 = await api('POST', `/orders/${o2}/quotes`, {
    token: eng2.accessToken, body: { amountFen: 300000, days: 3, solution: '模态提取前10阶，预应力工况对比。' },
  });
  await api('POST', `/orders/${o2}/select-quote`, { token: cust.accessToken, body: { quoteId: q2.json.data.id } });
  await sleep(13000); // 超时2s + 清扫间隔10s + 余量
  const o2after = await api('GET', `/orders/${o2}`, { token: cust.accessToken });
  const q2after = await api('GET', '/quotes/mine', { token: eng2.accessToken });
  const q2row = q2after.json?.data?.find((x) => x.orderId === o2);
  check('用例8 超时未支付自动回退QUOTING且报价恢复PENDING',
    o2after.json?.data?.status === 'QUOTING' && q2row?.status === 'PENDING',
    `order=${o2after.json?.data?.status} quote=${q2row?.status}`);

  // 9. 会话：系统消息已生成；互发文字；违规词拦截；未读数
  const convRef = await api('GET', `/conversations/by-order/${orderId}`, { token: cust.accessToken });
  const convId = convRef.json?.data?.id;
  check('用例9a 支付后会话自动创建', !!convId);
  const custPull0 = await api('GET', `/conversations/${convId}/messages?after=0`, { token: cust.accessToken });
  check('用例9b 系统消息已写入', custPull0.json?.data?.items?.some((m) => m.type === 'SYSTEM'));
  await api('POST', `/conversations/${convId}/messages`, {
    token: cust.accessToken, body: { type: 'TEXT', content: '你好，模型文件已在订单里，边界条件见说明。' },
  });
  const engSend = await api('POST', `/conversations/${convId}/messages`, {
    token: eng1.accessToken, body: { type: 'TEXT', content: '收到，今晚出网格方案。' },
  });
  check('用例9c 双方互发文字成功', engSend.json?.code === 0);
  const blocked = await api('POST', `/conversations/${convId}/messages`, {
    token: eng1.accessToken, body: { type: 'TEXT', content: '这单加微信私聊便宜点' },
  });
  check('用例9d 违规词被内容安全拦截(400)', blocked.status === 400);
  const engList = await api('GET', '/conversations', { token: eng1.accessToken });
  const convRow = engList.json?.data?.find((c) => c.id === convId);
  check('用例9e 会话列表含未读数与最后消息', !!convRow && typeof convRow.unread === 'number');

  // 10. 交付与确认：工程师传成果→交付→客户下载→确认完成
  const rform = new FormData();
  rform.append('kind', 'RESULT');
  rform.append('orderId', orderId);
  rform.append('file', new Blob([Buffer.alloc(64 * 1024, 3)], { type: 'application/pdf' }), '分析报告v1.pdf');
  const rup = await api('POST', '/files/upload', { token: eng1.accessToken, form: rform });
  check('用例10a 被选中工程师可向订单上传成果', rup.json?.code === 0, JSON.stringify(rup.json));
  const deliver = await api('POST', `/orders/${orderId}/deliver`, {
    token: eng1.accessToken, body: { fileIds: [rup.json.data.fileId], note: '含应力云图与安全系数' },
  });
  check('用例10b 交付成功(DELIVERED)', deliver.json?.data?.delivered === true);
  const urlRes = await api('GET', `/files/${rup.json.data.fileId}/url`, { token: cust.accessToken });
  check('用例10c 客户获取成果下载签名链接', typeof urlRes.json?.data?.url === 'string');
  const raw = await fetch(`http://127.0.0.1:${PORT}` + urlRes.json.data.url);
  check('用例10d 签名链接可下载(200且字节数正确)',
    raw.status === 200 && (await raw.arrayBuffer()).byteLength === 64 * 1024);
  // 10d2. 驳回交付（回到 IN_PROGRESS），再交付一次后才最终确认
  const rejectOk = await api('POST', `/orders/${orderId}/reject-delivery`, {
    token: cust.accessToken, body: { reason: '报告格式不符合要求' },
  });
  check('用例10d2 客户驳回交付成功(IN_PROGRESS)', rejectOk.json?.data?.rejected === true,
    JSON.stringify(rejectOk.json));
  const afterReject = await api('GET', `/orders/${orderId}`, { token: cust.accessToken });
  check('用例10d3 驳回后订单恢复IN_PROGRESS', afterReject.json?.data?.status === 'IN_PROGRESS');
  // 重新交付
  const deliver2 = await api('POST', `/orders/${orderId}/deliver`, {
    token: eng1.accessToken, body: { fileIds: [rup.json.data.fileId], note: '已修改格式' },
  });
  check('用例10d4 工程师可再次交付(DELIVERED)', deliver2.json?.data?.delivered === true);

  const confirm = await api('POST', `/orders/${orderId}/confirm`, { token: cust.accessToken });
  check('用例10e 客户确认完成(COMPLETED)', confirm.json?.data?.completed === true);

  // 11. 越权三连
  const other1 = await api('GET', `/orders/${orderId}`, { token: cust2.accessToken });
  const other2 = await api('PATCH', `/quotes/${requote.json.data.id}`, { token: eng2.accessToken, body: { amountFen: 100 } });
  const other3 = await api('GET', `/files/${rup.json.data.fileId}/url`, { token: eng2.accessToken });
  check('用例11 越权三连全部被拒(403/404)',
    other1.status === 403 && (other2.status === 404 || other2.status === 409) && other3.status === 403,
    `${other1.status}/${other2.status}/${other3.status}`);
  const noToken = await api('GET', '/orders/mine');
  check('用例11b 未登录访问被拒(401)', noToken.status === 401);

  // 12. 服务重启后数据无损
  server.kill();
  await sleep(500);
  server = startServer();
  await waitReady();
  const afterRestart = await api('GET', `/orders/${orderId}`, { token: cust.accessToken });
  const msgsAfter = await api('GET', `/conversations/${convId}/messages?after=0`, { token: cust.accessToken });
  check('用例12 重启后订单终态与消息完整保留',
    afterRestart.json?.data?.status === 'COMPLETED' && (msgsAfter.json?.data?.items?.length || 0) >= 3);

  console.log(`\n—— 结果：${passed} 通过 / ${failed} 失败 ——`);
  fs.writeFileSync(
    path.join(__dirname, 'e2e-report.json'),
    JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2)
  );
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('E2E 异常中断：', e);
  process.exitCode = 1;
} finally {
  server.kill();
}
