'use strict';
/** 最小 multipart/form-data 解析器（配合 wx.uploadFile 使用）。 */

function getBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return m ? (m[1] || m[2]).trim() : null;
}

/**
 * @param {Buffer} buf 完整请求体
 * @param {string} boundary
 * @returns {{fields: Object<string,string>, files: Array<{field:string,filename:string,contentType:string,data:Buffer}>}}
 */
function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let start = buf.indexOf(delim);
  while (start !== -1) {
    start += delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // 结束标记 --
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2; // CRLF
    const end = buf.indexOf(delim, start);
    if (end === -1) break;
    const part = buf.subarray(start, end - 2); // 去掉尾部 CRLF
    start = end;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const head = part.subarray(0, headerEnd).toString('utf8');
    const data = part.subarray(headerEnd + 4);
    const nameM = /name="([^"]*)"/.exec(head);
    if (!nameM) continue;
    const fileM = /filename="([^"]*)"/.exec(head);
    const ctM = /content-type:\s*([^\r\n]+)/i.exec(head);
    if (fileM) {
      files.push({
        field: nameM[1],
        filename: decodeURIComponent(fileM[1] || 'file'),
        contentType: ctM ? ctM[1].trim() : 'application/octet-stream',
        data,
      });
    } else {
      fields[nameM[1]] = data.toString('utf8');
    }
  }
  return { fields, files };
}

module.exports = { getBoundary, parseMultipart };
