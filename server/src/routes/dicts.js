'use strict';
/** 字典：仿真软件 / 仿真方向 / 工期选项 / 状态文案映射（取自原方案 3.1.2）。 */
const { ok } = require('../lib/http');

const DICTS = {
  softwares: [
    'ANSYS全系列', 'ABAQUS', 'COMSOL Multiphysics', 'NASTRAN', 'LS-DYNA',
    'ADAMS', 'RecurDyn', 'HyperMesh', 'MATLAB/Simulink', 'OpenFOAM',
    'STAR-CCM+', 'Radioss', 'Salome', 'FreeCAD', 'EDEM',
    'ICEM CFD', 'Gmsh', '其他',
  ],
  directions: [
    '结构分析', '流体分析', '热分析', '多物理场耦合', '电磁场分析',
    '声学分析', '优化设计', '可靠性分析', '碰撞安全', '微观结构仿真', '其他',
  ],
  deliveryOptions: [
    { key: 'fast', label: '快速（1-3天）', days: 3 },
    { key: 'standard', label: '标准（4-7天）', days: 7 },
    { key: 'relaxed', label: '宽松（8-15天）', days: 15 },
    { key: 'custom', label: '自定义', days: null },
  ],
  orderStatus: {
    QUOTING: '待报价',
    AWAITING_PAYMENT: '待支付',
    IN_PROGRESS: '执行中',
    DELIVERED: '待验收',
    COMPLETED: '已完成',
    CLOSED: '已关闭',
  },
  quoteStatus: {
    PENDING: '待客户确认',
    SELECTED: '已选中',
    REJECTED: '未选中',
    WITHDRAWN: '已撤回',
  },
};

function register(router) {
  router.get('/api/dicts', async (_req, res) => ok(res, DICTS));
}

module.exports = { register, DICTS };
