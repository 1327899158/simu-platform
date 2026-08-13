/** 发布需求：五步表单（方案 3.1.2），本地草稿，文件直传后携 fileIds 提交。 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { deleteCloudFile } = require('../../utils/cloud-file');
const { yuanToFen } = require('../../utils/format');
const { digits, money, validMoney } = require('../../utils/input');
const { isApproved, promptIdentity } = require('../../utils/identity');

const MAX_ATTACHMENTS = 20;
const DEFAULT_MAX_FILE_MB = 30;

/**
 * 草稿按用户隔离：不同用户读不到彼此未提交的草稿。
 * key 格式：publishDraft_<userId>，避免全局共享键导致串号。
 */
function draftKey(userId) {
  return `publishDraft_${userId || 'anonymous'}`;
}

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

function customTags(tags, other) {
  const result = (tags || []).filter((item) => item && item !== '其他');
  const value = String(other || '').trim();
  if (value && !result.includes(value)) result.push(value);
  return result;
}

function mediaFile(file, index) {
  const path = file.tempFilePath || file.path || '';
  const fileType = file.fileType || file.type || 'image';
  const pathExt = /\.([a-zA-Z0-9]{1,12})(?:$|\?)/.exec(path);
  const ext = pathExt ? pathExt[1].toLowerCase() : (fileType === 'video' ? 'mp4' : 'jpg');
  return {
    path,
    size: Number(file.size || 0),
    name: file.name || `手机${fileType === 'video' ? '视频' : '图片'}_${Date.now()}_${index + 1}.${ext}`,
    type: fileType === 'video' ? 'video/mp4' : `image/${ext === 'jpg' ? 'jpeg' : ext}`,
  };
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
    softwareOptions: [],
    directionOptions: [],
    otherSoftware: '',
    otherDirection: '',
    // 步骤3
    deliveryKey: 'standard',
    customDays: '',
    specialNote: '',
    // 步骤4
    files: [], // {fileId, name, sizeText, kind}
    uploading: false,
    uploadProgress: '',
    maxAttachments: MAX_ATTACHMENTS,
    maxFileMb: DEFAULT_MAX_FILE_MB,
    maxFileBytes: DEFAULT_MAX_FILE_MB * 1024 * 1024,
    // 步骤5
    agreed: false,
    submitting: false,
  },
  async onLoad() {
    let user = ensureLogin();
    if (!user) return;
    this._userId = user.id;
    if (user.role !== 'CUSTOMER') {
      wx.showToast({ title: '仅客户可以发布需求', icon: 'none' });
      setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }), 500);
      return;
    }
    try {
      user = await request('GET', '/me', null, { silent: true });
      wx.setStorageSync('user', user);
    } catch (_) {}
    if (!isApproved(user)) {
      promptIdentity('发布需求', true);
      return;
    }
    const draft = wx.getStorageSync(draftKey(user.id));
    if (draft) {
      this.setData({
        ...draft,
        softwareTags: (draft.softwareTags || []).filter((item) => item !== '其他'),
        directionTags: (draft.directionTags || []).filter((item) => item !== '其他'),
      });
    }
    try {
      const dicts = await request('GET', '/dicts');
      const limits = dicts.limits || {};
      const maxFileMb = Number(limits.maxUploadMb) || DEFAULT_MAX_FILE_MB;
      const maxAttachments = Number(limits.maxOrderAttachments) || MAX_ATTACHMENTS;
      this.setData({
        dicts,
        softwareOptions: (dicts.softwares || []).filter((item) => item !== '其他'),
        directionOptions: (dicts.directions || []).filter((item) => item !== '其他'),
        maxFileMb,
        maxFileBytes: Number(limits.maxUploadBytes) || maxFileMb * 1024 * 1024,
        maxAttachments,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '基础配置加载失败', icon: 'none' });
    }
  },
  onUnload() {
    if (this.data.submitting) return;
    if (!this._userId) return;
    const { projectName, description, budgetYuan, budgetFlexible, softwareTags,
      directionTags, otherSoftware, otherDirection, deliveryKey, customDays, specialNote, files } = this.data;
    wx.setStorageSync(draftKey(this._userId), {
      projectName, description, budgetYuan, budgetFlexible, softwareTags,
      directionTags, otherSoftware, otherDirection, deliveryKey, customDays, specialNote, files,
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
      if (!customTags(d.softwareTags, d.otherSoftware).length || !customTags(d.directionTags, d.otherDirection).length) {
        return wx.showToast({ title: '请选择或填写仿真软件与方向', icon: 'none' });
      }
    } else if (s === 3) {
      const days = this.deliveryDays();
      if (!days || days < 1 || days > 90) return wx.showToast({ title: '请填写 1-90 天的工期', icon: 'none' });
    }
    if (s < 5) this.setData({ step: s + 1 });
    else this.submit();
  },

  input(e) {
    const field = e.currentTarget.dataset.f;
    let value = e.detail.value;
    if (field === 'budgetYuan') value = money(value);
    if (field === 'customDays') value = digits(value, 2);
    this.setData({ [field]: value });
    return value;
  },
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
    const remaining = this.data.maxAttachments - this.data.files.length;
    if (remaining <= 0) {
      return wx.showToast({ title: `最多上传${this.data.maxAttachments}个附件`, icon: 'none' });
    }
    let selectedIndex;
    try {
      const result = await new Promise((resolve, reject) => wx.showActionSheet({
        itemList: ['微信聊天文件（文档/压缩包等）', '手机相册/本地文件'],
        success: resolve,
        fail: reject,
      }));
      selectedIndex = result.tapIndex;
    } catch (e) {
      return;
    }
    if (selectedIndex === 0) this.chooseChatFiles(remaining);
    if (selectedIndex === 1) this.chooseLocalMedia(remaining);
  },

  chooseChatFiles(remaining) {
    wx.chooseMessageFile({
      count: Math.min(3, remaining),
      type: 'all',
      success: (r) => this.uploadFiles((r.tempFiles || []).slice(0, remaining)),
    });
  },

  chooseLocalMedia(remaining) {
    if (typeof wx.chooseMedia !== 'function') {
      return wx.showToast({ title: '当前微信版本不支持相册选择，请升级微信', icon: 'none' });
    }
    wx.chooseMedia({
      count: Math.min(3, remaining),
      mediaType: ['image', 'video'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (r) => this.uploadFiles((r.tempFiles || []).slice(0, remaining).map(mediaFile)),
    });
  },

  async uploadFiles(selected) {
    if (!selected.length) return;
    const oversized = selected.filter((f) => Number(f.size || 0) > this.data.maxFileBytes);
    if (oversized.length) {
      await new Promise((resolve) => wx.showModal({
        title: '文件超过大小限制',
        content: oversized.map((f) => `${f.name || '文件'}（${sizeText(f.size)}）`)
          .concat(`单个文件最大允许 ${this.data.maxFileMb}MB，请压缩或拆分后重新上传。`)
          .join('\n').slice(0, 500),
        showCancel: false,
        complete: resolve,
      }));
    }
    const uploadable = selected.filter((f) => Number(f.size || 0) <= this.data.maxFileBytes && f.path);
    if (!uploadable.length) return;
    const failures = [];
    this.setData({ uploading: true, uploadProgress: `准备上传 1/${uploadable.length}` });
    for (let i = 0; i < uploadable.length; i += 1) {
      const f = uploadable[i];
      this.setData({ uploadProgress: `正在上传 ${i + 1}/${uploadable.length}` });
      try {
        const kind = attachmentKind(f.name, f.type);
        const mime = String(f.type || '').includes('/') ? f.type : '';
        const up = await upload(f.path, { kind, name: f.name || '', mime });
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
    if (!failures.length) wx.showToast({ title: '上传成功', icon: 'success' });
    else wx.showModal({
      title: this.data.files.length ? '部分附件未上传' : '附件上传失败',
      content: failures.join('\n').slice(0, 500),
      showCancel: false,
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
    const softwareTags = customTags(d.softwareTags, d.otherSoftware);
    const directionTags = customTags(d.directionTags, d.otherDirection);
    if (!softwareTags.length || !directionTags.length) return wx.showToast({ title: '请选择或填写仿真软件与方向', icon: 'none' });
    const days = this.deliveryDays();
    if (!days || days < 1 || days > 90) return wx.showToast({ title: '请填写 1-90 天的工期', icon: 'none' });

    if (d.budgetYuan && !validMoney(d.budgetYuan)) {
      return wx.showToast({ title: '预算请输入1至1000万元，最多两位小数', icon: 'none' });
    }

    this.setData({ submitting: true });
    try {
      const body = {
        projectName: d.projectName.trim(),
        description: d.description.trim(),
        softwareTags,
        directionTags,
        deliveryDays: days,
        budgetFlexible: d.budgetFlexible,
        specialNote: (d.specialNote || '').trim() || undefined,
        fileIds: d.files.map((f) => f.fileId),
      };
      if (d.budgetYuan) body.budgetFen = yuanToFen(d.budgetYuan);
      const order = await request('POST', '/orders', body);
      wx.removeStorageSync(draftKey(this._userId));
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
