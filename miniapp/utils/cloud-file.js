/** 云文件下载、打开和删除。服务端负责业务鉴权，小程序直接访问同环境云存储。 */

function errorMessage(error) {
  return String((error && (error.errMsg || error.message)) || '未知错误');
}

function cloudDownload(fileID) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID,
      success: resolve,
      fail: reject,
    });
  });
}

function getTempFileUrl(fileID) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
      reject(new Error('当前微信版本不支持获取云文件地址'));
      return;
    }
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: (result) => {
        const item = result.fileList && result.fileList[0];
        if (item && item.tempFileURL && (!item.status || item.status === 0)) {
          resolve(item.tempFileURL);
          return;
        }
        reject(new Error((item && (item.errMsg || item.message)) || '未取得云文件地址'));
      },
      fail: reject,
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

function previewImage(filePath) {
  return new Promise((resolve, reject) => {
    wx.previewImage({ urls: [filePath], current: filePath, success: resolve, fail: reject });
  });
}

function saveTempFile(filePath) {
  if (typeof wx.saveFile !== 'function') return Promise.resolve(filePath);
  return new Promise((resolve) => {
    wx.saveFile({
      tempFilePath: filePath,
      success: (result) => resolve(result.savedFilePath || filePath),
      fail: () => resolve(filePath),
    });
  });
}

async function downloadAndOpen(info) {
  let result;
  if (info.fileID && wx.cloud && typeof wx.cloud.downloadFile === 'function') {
    try {
      // wx.cloud 已在 app 启动时绑定 ENV_ID；官方下载参数只需 fileID。
      result = await cloudDownload(info.fileID);
    } catch (directError) {
      // 部分基础库/存储权限模式下直下失败，兼容为临时地址下载。
      try {
        result = await httpDownload(await getTempFileUrl(info.fileID));
      } catch (fallbackError) {
        console.error('[cloud-file] download failed', {
          direct: errorMessage(directError),
          fallback: errorMessage(fallbackError),
        });
        throw new Error('云文件读取失败，请检查云存储读取权限');
      }
    }
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
    await previewImage(filePath);
    return { mode: 'previewed' };
  }

  try {
    await openDocument(filePath, info.name);
    return { mode: 'opened' };
  } catch (openError) {
    // STP/ZIP/RAR 等格式微信不能直接预览。先持久化到小程序文件区，
    // 再尝试调起微信文件转发；转发不可用也不应把“已下载”误报为失败。
    const savedFilePath = await saveTempFile(filePath);
    try {
      await shareUnsupportedFile(savedFilePath, info.name);
      return { mode: 'shared' };
    } catch (shareError) {
      console.warn('[cloud-file] downloaded but cannot preview', {
        open: errorMessage(openError),
        share: errorMessage(shareError),
      });
      return {
        mode: 'saved',
        notice: `“${info.name || '附件'}”已下载，但微信暂不支持直接预览此格式。`,
      };
    }
  }
}

function deleteCloudFile(fileID) {
  if (!fileID || !wx.cloud || typeof wx.cloud.deleteFile !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    wx.cloud.deleteFile({
      fileList: [fileID],
      success: resolve,
      fail: (error) => reject(new Error(error.errMsg || '云文件清理失败')),
    });
  });
}

module.exports = { downloadAndOpen, deleteCloudFile };
