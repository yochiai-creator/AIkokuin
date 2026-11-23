// AI刻印カメラ（docs/camera/index.html）のテスト: カメラは canvas の映像で代用し、
// 空の台 → 容器が入って止まる → 自動で撮る → どくまで撮らない → 次の容器 → 写真の保存（Exif の撮影日時つき）
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const results = [];
// JPEG の大きさ（SOF の幅・高さ）
function jpegSize(b) {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xFF) return null;
    const mk = b[o + 1], len = b.readUInt16BE(o + 2);
    if (mk >= 0xC0 && mk <= 0xC2) return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
    o += 2 + len;
  }
  return null;
}
function check(name, ok, detail) {
  results.push(!!ok);
  console.log((ok ? 'PASS' : 'FAIL') + '  カメラ: ' + name + (ok || detail === undefined ? '' : '  → ' + detail));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  page.on('pageerror', e => check('ページでJSエラーなし', false, e.message));
  await page.addInitScript(() => {
    try { localStorage.setItem('aikc.mode', '"stop"'); } catch (e) { /* file:// で使えなければ既定のまま */ }
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360;
    window.__scene = 'empty';
    const paint = () => {
      const g = cv.getContext('2d');
      g.fillStyle = '#777'; g.fillRect(0, 0, 640, 360);
      if (window.__scene === 'a') { g.fillStyle = '#eee'; g.fillRect(200, 100, 240, 170); g.fillStyle = '#000'; g.font = '30px sans-serif'; g.fillText('HEP 36815', 230, 200); }
      if (window.__scene === 'b') { g.fillStyle = '#ddd'; g.beginPath(); g.arc(320, 180, 95, 0, 7); g.fill(); g.fillStyle = '#000'; g.font = '30px sans-serif'; g.fillText('HEP 37439', 250, 190); }
      if (window.__scene === 'hand') { g.fillStyle = '#c96'; g.fillRect(150 + Math.random() * 200, 80, 120, 200); }
    };
    paint(); setInterval(paint, 50);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.resolve(cv.captureStream(20)) } });
    Object.defineProperty(navigator, 'canShare', { value: () => false });
    Object.defineProperty(navigator, 'wakeLock', { value: undefined });
  });
  await page.goto('file://' + path.join(__dirname, '..', 'docs', 'camera', 'index.html'));
  await page.waitForTimeout(800);
  const shots = () => page.evaluate(() => window.__aikc.shots.length);
  const scene = s => page.evaluate(x => { window.__scene = x; }, s);

  check('カメラが起動して「開始」を押せる', !(await page.isDisabled('#btnRun')));
  await page.click('#btnRun'); await page.waitForTimeout(600);
  check('開始すると空の台を覚えて見張る', (await page.textContent('#state')).includes('見張り中'), await page.textContent('#state'));
  await page.waitForTimeout(800);
  check('空のあいだは撮らない', (await shots()) === 0);

  // 手が範囲の中で動いているあいだは撮らない
  await scene('hand'); await page.waitForTimeout(1200);
  check('動いているあいだは撮らない', (await shots()) === 0, await shots());

  // 容器Aが入って止まる → 0.6秒後に2枚
  await scene('a'); await page.waitForTimeout(2000);
  check('容器が入って止まったら自動で2枚撮る', (await shots()) === 2, await shots());
  await page.waitForTimeout(1500);
  check('同じ容器が置かれたままなら撮り直さない', (await shots()) === 2, await shots());
  check('撮った後は「どかすと次を撮ります」', (await page.textContent('#state')).includes('どかす'), await page.textContent('#state'));

  // どかして、容器Bが入る
  await scene('empty'); await page.waitForTimeout(700);
  await scene('b'); await page.waitForTimeout(2000);
  check('どかして次の容器が来たら、また2枚撮る', (await shots()) === 4, await shots());

  // 容器Aの次にすぐ容器Bに入れ替わる（空にならない）場合も撮る
  await scene('a'); await page.waitForTimeout(2000);
  check('空にならずに次の容器に入れ替わっても撮る', (await shots()) === 6, await shots());

  // 保存（共有できない環境: ダウンロード）。Exif の撮影日時が入っている
  const downloads = [];
  page.on('download', d => downloads.push(d));
  await page.click('#btnSave'); await page.waitForTimeout(2500);
  check('「写真に保存」で全部渡し、手元から消す', downloads.length === 6 && (await shots()) === 0, downloads.length + ' / ' + await shots());
  if (downloads.length) {
    const p = await downloads[0].path(), buf = fs.readFileSync(p);
    const txt = buf.slice(0, 200).toString('latin1');
    check('写真に Exif の撮影日時（1秒未満まで）が入る・ファイル名も撮影時刻', buf[0] === 0xFF && buf[1] === 0xD8 && txt.includes('Exif') && /\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(txt) &&
      /^AIK_\d{8}_\d{6}_\d{3}\.jpg$/.test(downloads[0].suggestedFilename()), downloads[0].suggestedFilename());
  }
  if (downloads.length) {
    const sz = jpegSize(fs.readFileSync(await downloads[0].path()));
    // 映像 640×360・枠 (0.25,0.34,0.5,0.29) → 保存する範囲は 左右に35%（x 0.075〜0.925）・上に1.2倍・下に0.4倍（y 0〜0.746） → 544×269
    check('保存する範囲（刻印のまわり）だけを縮めずに保存', sz && sz.w === 544 && sz.h === 269, JSON.stringify(sz));
  }
  await page.click('#btnShot'); await page.waitForTimeout(500);
  check('「手動で撮る」でも撮れる', (await shots()) === 1);
  // 撮った写真の小さな画像をタップすると大きく出る
  await page.click('#thumbs img'); await page.waitForTimeout(200);
  check('写真をタップすると大きく見られる', await page.isVisible('#big') && (await page.getAttribute('#bigImg', 'src')).startsWith('data:image/jpeg'));
  await page.click('#big'); await page.waitForTimeout(100);
  check('名前は「LPG刻印カメラ」', (await page.title()) === 'LPG刻印カメラ');
  await page.close();

  // ---- 流れるモード（既定）: 刻印が枠を左から右へ流れて通り過ぎたら撮る
  const fp = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  fp.on('pageerror', e => check('ページでJSエラーなし(流れる)', false, e.message));
  await fp.addInitScript(() => {
    try { localStorage.setItem('aikc.trigger', '"stamp"'); } catch (e) { /* 既定のまま */ }
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360;
    window.__x = null;   // 刻印の左端（null なら刻印なし＝なめらかな塗装だけ）
    const paint = () => {
      const g = cv.getContext('2d');
      g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 640, 360);   // 容器の塗装（なめらか）
      if (window.__x !== null) { g.fillStyle = '#555'; g.font = 'bold 34px monospace'; g.fillText('HEP 36815 W34.9', window.__x, 190); }
    };
    paint(); setInterval(paint, 33);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.resolve(cv.captureStream(30)) } });
  });
  await fp.goto('file://' + path.join(__dirname, '..', 'docs', 'camera', 'index.html'));
  await fp.waitForTimeout(800);
  const fshots = () => fp.evaluate(() => window.__aikc.shots.length);
  check('流れる: 既定は「流れる」で、枠は「刻印の型: 50kg」', (await fp.textContent('#zone .lbl')) === '刻印の型: 50kg' && (await fp.textContent('#btnRun')).includes('刻印がない'), await fp.textContent('#zone .lbl'));
  const tmpl = await fp.$$eval('#tmpl textPath', els => els.map(e => e.textContent));
  check('流れる: 枠の中に刻印配置図の並び（50kg: ※◇／LPガス V 117.5 TP3.0M／HEA 00001 W 34.9 12-26）を弧で描く',
    tmpl.length === 3 && tmpl[1] === 'LPガス  V 117.5  TP3.0M' && tmpl[2] === 'HEA 00001  W 34.9  12-26' && (await fp.$$('#tmpl .band')).length === 3, JSON.stringify(tmpl));
  await fp.click('#btnRun'); await fp.waitForTimeout(1500);
  check('流れる: 開始すると、ふだんの様子を覚えてから見張る', (await fp.textContent('#state')).includes('見張り中'), await fp.textContent('#state'));
  // 刻印が左の外から右の外へ 約1.3秒で流れる（止まらない）
  const pass = async () => {
    for (let x = -330; x <= 660; x += 25) { await fp.evaluate(v => { window.__x = v; }, x); await fp.waitForTimeout(33); }
    await fp.evaluate(() => { window.__x = null; }); await fp.waitForTimeout(600);
  };
  await pass();
  check('流れる: 刻印が枠を1回通ったら、1本あたりの枚数（2枚）撮る', (await fshots()) === 2 && await fp.evaluate(() => window.__aikc.passes) === 1, await fshots());
  await fp.waitForTimeout(1000);
  check('流れる: 刻印がないあいだは撮らない', (await fshots()) === 2);
  await pass(); await pass();
  check('流れる: 続けて流れてきた2本もそれぞれ撮る（合計3本・6枚）', (await fshots()) === 6 && await fp.evaluate(() => window.__aikc.passes) === 3, await fshots());
  // 容器の種類を20kg（特殊配置）に変えると型が変わり、枠が型の縦横に合う
  await fp.click('#btnSet'); await fp.selectOption('#sKind', '20kg'); await fp.waitForTimeout(200);
  const t20 = await fp.$$eval('#tmpl textPath', els => els.map(e => e.textContent));
  const zr = await fp.evaluate(() => { const el = document.getElementById('zone'); return parseFloat(el.style.width) / parseFloat(el.style.height); });
  // 20kg: 配置図の3段の並び（言葉ごとの位置は真上から撮った現場の写真 HXR 15185 から）
  const want20 = ['※', '◇', 'V', '47', 'LPガス', 'W', '16.6', 'HXP', '00001', '6-26', 'TP3.0M'];
  check('流れる: 20kg を選ぶと3段の型（内「※ ◇ V 47」・真ん中「LPガス W 16.6」・外「HXP 00001 6-26 TP3.0M」）になり、枠が型の縦横（約3.0:1）に合う',
    JSON.stringify(t20) === JSON.stringify(want20) && Math.abs(zr - 958 / 322) < 0.15 && (await fp.textContent('#zone .lbl')) === '刻印の型: 20kg', JSON.stringify(t20) + ' ' + zr);
  await fp.selectOption('#sKind', '50kg'); await fp.click('#btnSetClose');
  check('流れる: 本数と枚数を出す', (await fp.textContent('#count')) === '3 本・6 枚', await fp.textContent('#count'));
  await fp.close();

  // ---- 自動補正: 型と同じ並び（50kg）の刻印を、型から 右に30px・下に40px・1.12倍・8°傾けて描く → 「🎯 自動で合わせる」で寄る
  const ap = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  ap.on('pageerror', e => check('ページでJSエラーなし(自動補正)', false, e.message));
  await ap.addInitScript(() => {
    try { localStorage.setItem('aikc.trigger', '"stamp"'); } catch (e) { /* 既定のまま */ }
    const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
    window.__truth = { dx: 30, dy: 40, s: 1.12, rot: 8 * Math.PI / 180 };
    window.__stamp = true;
    const VB = { x: 130, y: 70, w: 740, h: 240 }, CX = 500, CY = -314;
    const lines = [{ r: 530, span: 0.56, fs: 44, text: 'LPガス V 117.5 TP3.0M' }, { r: 600, span: 0.62, fs: 46, text: 'HEP 36815 W 34.9 6-26' }];
    // 既定の枠 (0.25,0.34,0.5,0.29) の映像上の大きさ
    const zx = 0.25 * 1280, zy = 0.34 * 720, zw = 0.5 * 1280, zh = 0.29 * 720;
    const paint = () => {
      const g = cv.getContext('2d'), T = window.__truth;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, 1280, 720);
      if (!window.__stamp) return;
      const ccx = zx + zw / 2 + T.dx, ccy = zy + zh / 2 + T.dy, cs = Math.cos(T.rot), sn = Math.sin(T.rot);
      g.fillStyle = '#333';
      lines.forEach(L => {
        const n = L.text.length;
        for (let i = 0; i < n; i++) {
          const a = -L.span + 2 * L.span * (i + 0.5) / n;
          const px = CX + (L.r - L.fs * 0.1) * Math.sin(a), py = CY + (L.r - L.fs * 0.1) * Math.cos(a);
          const ux = ((px - VB.x) / VB.w - 0.5) * zw * T.s, uy = ((py - VB.y) / VB.h - 0.5) * zh * T.s;
          g.setTransform(1, 0, 0, 1, ccx + ux * cs - uy * sn, ccy + ux * sn + uy * cs);
          g.rotate(-a + T.rot);
          g.font = 'bold ' + Math.round(L.fs * zw / VB.w * T.s) + 'px monospace'; g.textAlign = 'center';
          g.fillText(L.text[i], 0, 0);
        }
      });
    };
    paint(); setInterval(paint, 50);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.resolve(cv.captureStream(20)) } });
  });
  await ap.goto('file://' + path.join(__dirname, '..', 'docs', 'camera', 'index.html'));
  await ap.waitForTimeout(1000);
  check('自動補正: 撮るたびの自動補正は既定でオフ（ボタンで合わせる）', !(await ap.evaluate(() => document.getElementById('cAutoFit').checked)));
  const zoneNow = () => ap.evaluate(() => JSON.parse(localStorage.getItem('aikc.zone') || 'null'));
  await ap.click('#btnFit'); await ap.waitForTimeout(500);
  const z1 = await zoneNow();
  const cx1 = z1 && (z1.x + z1.w / 2) * 1280 - 640, cy1 = z1 && (z1.y + z1.h / 2) * 720 - (0.34 + 0.145) * 720;
  check('自動補正: 「🎯 自動で合わせる」で型が実物の刻印に寄る（傾き 8°・右に30px・下に40px・1.12倍）',
    z1 && Math.abs(z1.rot * 180 / Math.PI - 8) <= 2.5 && Math.abs(cx1 - 30) <= 25 && Math.abs(cy1 - 40) <= 25 && Math.abs(z1.w / 0.5 - 1.12) <= 0.1,
    JSON.stringify({ rot: z1 && (z1.rot * 180 / Math.PI).toFixed(1), dx: cx1 && cx1.toFixed(0), dy: cy1 && cy1.toFixed(0), s: z1 && (z1.w / 0.5).toFixed(2), msg: await ap.textContent('#state') }));
  check('自動補正: 枠が傾いて表示される', (await ap.evaluate(() => document.getElementById('zone').style.transform)).startsWith('rotate('));
  // 刻印がないときに押しても動かさない
  await ap.evaluate(() => { window.__stamp = false; }); await ap.waitForTimeout(300);
  await ap.click('#btnFit'); await ap.waitForTimeout(300);
  const z2 = await zoneNow();
  check('自動補正: 刻印が写っていなければ動かさない', JSON.stringify(z2) === JSON.stringify(z1) && (await ap.textContent('#state')).includes('見つかりません'), await ap.textContent('#state'));
  // 元に戻す・型の傾きスライダー
  await ap.click('#btnUndoFit'); await ap.waitForTimeout(200);
  const z3 = await zoneNow();
  check('自動補正: 「↩ 元に戻す」で合わせる前に戻る', z3 && !z3.rot && Math.abs(z3.w - 0.5) < 1e-6, JSON.stringify(z3));
  await ap.click('#btnSet'); await ap.fill('#sRot', '6'); await ap.dispatchEvent('#sRot', 'input'); await ap.click('#btnSetClose');
  const z4 = await zoneNow();
  check('自動補正: 「型の傾き」で手で傾けられる', z4 && Math.abs(z4.rot * 180 / Math.PI - 6) < 0.01 && /^rotate\(6(\.0+)?deg\)$/.test(await ap.evaluate(() => document.getElementById('zone').style.transform)), JSON.stringify(z4));
  await ap.close();

  // ---- 緑のバルブで撮る（既定）: 緑の円（バルブのハンドル）が型の中心を通ったら撮る。遠くを通ったら撮らない
  const vp = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  vp.on('pageerror', e => check('ページでJSエラーなし(バルブ)', false, e.message));
  await vp.addInitScript(() => {
    // 20kg の型を画面の下寄りに置く（バルブが来るべき所＝型の弧の中心が画面の中に来るように）
    try { localStorage.setItem('aikc.kind', '"20kg"'); localStorage.setItem('aikc.zone', JSON.stringify({ x: 0.35, y: 0.605, w: 0.3, h: 0.179 })); } catch (e) { /* 既定のまま */ }
    const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
    window.__vx = null; window.__vy = 0;
    const paint = () => {
      const g = cv.getContext('2d');
      g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#3a3a40'; for (let x = 0; x < 1280; x += 90) g.fillRect(x, 0, 6, 720);   // コンベヤの板（模様）
      if (window.__vx !== null) {
        // バルブのハンドル: 緑の丸に浮き文字のような模様。__vblur のときはぶれた写り
        g.save(); if (window.__vblur) g.filter = 'blur(8px)';
        g.fillStyle = '#2e9e3e'; g.beginPath(); g.arc(window.__vx, window.__vy, 45, 0, 7); g.fill();
        g.strokeStyle = '#155a20'; g.lineWidth = 2;
        for (let k = -36; k <= 36; k += 6) { g.beginPath(); g.moveTo(window.__vx - 30, window.__vy + k * 0.8); g.lineTo(window.__vx + 30, window.__vy + k * 0.8); g.stroke(); }
        g.fillStyle = '#e8e8e8'; g.beginPath(); g.arc(window.__vx, window.__vy, 8, 0, 7); g.fill();
        g.restore();
      }
    };
    paint(); setInterval(paint, 33);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.resolve(cv.captureStream(30)) } });
  });
  await vp.goto('file://' + path.join(__dirname, '..', 'docs', 'camera', 'index.html'));
  await vp.waitForTimeout(800);
  const vshots = () => vp.evaluate(() => window.__aikc.shots.length);
  check('撮るきっかけの既定は「自動」（緑のバルブが見えればバルブで撮る）', await vp.evaluate(() => document.querySelector('input[name=trigger][value=auto]').checked));
  const tgt = { x: 0.5, y: 0.5 };   // バルブは画面の真ん中を通ったら撮る（型は使わない）
  check('バルブ: 型と「自動で合わせる」は出さない（型を合わせなくてよい）', await vp.evaluate(() => document.getElementById('zone').classList.contains('hidden') && document.getElementById('btnFit').classList.contains('hidden')));
  await vp.click('#btnRun'); await vp.waitForTimeout(1300);
  check('バルブ: 容器が来ないあいだは見張って、撮らない', (await vp.textContent('#state')).includes('見張り中') && (await vshots()) === 0, await vp.textContent('#state'));
  const valvePass = async (y) => {
    for (let x = 1350; x >= -70; x -= 15) { await vp.evaluate(([a, b]) => { window.__vx = a; window.__vy = b; }, [x, y]); await vp.waitForTimeout(33); }
    await vp.evaluate(() => { window.__vx = null; }); await vp.waitForTimeout(500);
  };
  await valvePass(tgt.y * 720);
  check('バルブ: 緑のバルブが型の中心を通ったら、1本あたりの枚数（2枚）撮る', (await vshots()) === 2 && await vp.evaluate(() => window.__aikc.passes) === 1, await vshots());
  await valvePass(tgt.y * 720);
  check('バルブ: 次の容器のバルブでも撮る（2本・4枚）', (await vshots()) === 4 && await vp.evaluate(() => window.__aikc.passes) === 2, await vshots());
  await valvePass(Math.min(700, tgt.y * 720 + 330));
  check('バルブ: 型の中心から遠い所を通ったバルブでは撮らない', (await vshots()) === 4, await vshots());
  await vp.evaluate(() => { window.__vblur = true; });
  await valvePass(tgt.y * 720);
  check('バルブ: ひどくぶれたバルブは撮らず、「ぶれて撮れなかった」と知らせる', (await vshots()) === 4 && (await vp.textContent('#state')).includes('ぶれて'), (await vshots()) + ' ' + await vp.textContent('#state'));
  await vp.close();

  // ---- 総重量シールで撮る（横から撮る画角）: 白地に黒い印刷のかたまりが枠の真ん中を通ったら撮る。動かない黒い印では撮らない
  const sp = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  sp.on('pageerror', e => check('ページでJSエラーなし(シール)', false, e.message));
  await sp.addInitScript(() => {
    localStorage.setItem('aikc.trigger', '"seal"'); localStorage.setItem('aikc.mode', '"flow"');
    localStorage.setItem('aikc.zone', JSON.stringify({ x: 0.05, y: 0.3, w: 0.9, h: 0.4 }));
    const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
    window.__sx = null;
    const paint = () => {
      const g = cv.getContext('2d');
      g.fillStyle = '#c8c4bc'; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#222'; g.fillRect(620, 380, 40, 12);   // 床の動かない黒い印（枠の真ん中）
      if (window.__sx !== null) {   // 容器の白い胴と、総重量シール（黒枠と数字）
        const x = window.__sx;
        g.fillStyle = '#e6e6e6'; g.fillRect(x - 260, 120, 520, 600);
        g.fillStyle = '#fff'; g.fillRect(x - 90, 300, 180, 80);
        g.strokeStyle = '#111'; g.lineWidth = 6; g.strokeRect(x - 90, 300, 180, 80);
        g.fillStyle = '#111'; g.font = 'bold 48px sans-serif'; g.fillText('17.1', x - 55, 358);
      }
    };
    paint(); setInterval(paint, 33);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.resolve(cv.captureStream(30)) } });
  });
  // その場で読む: 読み取り口の代わり（送られた写真の枚数と合言葉を覚えて、決まった読みを返す）
  const apiReqs = [];
  await sp.route('https://script.google.com/**', route => {
    const b = JSON.parse(route.request().postData() || '{}'); apiReqs.push(b);
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(b.ping ? { ok: b.token === 'aikotoba' } : { ok: true, id: b.id, read: { readable: true, symbol: 'HXR', number: '15378', tare_kg: '16.5', sure: apiReqs.length >= 2 } }) });
  });
  await sp.addInitScript(() => { localStorage.setItem('aikc.live', 'true'); localStorage.setItem('aikc.apiToken', '"aikotoba"'); });
  await sp.goto('file://' + path.join(__dirname, '..', 'docs', 'camera', 'index.html'));
  await sp.waitForTimeout(800);
  const sshots = () => sp.evaluate(() => window.__aikc.shots.length);
  check('シール: 型・枠・点線・「自動で合わせる」は出さず、真ん中に「シールと刻印がここを通ったら撮る」', await sp.evaluate(() => document.getElementById('zone').classList.contains('hidden') && document.getElementById('crop').classList.contains('hidden') && document.getElementById('btnFit').classList.contains('hidden') && !document.getElementById('vt').classList.contains('hidden') && document.getElementById('vt').getAttribute('data-label') === 'シールと刻印がここを通ったら撮る'));
  // 種類ごとに撮り方を覚える: 20kg はシール、50kg はバルブ。切り替えると戻る
  await sp.click('#btnSet');
  await sp.selectOption('#sKind', '20kg');
  await sp.check('input[name=trigger][value=seal]');
  const z20 = await sp.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('aikc.zone'))));
  await sp.selectOption('#sKind', '50kg');
  await sp.check('input[name=trigger][value=valve]');
  await sp.selectOption('#sKind', '20kg');
  const back20 = await sp.evaluate(() => [document.querySelector('input[name=trigger][value=seal]').checked, JSON.stringify(JSON.parse(localStorage.getItem('aikc.zone')))]);
  await sp.selectOption('#sKind', '50kg');
  const back50 = await sp.evaluate(() => document.querySelector('input[name=trigger][value=valve]').checked);
  check('種類ごとに撮り方を覚える（20kg＝シール・枠もそのまま、50kg＝バルブ）', back20[0] && back20[1] === z20 && back50, JSON.stringify([back20, z20, back50]));
  await sp.selectOption('#sKind', '20kg');
  await sp.click('#btnSet');
  await sp.click('#btnRun'); await sp.waitForTimeout(6500);
  check('シール: 容器がないあいだは（床の動かない黒い印があっても）撮らない', (await sshots()) === 0, await sshots());
  const sealPass = async () => {
    for (let x = 1500; x >= -220; x -= 12) { await sp.evaluate(a => { window.__sx = a; }, x); await sp.waitForTimeout(33); }
    await sp.evaluate(() => { window.__sx = null; }); await sp.waitForTimeout(1500);
  };
  await sealPass();
  check('シール: 容器が通ったら、1本あたりの枚数（2枚）撮る', (await sshots()) === 2 && await sp.evaluate(() => window.__aikc.passes) === 1, await sshots());
  await sealPass();
  check('シール: 次の容器でも撮る（2本・4枚）', (await sshots()) === 4 && await sp.evaluate(() => window.__aikc.passes) === 2, await sshots());
  await sp.waitForTimeout(800);
  const reads = await sp.$$eval('#reads .rd', els => els.map(e => e.textContent));
  const sent = apiReqs.filter(b => b.images);
  check('その場で読む: 1本ごとに写真2枚を合言葉つきで送り、番号・Wと「確定／要確認」を画面の下に出す',
    sent.length === 2 && sent.every(b => b.token === 'aikotoba' && b.images.length === 2 && b.thumb) && reads.length === 2 &&
    reads[0].includes('HXR 15378') && reads[0].includes('W16.5') && reads[0].includes('確定') && reads[1].includes('要確認'), JSON.stringify(reads) + ' ' + sent.length);
  const evs = apiReqs.filter(b => b.events).reduce((a, b) => a.concat(b.events), []).concat(await sp.evaluate(() => window.__aikcDebug.logQ()));
  check('テストのログ: 1本ごとの「撮影」と「読み取り」（かかった秒数つき）をカメラログに残す', evs.filter(e => e.type === '撮影').length === 2 &&
    evs.filter(e => e.type === '読み取り').length === 2 && evs.some(e => /撮ってから [0-9.]+秒/.test(e.detail)) && evs.every(e => e.trigger === 'seal'), JSON.stringify(evs.map(e => e.type + ':' + e.detail)));
  const gray = await sp.evaluate(async () => {
    const f = window.__aikc.shots[0], u = URL.createObjectURL(f), im = new Image(); im.src = u; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let maxDiff = 0;
    for (let i = 0; i < d.length; i += 4 * 97) maxDiff = Math.max(maxDiff, Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2]));
    return [maxDiff, c.width, c.height];
  });
  check('読みやすく加工（既定）: 保存した写真は白黒（凹凸の強調）で、画面全体の大きさ', gray[0] <= 6 && gray[1] === 1280 && gray[2] === 720, JSON.stringify(gray));
  await sp.close();

  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log('\n' + (results.length - failed) + ' / ' + results.length + ' PASS（カメラ）');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
