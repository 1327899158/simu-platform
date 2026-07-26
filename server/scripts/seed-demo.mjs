/** 可选：向运行中的服务预置一个演示客户和两条需求，让大厅不空。用法：node scripts/seed-demo.mjs */
const BASE = process.env.BASE || 'http://127.0.0.1:3000/api';
const api = async (method, url, body, token) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(url + ': ' + (j.message || res.status));
  return j.data;
};
const cust = await api('POST', '/auth/wx-login', { code: 'seed-demo-customer', roleHint: 'customer' });
const t = cust.accessToken;
const mk = (projectName, description, directionTags, softwareTags, budgetFen, deliveryDays) =>
  api('POST', '/orders', { projectName, description, directionTags, softwareTags, budgetFen, deliveryDays, budgetFlexible: true }, t);
await mk('支架静力学强度校核', '铝合金支架静力学分析，输出应力云图、变形云图与安全系数报告，需给出网格无关性验证说明。', ['结构分析'], ['ANSYS全系列'], 500000, 5);
await mk('电机水冷板流阻与温升仿真', '对电机控制器水冷板做流固耦合分析，评估流阻与最高温升，提出两版流道改进建议。', ['流体分析', '热分析'], ['STAR-CCM+'], 800000, 7);
console.log('已预置演示客户与 2 条需求（大厅可见）');
