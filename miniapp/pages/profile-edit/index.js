const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { parseJson } = require('../../utils/format');

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
    avatarUrl: '',       // 预览显示（cloud:// 或临时路径）
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
      avatarFileId: '',
      realName: user.engineer?.realName || '',
      intro: user.engineer?.intro || '',
      specialties,
      softwares,
      specialtiesStr: specialties.join('，'),
      softwaresStr: softwares.join('，'),
    });
  },

  // chooseAvatar 方式获取头像（微信推荐方式）
  onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl;
    this.setData({ avatarUrl: tempPath, avatarFileId: '' });
    // 异步上传到云存储
    this.setData({ uploading: true });
    upload(tempPath, { kind: 'IMAGE', name: 'avatar.jpg' })
      .then((up) => {
        this.setData({ avatarUrl: up.fileID, avatarFileId: up.fileID, uploading: false });
      })
      .catch((e) => {
        this.setData({ uploading: false });
        wx.showToast({ title: e.message || '头像上传失败', icon: 'none' });
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
      if (avatarFileId) payload.avatarUrl = avatarFileId;
      if (user.role === 'ENGINEER') {
        payload.engineer = { realName, intro, specialties, softwares };
      }
      const updated = await request('PATCH', '/me', payload);
      wx.setStorageSync('user', updated);
      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  },
});
