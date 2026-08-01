/** 发布需求：五步表单（方案 3.1.2），本地草稿，文件直传后携 fileIds 提交。 */
const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { deleteCloudFile } = require('../../utils/cloud-file');
const { yuanToFen } = require('../../utils/format');

const DRAFT_KEY = 'publishDraft';
const MAX_ATTACHMENTS = 20;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function attachmentKind(name, mime) {
  const filename = String(name || '').toLowerCase();
  if (String(mime || '').startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|bmp)$/.test(filename)) return 'IMAGE';
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|csv)$/.test(filename)) return 'DOC';
  return 'MODEL';
}

function sizeText(bytes) {
  const size = Number(bytes || 0);
  if (!size) return '大小未知';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

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
    uploadProgress: '',
    maxAttachments: MAX_ATTACHMENTS,
    // 步骤5
    agreed: false,
    submitting: false,
  },
  async onLoad() {
    if (!ensureLogin()) return;
    const draft = wx.getStorageSync(DRAFT_KEY);
    if (draft) this.setData(draft);
    try {
      this.setData({ dicts: await request('GET', '/dicts') });
    } catch (e) {
      wx.showToast({ title: e.message || '基础配置加载失败', icon: 'none' });
    }
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
    if (s === 4 && d.uploading) return wx.showToast({ title: '请等待附件上传完成', icon: 'none' });
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
    const remaining = MAX_ATTACHMENTS - this.data.files.length;
    if (remaining <= 0) return wx.showToast({ title: `最多上传${MAX_ATTACHMENTS}个附件`, icon: 'none' });
    wx.chooseMessageFile({
      count: Math.min(3, remaining),
      type: 'all',
      success: async (r) => {
        const selected = (r.tempFiles || []).slice(0, remaining);
        if (!selected.length) return;
        const failures = [];
        this.setData({ uploading: true, uploadProgress: `准备上传 1/${selected.length}` });
        for (let i = 0; i < selected.length; i += 1) {
          const f = selected[i];
          this.setData({ uploadProgress: `正在上传 ${i + 1}/${selected.length}` });
          if (Number(f.size || 0) > MAX_FILE_BYTES) {
            failures.push(`${f.name || '文件'}：超过30MB`);
            continue;
          }
          try {
            const kind = attachmentKind(f.name, f.type);
            const mime = String(f.type || '').includes('/') ? f.type : '';
            const up = await upload(f.path, {
              kind,
              name: f.name || '',
              mime,
            });
            this.setData({
              files: this.data.files.concat({
                fileId: up.id || up.fileId,
                name: up.name || f.name,
                sizeText: sizeText(up.sizeBytes || f.size),
                kind,
              }),
            });
          } catch (err) {
            failures.push(`${f.name || '文件'}：${err.message || '上传失败'}`);
          }
        }
        this.setData({ uploading: false, uploadProgress: '' });
        if (!failures.length) {
          wx.showToast({ title: '上传成功', icon: 'success' });
        } else {
          wx.showModal({
            title: this.data.files.length ? '部分附件未上传' : '附件上传失败',
            content: failures.join('\n').slice(0, 500),
            showCancel: false,
          });
        }
      },
    });
  },
  async removeFile(e) {
    if (this.data.uploading) return wx.showToast({ title: '请等待上传完成', icon: 'none' });
    const files = this.data.files.slice();
    const index = Number(e.currentTarget.dataset.i);
    const removed = files[index];
    if (!removed) return;
    if (removed && (removed.fileId || removed.id)) {
      try {
        const deleted = await request(
          'DELETE', `/files/${removed.fileId || removed.id}`, null, { silent: true });
        files.splice(index, 1);
        this.setData({ files });
        try {
          await deleteCloudFile(deleted.fileID);
        } catch (cleanupError) {
          wx.showToast({ title: cleanupError.message || '云文件清理失败', icon: 'none' });
        }
      } catch (err) {
        wx.showToast({ title: err.message || '附件删除失败', icon: 'none' });
      }
    } else {
      files.splice(index, 1);
      this.setData({ files });
    }
  },

  deliveryDays() {
    const opt = this.data.dicts.deliveryOptions.find((o) => o.key === this.data.deliveryKey);
    if (!opt) return 7;
    return opt.days || parseInt(this.data.customDays, 10) || 0;
  },
  async submit() {
    const d = this.data;
    if (d.submitting) return;
    if (d.uploading) return wx.showToast({ title: '请等待附件上传完成', icon: 'none' });
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
      wx.showToast({ title: e.message || '发布失败，请重试', icon: 'none' });
      this.setData({ submitting: false });
    }
  },
});
