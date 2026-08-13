function statusOf(user) {
  return user?.identity?.verifyStatus || user?.engineer?.verifyStatus || user?.verifyStatus || 'PENDING';
}

function isApproved(user) { return statusOf(user) === 'APPROVED'; }

function promptIdentity(action, cancelBack) {
  wx.showModal({
    title: '需要身份认证',
    content: `${action || '使用该功能'}前需完成身份认证并通过审核。`,
    confirmText: '去认证',
    success: ({ confirm }) => {
      if (confirm) wx.navigateTo({ url: '/pages/engineer-qualification/index' });
      else if (cancelBack) wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) });
    },
  });
}

module.exports = { statusOf, isApproved, promptIdentity };
