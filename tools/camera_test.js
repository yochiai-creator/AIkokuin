// AI刻印カメラ（docs/camera/index.html）のテスト: カメラは canvas の映像で代用し、
// 空の台 → 容器が入って止まる → 自動で撮る → どくまで撮らない → 次の容器 → 写真の保存（Exif の撮影日時つき）
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const results = [];
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
  await page.click('#btnShot'); await page.waitForTimeout(500);
  check('「手動で撮る」でも撮れる', (await shots()) === 1);
  await page.close();

  // ---- 流れるモード（既定）: 刻印が枠を左から右へ流れて通り過ぎたら撮る
  const fp = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  fp.on('pageerror', e => check('ページでJSエラーなし(流れる)', false, e.message));
  await fp.addInitScript(() => {
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
  check('流れる: 既定は「流れる」で、枠の名前は「刻印の枠」', (await fp.textContent('#zone .lbl')) === '刻印の枠' && (await fp.textContent('#btnRun')).includes('刻印がない'));
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
  await fp.close();

  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log('\n' + (results.length - failed) + ' / ' + results.length + ' PASS（カメラ）');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
