const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { parseJson } = require('../../utils/format');
const { BASE_URL } = require('../../utils/config');
const ORIGIN = BASE_URL.replace(/\/api$/, '');

Page({
  data: {
    user: null,
    role: '',
    nickname: '',
    realName: '',
    intro: '',
    specialties: [],
    softwares: [],
    specialtiesStr: '',
    softwaresStr: '',
    avatarUrl: '',       // 仅用于预览显示（签名URL）
    avatarFileId: '',    // 保存到后端用
    uploading: false,
    saving: false,
  },
  onLoad() {
    const user = ensureLogin();
    if (!user) return;
    const specialties = parseJson(user.engineer?.specialties) || [];
    const softwares = parseJson(user.engineer?.softwares) || [];
    this.setData({
      user,
      role: user.role,
      nickname: user.nickname || '',
      avatarUrl: user.avatarUrl || '',
      avatarFileId: '',   // 未修改头像时为空，保存时跳过
      realName: user.engineer?.realName || '',
      intro: user.engineer?.intro || '',
      specialties,
      softwares,
      specialtiesStr: specialties.join('，'),
      softwaresStr: softwares.join('，'),
    });
  },

  pickAvatar() {
    const that = this;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['original', 'compressed'],
      success: async (r) => {
        that.setData({ uploading: true });
        try {
          const up = await upload(r.tempFiles[0].tempFilePath, { kind: 'IMAGE' });
          // 只保存 fileId，显示用临时预览路径
          const previewUrl = r.tempFiles[0].tempFilePath;
          that.setData({ avatarUrl: previewUrl, avatarFileId: up.fileId, uploading: false });
        } catch (e) {
          that.setData({ uploading: false });
          wx.showToast({ title: '上传失败', icon: 'none' });
        }
      },
    });
  },

  inputNickname(e) { this.setData({ nickname: e.detail.value }); },
  inputRealName(e) { this.setData({ realName: e.detail.value }); },
  inputIntro(e) { this.setData({ intro: e.detail.value }); },
  inputSpecialties(e) {
    const str = e.detail.value;
    this.setData({
      specialtiesStr: str,
      specialties: str.split(/[，,\s]+/).map(x => x.trim()).filter(x => x),
    });
  },
  inputSoftwares(e) {
    const str = e.detail.value;
    this.setData({
      softwaresStr: str,
      softwares: str.split(/[，,\s]+/).map(x => x.trim()).filter(x => x),
    });
  },

  async save() {
    const { nickname, realName, intro, specialties, softwares, avatarFileId, user } = this.data;
    if (!nickname.trim()) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const payload = { nickname: nickname.trim() };
      if (avatarFileId) payload.avatarFileId = avatarFileId;  // 只有改了头像才传
      if (user.role === 'ENGINEER') {
        payload.engineer = { realName, intro, specialties, softwares };
      }
      const updated = await request('PATCH', '/me', payload);
      // 头像 URL 是相对路径，存 storage 前补全为绝对路径，重启后直接可用
      if (updated.avatarUrl && updated.avatarUrl.startsWith('/')) {
        updated.avatarUrl = ORIGIN + updated.avatarUrl;
      }
      wx.setStorageSync('user', updated);
      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  },
});
