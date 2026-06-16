/* ============================================================
   AI Daily Dock · 图标生成器（纯 Node，无第三方依赖）
   运行：npm run icon  （或 node scripts/make-icon.cjs）
   产出：assets/icon.png (256)、assets/tray.png (32)
   绘制：暖橙圆角方 + 白色四角星（与产品 logo 一致）
   ============================================================ */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = u32(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([u32(data.length), typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])]); // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 绘制（超采样 4x 抗锯齿）----
const STAR_24 = [
  [12, 2.5], [13.7, 7.8], [19, 9.5], [13.7, 11.2],
  [12, 16.5], [10.3, 11.2], [5, 9.5], [10.3, 7.8]
];

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const hit = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function drawIcon(size) {
  const SS = 4;
  const W = size * SS;
  const rgba = Buffer.alloc(W * W * 4);

  const radius = size * 0.22;            // 圆角
  const margin = size * 0.06;            // 外边距（圆角外留透明）
  const squareL = margin, squareT = margin;
  const squareR = size - margin, squareB = size - margin;

  // 暖橙渐变（顶亮底深），贴近 oklch(71% .135 55) 强调色
  const top = [240, 168, 108];
  const bot = [220, 126, 72];

  // 星形映射到画布（24 单位 → 内部区域），居中、占 ~52%
  const starSize = size * 0.52;
  const starCx = size / 2, starCy = size / 2;
  const starPoly = STAR_24.map(([x, y]) => [
    starCx + (x - 12) / 24 * starSize,
    starCy + (y - 12) / 24 * starSize
  ]);

  for (let sy = 0; sy < W; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const x = sx / SS, y = sy / SS;
      let r = 0, g = 0, b = 0, a = 0;

      // 圆角矩形覆盖（仅四角做圆形裁剪）
      let inRound = false;
      if (x >= squareL && x <= squareR && y >= squareT && y <= squareB) {
        inRound = true;
        const nearLeft = x < squareL + radius;
        const nearRight = x > squareR - radius;
        const nearTop = y < squareT + radius;
        const nearBottom = y > squareB - radius;
        if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
          const ccx = nearLeft ? squareL + radius : squareR - radius;
          const ccy = nearTop ? squareT + radius : squareB - radius;
          if (Math.hypot(x - ccx, y - ccy) > radius) inRound = false; // 落在圆角外
        }
      }

      if (inRound) {
        const t = (y - squareT) / (squareB - squareT); // 0 顶 → 1 底
        r = lerp(top[0], bot[0], t);
        g = lerp(top[1], bot[1], t);
        b = lerp(top[2], bot[2], t);
        a = 255;
      }

      // 白色四角星叠加
      if (pointInPoly(x, y, starPoly)) {
        r = 255; g = 255; b = 255; a = 255;
      }

      const i = (sy * W + sx) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }

  // 超采样降采样：每 SSxSS 求平均
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const si = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          r += rgba[si]; g += rgba[si + 1]; b += rgba[si + 2]; a += rgba[si + 3];
        }
      }
      const n = SS * SS;
      const oi = (y * size + x) * 4;
      out[oi] = r / n; out[oi + 1] = g / n; out[oi + 2] = b / n; out[oi + 3] = a / n;
    }
  }
  return encodePNG(size, size, out);
}

// ---- 输出 ----
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const icon256 = drawIcon(256);
fs.writeFileSync(path.join(outDir, 'icon.png'), icon256);

const tray32 = drawIcon(32);
fs.writeFileSync(path.join(outDir, 'tray.png'), tray32);

console.log('✓ 已生成 assets/icon.png (256×256) 与 assets/tray.png (32×32)');
