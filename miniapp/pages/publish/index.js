/** 发布需求：五步表单（方案 3.1.2），本地草稿，文件直传后携 fileIds 提交。 */
const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { yuanToFen } = require('../../utils/format');

const DRAFT_KEY = 'publishDraft';

Page({
  data: {
    step: 1,
    dicts: { softwares: [], directions: [], deliveryOptions: [] },
    // 步骤1
    projectName: '',
    description: '',
    budgetYuan: '',
    budgetFlexible: true,
    // 步骤2
    softwareTags: [],
    directionTags: [],
    // 步骤3
    deliveryKey: 'standard',
    customDays: '',
    specialNote: '',
    // 步骤4
    files: [], // {fileId, name, sizeText, kind}
    uploading: false,
    // 步骤5
    agreed: false,
    submitting: false,
  },
  async onLoad() {
    if (!ensureLogin()) return;
    const draft = wx.getStorageSync(DRAFT_KEY);
    if (draft) this.setData(draft);
    this.setData({ dicts: await request('GET', '/dicts') });
  },
  onUnload() {
    if (this.data.submitting) return;
    const { projectName, description, budgetYuan, budgetFlexible, softwareTags,
      directionTags, deliveryKey, customDays, specialNote, files } = this.data;
    wx.setStorageSync(DRAFT_KEY, {
      projectName, description, budgetYuan, budgetFlexible, softwareTags,
      directionTags, deliveryKey, customDays, specialNote, files,
    });
  },

  toStep(e) { this.setData({ step: Number(e.currentTarget.dataset.s) }); },
  prev() { if (this.data.step > 1) this.setData({ step: this.data.step - 1 }); },
  next() {
    const d = this.data, s = d.step;
    // 逐步轻量校验，不通过则停在当前步
    if (s === 1) {
      if ((d.projectName || '').trim().length < 4) return wx.showToast({ title: '项目名称至少4个字', icon: 'none' });
      if ((d.description || '').trim().length < 20) return wx.showToast({ title: '项目描述至少20个字', icon: 'none' });
    } else if (s === 2) {
      if (!d.softwareTags.length || !d.directionTags.length) return wx.showToast({ title: '请选择仿真软件与方向', icon: 'none' });
    } else if (s === 3) {
      const days = this.deliveryDays();
      if (!days || days < 1 || days > 90) return wx.showToast({ title: '请填写 1-90 天的工期', icon: 'none' });
    }
    if (s < 5) this.setData({ step: s + 1 });
    else this.submit();
  },

  input(e) { this.setData({ [e.currentTarget.dataset.f]: e.detail.value }); },
  toggleFlexible() { this.setData({ budgetFlexible: !this.data.budgetFlexible }); },
  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },
  pickDelivery(e) { this.setData({ deliveryKey: e.currentTarget.dataset.k }); },
  toggleTag(e) {
    const { f, v } = e.currentTarget.dataset;
    const list = this.data[f].slice();
    const i = list.indexOf(v);
    i >= 0 ? list.splice(i, 1) : list.push(v);
    this.setData({ [f]: list });
  },

  async chooseFile() {
    if (this.data.uploading) return;
    wx.chooseMessageFile({
      count: 3,
      type: 'all',
      success: async (r) => {
        this.setData({ uploading: true });
        try {
          for (const f of r.tempFiles) {
            const isImage = /\.(png|jpg|jpeg|gif)$/i.test(f.name || '');
            const up = await upload(f.path, { kind: isImage ? 'IMAGE' : 'MODEL' });
            this.setData({
              files: this.data.files.concat({
                fileId: up.id || up.fileId,
                name: up.name || f.name,
                sizeText: ((up.sizeBytes || 0) / 1024 / 1024).toFixed(2) + 'MB',
              }),
            });
          }
          wx.showToast({ title: '上传成功', icon: 'success' });
        } catch (err) {
          wx.showToast({ title: err.message || '上传失败', icon: 'none' });
        }
        this.setData({ uploading: false });
      },
    });
  },
  removeFile(e) {
    const files = this.data.files.slice();
    files.splice(e.currentTarget.dataset.i, 1);
    this.setData({ files });
  },

  deliveryDays() {
    const opt = this.data.dicts.deliveryOptions.find((o) => o.key === this.data.deliveryKey);
    if (!opt) return 7;
    return opt.days || parseInt(this.data.customDays, 10) || 0;
  },
  async submit() {
    const d = this.data;
    if (d.submitting) return;
    if (!d.agreed) return wx.showToast({ title: '请先同意平台服务协议', icon: 'none' });
    if ((d.projectName || '').trim().length < 4) return wx.showToast({ title: '项目名称至少4个字', icon: 'none' });
    if ((d.description || '').trim().length < 20) return wx.showToast({ title: '项目描述至少20个字', icon: 'none' });
    if (!d.softwareTags.length || !d.directionTags.length) return wx.showToast({ title: '请选择仿真软件与方向', icon: 'none' });
    const days = this.deliveryDays();
    if (!days || days < 1 || days > 90) return wx.showToast({ title: '请填写 1-90 天的工期', icon: 'none' });

    this.setData({ submitting: true });
    try {
      const body = {
        projectName: d.projectName.trim(),
        description: d.description.trim(),
        softwareTags: d.softwareTags,
        directionTags: d.directionTags,
        deliveryDays: days,
        budgetFlexible: d.budgetFlexible,
        specialNote: (d.specialNote || '').trim() || undefined,
        fileIds: d.files.map((f) => f.fileId),
      };
      if (d.budgetYuan) body.budgetFen = yuanToFen(d.budgetYuan);
      const order = await request('POST', '/orders', body);
      wx.removeStorageSync(DRAFT_KEY);
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/order-detail/index?id=${order.id}&mode=customer` });
      }, 600);
    } catch (e) {
      this.setData({ submitting: false });
    }
  },
});
