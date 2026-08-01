/** 云文件下载、打开和删除。服务端负责业务鉴权，小程序直接访问同环境云存储。 */

function errorMessage(error) {
  return String((error && (error.errMsg || error.message)) || '未知错误');
}

const STAGE_LABELS = {
  API_AUTH: '后端权限校验',
  CLOUD_READ: '云存储读取',
  TEMP_URL: '临时地址下载',
  LOCAL_FILE: '本地文件生成',
  IMAGE_PREVIEW: '图片预览',
  UNKNOWN: '未知阶段',
};

function diagnosticId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function stageError(stage, message, detail, traceId) {
  const error = new Error(message);
  error.stage = stage;
  error.detail = String(detail || message);
  error.traceId = traceId || diagnosticId();
  return error;
}

function formatDownloadError(error) {
  const stage = error && error.stage
    ? error.stage
    : (error && error.statusCode ? 'API_AUTH' : 'UNKNOWN');
  const label = STAGE_LABELS[stage] || stage;
  const detail = String((error && error.detail) || errorMessage(error)).slice(0, 280);
  const traceId = (error && error.traceId) || '无';
  return `失败阶段：${label}\n原因：${detail}\n诊断编号：${traceId}`;
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
  const traceId = diagnosticId();
  const fileName = (info && info.name) || '附件';
  console.log('[cloud-file] start', { traceId, fileName });
  if (!info || (!info.fileID && !info.url)) {
    throw stageError('API_AUTH', '服务端未返回文件地址', '响应中缺少 fileID/url', traceId);
  }
  let result;
  let source = '';
  if (info.fileID && wx.cloud && typeof wx.cloud.downloadFile === 'function') {
    try {
      // wx.cloud 已在 app 启动时绑定 ENV_ID；官方下载参数只需 fileID。
      result = await cloudDownload(info.fileID);
      source = 'direct';
      console.log('[cloud-file] direct download ok', { traceId });
    } catch (directError) {
      console.warn('[cloud-file] direct download failed', {
        traceId, reason: errorMessage(directError),
      });
      // 部分基础库/存储权限模式下直下失败，兼容为临时地址下载。
      try {
        result = await httpDownload(await getTempFileUrl(info.fileID));
        source = 'temp-url';
        console.log('[cloud-file] temp-url download ok', { traceId });
      } catch (fallbackError) {
        const detail = `直接下载：${errorMessage(directError)}；临时地址：${errorMessage(fallbackError)}`;
        const error = stageError('CLOUD_READ', '云文件读取失败', detail, traceId);
        console.error('[cloud-file] failed', {
          traceId,
          stage: error.stage,
          direct: errorMessage(directError),
          fallback: errorMessage(fallbackError),
        });
        throw error;
      }
    }
  } else if (info.url) {
    try {
      result = await httpDownload(info.url);
      source = 'http-url';
    } catch (httpError) {
      throw stageError('TEMP_URL', '临时地址下载失败', errorMessage(httpError), traceId);
    }
  } else {
    throw stageError(
      'CLOUD_READ', '当前微信版本不支持云文件下载', 'wx.cloud.downloadFile 不可用', traceId);
  }

  const filePath = result.tempFilePath;
  if (!filePath) {
    throw stageError(
      'LOCAL_FILE', '下载完成但未取得本地文件', `下载来源：${source || '未知'}`, traceId);
  }
  const isImage = String(info.mime || '').startsWith('image/')
    || /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(info.name || '');
  if (isImage) {
    try {
      await previewImage(filePath);
      return { mode: 'previewed', traceId };
    } catch (previewError) {
      const error = stageError(
        'IMAGE_PREVIEW', '图片已下载但预览失败', errorMessage(previewError), traceId);
      console.error('[cloud-file] failed', {
        traceId, stage: error.stage, reason: error.detail,
      });
      throw error;
    }
  }

  try {
    await openDocument(filePath, info.name);
    return { mode: 'opened', traceId };
  } catch (openError) {
    // STP/ZIP/RAR 等格式微信不能直接预览。先持久化到小程序文件区，
    // 再尝试调起微信文件转发；转发不可用也不应把“已下载”误报为失败。
    const savedFilePath = await saveTempFile(filePath);
    try {
      await shareUnsupportedFile(savedFilePath, info.name);
      return { mode: 'shared', traceId };
    } catch (shareError) {
      console.warn('[cloud-file] downloaded but cannot preview', {
        open: errorMessage(openError),
        share: errorMessage(shareError),
      });
      return {
        mode: 'saved',
        traceId,
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

module.exports = { downloadAndOpen, deleteCloudFile, formatDownloadError };
