/** 云文件下载、打开和删除。服务端负责业务鉴权，小程序直接访问同环境云存储。 */
const { ENV_ID } = require('./config');

function cloudDownload(fileID) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      config: { env: ENV_ID },
      fileID,
      success: resolve,
      fail: (error) => reject(new Error(error.errMsg || '云文件下载失败')),
    });
  });
}

function httpDownload(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => res.statusCode === 200 ? resolve(res) : reject(new Error('下载失败')),
      fail: (error) => reject(new Error(error.errMsg || '下载失败')),
    });
  });
}

function openDocument(filePath, fileName) {
  const extMatch = /\.([a-zA-Z0-9]+)$/.exec(String(fileName || ''));
  const fileType = extMatch ? extMatch[1].toLowerCase() : '';
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath,
      fileType: fileType || undefined,
      showMenu: true,
      success: resolve,
      fail: reject,
    });
  });
}

function shareUnsupportedFile(filePath, fileName) {
  if (typeof wx.shareFileMessage !== 'function') {
    return Promise.reject(new Error('文件已下载，但当前微信版本不支持打开此格式'));
  }
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath,
      fileName: fileName || '附件',
      success: resolve,
      fail: (error) => reject(new Error(error.errMsg || '文件转发失败')),
    });
  });
}

async function downloadAndOpen(info) {
  let result;
  if (info.fileID && wx.cloud && typeof wx.cloud.downloadFile === 'function') {
    result = await cloudDownload(info.fileID);
  } else if (info.url) {
    result = await httpDownload(info.url);
  } else {
    throw new Error('当前环境不支持下载该云文件');
  }

  const filePath = result.tempFilePath;
  if (!filePath) throw new Error('下载完成但未取得本地文件');
  const isImage = String(info.mime || '').startsWith('image/')
    || /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(info.name || '');
  if (isImage) {
    wx.previewImage({ urls: [filePath], current: filePath });
    return;
  }

  try {
    await openDocument(filePath, info.name);
  } catch (_) {
    // STP/ZIP/RAR 等格式微信不能直接预览，交给微信文件分享面板。
    await shareUnsupportedFile(filePath, info.name);
  }
}

function deleteCloudFile(fileID) {
  if (!fileID || !wx.cloud || typeof wx.cloud.deleteFile !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    wx.cloud.deleteFile({
      config: { env: ENV_ID },
      fileList: [fileID],
      success: resolve,
      fail: (error) => reject(new Error(error.errMsg || '云文件清理失败')),
    });
  });
}

module.exports = { downloadAndOpen, deleteCloudFile };
