// ---------- AI刻印 読み取り口（LPG刻印カメラ用） ----------
// LPG刻印カメラ（GitHub Pages）が撮った写真を、その場で受け取って刻印を読み、結果を返す。
// 読んだ結果は AI刻印 のスプレッドシートの「カメラ読み取り」シートに1行ずつ残し、AIkokuin の入力画面の
// 「📷 カメラの読み取り」から確かめて成績表に入れる。
//
// カメラ（別のサイト）から呼べるように、この受け口だけは「誰でも呼べる」で公開し、合言葉で守る。
// 合言葉はここに書かない。この読み取り口のスクリプトプロパティ API_TOKEN に、自分で決めた合言葉（16文字以上を推奨）を入れる。
// 刻印を読む処理は AIkokuin 本体の gas/Kokuin.js をそのまま使う（tools/push_api.sh が送る前に写す）。
// スクリプトプロパティ: ANTHROPIC_API_KEY（必須）、API_TOKEN（必須・合言葉）、SPREADSHEET_ID（書く先のスプレッドシートを変えるとき）

const SPREADSHEET_ID_DEFAULT = '1qaNb6J_ZvD9IWsmdJYYYUnxDGDsGV442Uu59TpqRX8w';   // AI刻印（テスト版）のスプレッドシート
const CAMERA_SHEET = 'カメラ読み取り';
const CAMERA_HEADERS = ['受付日時', 'ID', '状態', '記号', '番号', '質量W(kg)', '内容積V(L)', '耐圧試験圧力TP(MPa)', '製造年月',
  '総重量シール(kg)', 'W検算', '容器種別（読取）', '確からしさ', '確定', '読み方', 'モデル', '備考', '端末', '撮影日時', '費用(USD)', '秒',
  'キャップのグループNo', 'グループNo照合', '小さな写真'];

function doGet() {
  return json_({ ok: true, service: 'AI刻印 読み取り口' });
}

function doPost(e) {
  const started = Date.now();
  let req;
  try { req = JSON.parse(e && e.postData && e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: '送られた内容が読めません' }); }
  if (!tokenOk_(req.token)) return json_({ ok: false, error: '合言葉が違います（LPG刻印カメラの ⚙「その場で読む」を確かめてください）' });
  if (req.ping) return json_({ ok: true, ping: true });
  try {
    const images = (req.images || []).slice(0, 4);
    if (!images.length) throw new Error('写真がありません');
    // まず速読（安いモデルで、同じ容器の写真をまとめて）。決めきれなければ精読（高精度のモデル）
    let r = readKokuin({ images: images, tier: 'fast' }), cost = r.cost_usd || 0, how = '速読 ' + images.length + '枚';
    if (!sureRead_(r)) {
      const p = readKokuin({ images: images, tier: 'precise' });
      cost += p.cost_usd || 0; how = '精読 ' + images.length + '枚';
      if (p.readable || !r.readable) r = p;
    }
    r.sure = sureRead_(r);
    r.how = how; r.cost_usd = cost; r.ms = Date.now() - started;
    const id = String(req.id || Utilities.getUuid());
    appendCamera_(id, r, req);
    return json_({ ok: true, id: id, read: r });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// 人が確かめなくてよい読み: 番号が全部読め、確からしさが高く、Wがあってシールとの検算が合わない（NG）ことがない
function sureRead_(r) {
  return !!(r && r.readable && r.confidence === 'high' && r.tare_kg && r.w_check !== 'NG' && r.group_check !== 'NG');
}

// 合言葉が未設定のあいだは誰も使えない
function tokenOk_(token) {
  const want = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!want || String(want).length < 8 || !token) return false;
  const h = function(x) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(x), Utilities.Charset.UTF_8)); };
  return h(token) === h(want);
}

function appendCamera_(id, r, req) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CAMERA_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CAMERA_SHEET);
    sh.getRange(1, 1, 1, CAMERA_HEADERS.length).setValues([CAMERA_HEADERS]);
    sh.setFrozenRows(1);
  }
  const thumb = String(req.thumb || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sh.appendRow([new Date(), id, '未入力', r.symbol || '', "'" + (r.number || ''), r.tare_kg || '', r.volume_l || '', r.test_pressure_mpa || '',
      "'" + (r.manufactured || ''), r.seal_kg || '', r.w_check || '', r.kind || '', r.confidence || '', r.sure ? '確定' : '要確認', r.how || '',
      r.model || '', r.note || '', String(req.device || ''), String(req.shotAt || ''), r.cost_usd || 0, Math.round((r.ms || 0) / 100) / 10,
      "'" + (r.cap_number || ''), r.group_check || '', thumb.length < 45000 ? thumb : '']);
  } finally {
    lock.releaseLock();
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---- AIkokuin 本体（gas/Code.js）にあって Kokuin.js が使うもの ----
let ssCache_ = null;
function getSpreadsheet_() {
  if (ssCache_) return ssCache_;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID_DEFAULT;
  ssCache_ = SpreadsheetApp.openById(id);
  return ssCache_;
}
// グループNo（gas/Code.js と同じ）
function groupNoOf_(kind, serial) {
  const k = String(kind || '').trim(), n = Number(serial);
  if (!(n > 0)) return '';
  if (/^(30kg|50kg)/.test(k)) return Math.floor((n - 1) / 100) + 1;
  if (/^(5kg|8kg|10kg|20kg)/.test(k)) return (Math.floor((n - 1) / 50) + 1) % 1000;
  return '';
}
