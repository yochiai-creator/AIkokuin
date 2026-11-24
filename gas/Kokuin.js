// ---------- 刻印の読み取り（AIkokuin で追加） ----------
// iPadで撮った動画・写真のコマ（JPEG）を Claude API に送り、容器の刻印を読む。
//   readKokuin({ images, tier, hints }) … 1本の容器を読むだけ（記録はしない）。tier: fast＝速読 / precise＝精読
//   saveKokuin(rec)                    … 入力に使った読み取り結果を「刻印記録」シートに1行足す
// APIキーはスクリプトプロパティ ANTHROPIC_API_KEY に入れる（コードやシートには書かない）。
// モデルはスクリプトプロパティ KOKUIN_MODEL_FAST（速読）・KOKUIN_MODEL（精読）で変えられる。

const KOKUIN_SHEET = '刻印記録';
// 指示（KOKUIN_SYSTEM・スキーマ・学習の足し方）を変えたら上げる。読み取りログに残し、変える前と後の正答率を比べる
const KOKUIN_PROMPT_VERSION = 'p22';
const KOKUIN_HEADERS = ['記録日時', 'ロットID', '容器番号', '読取 記号', '読取 番号', '内容積V(L)', '質量W(kg)',
  '耐圧試験圧力TP(MPa)', '製造年月', 'その他の刻印', '確からしさ', '入力のしかた', '入力者', '端末', 'Googleアカウント', 'モデル', '備考',
  '総重量シール(kg)', 'W検算', '容器種別（読取）', '刻印の年月（そのまま）', 'キャップのグループNo', 'グループNo照合'];
// 2段階で読む: まず全コマを速読（安いモデル）、確定できなかった容器だけ精読（高精度のモデルで複数コマをまとめて）。
// スクリプトプロパティ KOKUIN_MODEL_FAST / KOKUIN_MODEL で変えられる
const KOKUIN_MODEL_FAST_DEFAULT = 'claude-haiku-5-5';
const KOKUIN_MODEL_DEFAULT = 'claude-opus-5-5';
const KOKUIN_MAX_IMAGES = 4;   // 精読で1回に送るコマ数の上限
// 費用の目安（USD / 100万トークン。入力・出力）。キャッシュ読み出しは入力の0.1倍、書き込みは1.25倍
const KOKUIN_PRICES = { 'claude-haiku-5-5': [0.10, 0.50], 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10] };
const KOKUIN_API_URL = 'https://api.anthropic.com/v1/messages';
const KOKUIN_API_VERSION = '2026-10-21';
const KOKUIN_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const KOKUIN_IMAGE_MAX_CHARS = 4 * 1024 * 1024;   // base64で4MBまで（画面側で1600px・JPEGに縮めて送る）

// 容器種別（共有ドライブ「刻印読み取り_運用一式 / 容器種別判定リファレンス.txt」の9種類）。
// 名前はこのアプリの容器区分にそろえる（20kg 3P = 20kg三部制）
const KOKUIN_KINDS = ['5kg', '8kg', '10kg', '20kg', '20kg三部制', '30kg', '40kg', '50kg', '50kg S付', '不明'];

// 返してもらう形（構造化出力）。数値も刻印のまま文字で受け取り、読めない項目は空文字
// 写り具合: ok＝刻印の全部が十分な大きさで写っている / cut_left・cut_right・cut_top・cut_bottom＝刻印の段がその端で切れている /
// cut_many＝2方向以上で切れている（近すぎる） / too_small＝全部写っているが文字が小さい（遠すぎる） / no_stamp＝刻印が写っていない
const KOKUIN_FRAMING = ['ok', 'cut_left', 'cut_right', 'cut_top', 'cut_bottom', 'cut_many', 'too_small', 'no_stamp'];
const KOKUIN_SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean', description: '容器番号の5桁すべてを刻印から確定できたら true' },
    symbol: { type: 'string', description: '容器番号の記号（英字3文字。例 HXP）。読めない字は ?' },
    number: { type: 'string', description: '容器番号の数字5桁（例 78611）。読めない桁は ? のまま（例 78?11）' },
    volume_l: { type: 'string', description: '内容積 V（数字だけ。例 47）' },
    tare_kg: { type: 'string', description: '刻印の質量 W（容器自重、数字だけ。例 16.6）。読めない桁は ?' },
    seal_kg: { type: 'string', description: '総重量シール（印刷のシール）の値。写っていて読めるときだけ（例 17.1）' },
    test_pressure_mpa: { type: 'string', description: '耐圧試験圧力 TP（数字だけ。例 3.0）' },
    manufactured: { type: 'string', description: '刻印の年月を刻印のとおりに（例 7-26）' },
    kind: { type: 'string', enum: KOKUIN_KINDS, description: '容器種別' },
    cap_number: { type: 'string', description: 'バルブのキャップ・保護フィルムに手書きされたグループNo（数字だけ。例 369）。写っていなければ空文字' },
    other: { type: 'string', description: 'そのほかに読めた刻印（LPガス・菱形マーク・※など以外の記号）を空白区切りで' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '容器番号とWの読みの確からしさ' },
    note: { type: 'string', description: '迷った桁・反射・重ね打ちなど（短く。なければ空文字）' },
    upright: { type: 'string', enum: ['0', '90', '180', '270'], description: '写真全体を正しい向き（床や台が下、容器が立って見える）にするには時計回りに何度回すか。正しい向きなら 0' },
    framing: { type: 'string', enum: KOKUIN_FRAMING, description: '写り具合（カメラの向き・ズームを自動で直すのに使う）。刻印の段が画面の端で切れていればその向き' }
  },
  required: ['readable', 'symbol', 'number', 'volume_l', 'tare_kg', 'seal_kg', 'test_pressure_mpa', 'manufactured', 'kind', 'cap_number', 'other', 'confidence', 'note', 'framing', 'upright'],
  additionalProperties: false
};

// 共有ドライブ「刻印読み取り_運用一式」（共通ルール・容器種別判定リファレンス・W判定ルール・字体リファレンス）の要点。
// あちらのルールが更新されたら、ここも合わせる
const KOKUIN_SYSTEM = [
  'あなたは野田組の検査ラインで、LPガス容器（神鋼機器工業製）の肩部に打刻された刻印を読み取る係です。写真はラインを撮った動画の1コマです。',
  '・写真は、淡い刻印を読みやすくするため白黒にして凹凸を強調してあることがある（打刻の凹みが明暗の縁取りとして浮き出る。反射の所はざらつく）。容器の向きはまちまちで、刻印が逆さま・斜めに写ることもある。',
  '',
  '【基本原則】',
  '・読むのは金属の打刻刻印だけ。シール・ラベルの印刷文字は刻印として読まない（総重量シールは seal_kg に入れて検算にだけ使う）。',
  '・画像で実際に読めた文字を最優先する。番号の範囲や傾向に合わせて読みを変えない。',
  '・読めない字は ? のまま残す。推測でそれらしい数字を埋めない。容器番号に ? が残れば readable は false。',
  '・自信がないときは正直に confidence を下げる。人が確認する仕組みなので、それが一番役に立つ。',
  '',
  '【刻印の構成】肩部に円弧状に並ぶ: 記号（英字3文字）＋容器番号5桁（例 HXP 78611）／LPガス／V値（内容積）／W値（容器自重、小数第1位まで。例 W16.6）／年月（例 7-26）／TP3.0M／菱形マーク・※。',
  '・20kgは特殊配置で、V47とW値が縦2段に重なり、年月・TPが斜めに散る。位置で機械的に読まず、記号/番号/V/W/年月/TP をラベルで見分けてから読む。',
  '・字体は数字がOCRB書体（タイプライター用R型）、英字はR型。迷ったらOCRBの字形で照合する。記号の英字はA〜Zのどれもあり得る。',
  '・年月は「月-年（西暦下2桁）」。7-26 は2026年7月。刻印のとおり manufactured に書く。TPは TP3.0M が正（小数点が見えなくても 3.0）。',
  '・V値は小数点が見えないことがある。50kgの「V1175」は 117.5、5kgの「V118」は 11.8、10kgの「V235」は 23.5、30kgの「V705」は 70.5、40kgの「V855」は 85.5 として volume_l に書く。',
  '・50kg（標準2段）の例: 上段「※ ◇」の下に「LPガス V1175 TP3.0M」、その下の段に「HEP 36815 W 34.9 6-26」。総重量シール（「軽量 総重量 35.4kg」）は刻印の左上に貼られている。',
  '・バルブのキャップ（保護フィルム）に手書きの数字があれば、それはグループNo（容器番号から決まる組の番号。例 50kgの 36815 → 369）。cap_number に書く。刻印として読めない桁を埋めるのには使わない。',
  '',
  '【誤読しやすい字形】',
  '・0とC: 0の右側が反射で欠けるとCに見える。刻印の数字の位置にCは出ないので、C様の字形は0と判断する。',
  '・6/8/0/5: 6は下だけ閉じて上が開く、8は上下とも閉じる、0は全閉、5は上部が横棒で角張る。反射で6の下の輪が切れると5に見える。',
  '・1/7/4: 7は上部に横棒、4は縦横の交差がある、1はどちらもない。暗部・反射で横棒が消えると1に見える。',
  '・6/9: 6は尾が輪の内側、9は尾が輪の下に垂れる。0/9: 9には下に尾がある。2/3/5: 3は二段の丸み、2は一段のカーブ、5は上部横棒。',
  '・中央の桁（3・4桁目）と末尾の桁は反射で最も誤読しやすい。迷った桁があれば confidence を medium 以下にして note に書く。',
  '・容器番号は必ず5桁。番号の1桁目は記号のすぐ右で、取っ手の溶接跡（丸い跡）やロープの影に重なりやすい。細い「1」は見落としたり「7」と読んだりしやすい（現場で 16338→76338、16345→?9345 と読み違えた）。',
  '  見えた数字が4桁しかないときは、1桁目が隠れているとして ?（例 ?6345）にする。数字を左へずらして5桁を作らない。1桁目が「7」に見えたら上の横棒が本当にあるか確かめる。',
  '',
  '【W値の検算】刻印W ＋ 0.5kg ＝ 総重量シールの値（差はバルブ分）。',
  '・シールが読めたら seal_kg に入れる。Wとシールが合わなければ、Wか番号の誤読を疑い confidence を low にする。',
  '・Wの末尾桁が反射で読めないときは ? のままにする（シールからの逆算はこちらで行う）。',
  '・Wはバッチ内でも 16.5/16.6/16.7/16.8 などが混在する。決めつけず刻印を読む。',
  '',
  '【容器種別（kind）】記号の頭2文字・V値・Wのおおまかな範囲・配置の型で決める。決められなければ 不明。',
  '・5kg: 記号HR系 V11.8 W約6.8 ／ 8kg: HX系 V19 W約9.6 ／ 10kg: HC系 V23.5 W約11.2',
  '・20kg: HX系（現行HXP）V47 W約16.5〜16.9 特殊配置 ／ 20kg三部制: HH系 V47 W約17.5 標準2段',
  '・30kg: HA系 V70.5 W約23.9 ／ 40kg: HD系 V85.5 W約28.4',
  '・50kg: HE系 V117.5 W約34.6〜35.1 ／ 50kg S付: HH系 V117.5 W約36.2',
  '・記号は番号が99999に達すると3文字目が1つ進む（HXP 99999 → HXQ 00001）。',
  '',
  '【confidence】high = この1枚で全桁が明瞭に確定（Wとシールが読めれば検算も合う）。medium = 一部の桁に迷いがあるが最善の読みがある。low = 検算が合わない、または確定できない。',
  '刻印が写っていない・ぼけている・光って読めないときは readable を false にして、理由を note に短く書く。',
  '',
  '【写り具合 framing】カメラを自動で直すために、写真（複数枚なら一番よい1枚）の写り具合を1つ選ぶ。',
  '・刻印の段（記号・番号・W・年月・TPの並び）の一部が写真の端で切れていれば、切れている端の向き（cut_left / cut_right / cut_top / cut_bottom。写真の上下左右で）。2方向以上なら cut_many。',
  '・全部写っているが文字の高さが写真の短い辺の3%に満たないほど小さければ too_small。刻印が写っていなければ no_stamp。それ以外は ok。',
  '【写真の向き upright】写真全体（刻印の文字ではなく、床・台・容器・背景）が正しい向き（床が下、容器が立って見える）になるには時計回りに何度回せばよいか（0/90/180/270）。真上から見下ろしていて決められなければ 0。'
].join('\n');

// 画面から呼ぶ: 1つの容器を読む。
//   req.images: 同じ容器のコマ（base64 JPEG、1〜4枚）。req.image（1枚）も受け付ける
//   req.tier: 'fast'（速読・既定）／ 'precise'（精読）
//   返り値: 読み取り結果 ＋ model・tier・cost_usd（この1回の費用の目安）
function readKokuin(req) {
  req = req || {};
  const images = (Array.isArray(req.images) ? req.images : [req.image]).filter(function(x) { return x; }).slice(0, KOKUIN_MAX_IMAGES)
    .map(function(x) { return String(x).replace(/^data:image\/\w+;base64,/, ''); });
  if (!images.length) throw new Error('画像がありません');
  images.forEach(function(im) {
    if (im.length > KOKUIN_IMAGE_MAX_CHARS) throw new Error('画像が大きすぎます（' + Math.round(im.length / 1024) + 'KB）');
  });
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) {
    throw new Error('刻印読み取りのAPIキーが未設定です。Apps Script の「プロジェクトの設定 > スクリプト プロパティ」に ' +
      'ANTHROPIC_API_KEY を追加してください。');
  }
  const tier = req.tier === 'precise' ? 'precise' : 'fast';
  const model = tier === 'precise' ? (props.getProperty('KOKUIN_MODEL') || KOKUIN_MODEL_DEFAULT)
    : (props.getProperty('KOKUIN_MODEL_FAST') || KOKUIN_MODEL_FAST_DEFAULT);
  const content = images.map(function(im) { return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im } }; });
  content.push({ type: 'text', text: kokuinPrompt_(req.hints, images.length) });
  const body = {
    model: model,
    max_tokens: 4000,
    // 毎回同じルール文はキャッシュする（2回目からは入力の0.1倍の料金）
    system: [{ type: 'text', text: KOKUIN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: KOKUIN_SCHEMA } },
    messages: [{ role: 'user', content: content }]
  };
  // 安全側の判定で断られたときに別のモデルで読み直す仕組み（Haiku にはないので送らない）
  const fallback = !/haiku/.test(model);
  if (fallback) body.fallbacks = 'default';
  const started = Date.now();
  const res = kokuinFetch_(key, body, fallback);
  const out = parseKokuinResponse_(res);
  out.model = res.model || model;
  out.tier = tier;
  out.frames = images.length;
  out.cost_usd = kokuinCost_(model, res.usage);
  out.ms = Date.now() - started;
  kokuinLog_(req, out, images.length);
  return out;
}

// ---------- テストのログ（スクリーンショットの代わり。スプレッドシートに残し、あとでまとめて見る） ----------
// 読み取りログ: AIの読み取り1回ごと。読み取りまとめ: AIkokuin の一覧の結果（容器ごと）。カメラログ: LPG刻印カメラの撮影の判断。
// スクリプトプロパティ KOKUIN_LOG=off で止められる
const KOKUIN_LOG_SHEETS = {
  '読み取りログ': ['日時', 'セッション', '読み方', 'コマ', '段階', 'モデル', '枚数', '読めた', '記号', '番号', 'W', 'シール', 'W検算',
    '種別', '確からしさ', '秒', '費用(USD)', '年月', 'キャップ', 'グループNo照合', '備考', '指示の版', '写り', '向き'],
  '読み取りまとめ': ['日時', 'セッション', '読み方', 'できごと', '記号', '番号', 'W', '状態', '読み方の詳細', 'チェック', '保存', 'コマ/時刻', '確からしさ', '備考'],
  'カメラログ': ['日時', '端末', '撮影時刻', 'できごと', '撮るきっかけ', '容器の種類', '本目', '枚数', '真ん中までの距離', 'くっきり', '詳細']
};
function kokuinLogOn_() {
  try { return PropertiesService.getScriptProperties().getProperty('KOKUIN_LOG') !== 'off'; } catch (e) { return true; }
}
function kokuinLogSheet_(name) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const h = KOKUIN_LOG_SHEETS[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]);
    sh.setFrozenRows(1);
  } else {
    const h = KOKUIN_LOG_SHEETS[name];
    if (sh.getRange(1, h.length).getValue() === '') sh.getRange(1, 1, 1, h.length).setValues([h]);   // 列が増えたときの見出し
  }
  return sh;
}
function kokuinLogRows_(name, rows) {
  if (!rows.length || !kokuinLogOn_()) return;
  try {
    const sh = kokuinLogSheet_(name);
    const w = KOKUIN_LOG_SHEETS[name].length;
    rows = rows.map(function(r) { r = r.slice(0, w); while (r.length < w) r.push(''); return r; });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { sh.getRange(sh.getLastRow() + 1, 1, rows.length, w).setValues(rows); } finally { lock.releaseLock(); }
  } catch (e) { /* ログが書けなくても読み取りは続ける */ }
}
function kokuinLog_(req, out, n) {
  const l = req.log || {};
  kokuinLogRows_('読み取りログ', [[new Date(), String(l.session || ''), String(l.how || ''), String(l.label || ''), out.tier, out.model, n,
    out.readable ? 'はい' : 'いいえ', out.symbol, "'" + out.number, out.tare_kg, out.seal_kg, out.w_check, out.kind, out.confidence,
    Math.round(out.ms / 100) / 10, out.cost_usd, "'" + (out.manufactured || ''), "'" + (out.cap_number || ''), out.group_check,
    out.note, KOKUIN_PROMPT_VERSION, out.framing, out.upright]]);
}
// 画面から呼ぶ: 一覧の結果（読み終わったとき・保存したとき）
function logKokuinSummary(req) {
  req = req || {};
  const now = new Date();
  kokuinLogRows_('読み取りまとめ', (req.items || []).slice(0, 300).map(function(it) {
    return [now, String(req.session || ''), String(req.how || ''), String(req.event || ''), String(it.symbol || ''), "'" + String(it.number || ''),
      String(it.w || ''), String(it.status || ''), String(it.detail || ''), it.checked ? '✓' : '', it.saved ? '保存済み' : '', String(it.t || ''),
      String(it.confidence || ''), String(it.note || '')];
  }).concat(req.message ? [[now, String(req.session || ''), String(req.how || ''), String(req.event || '') + '（全体）', '', '', '', String(req.message)]] : []));
  return { ok: true };
}
// 読み取り口（gas-api）から呼ぶ: カメラの撮影の判断
function logCameraEvents_(events, device) {
  const now = new Date();
  kokuinLogRows_('カメラログ', (events || []).slice(0, 200).map(function(e) {
    return [now, String(device || ''), String(e.at || ''), String(e.type || ''), String(e.trigger || ''), String(e.kind || ''), e.pass || '',
      e.shots || '', e.best === undefined ? '' : e.best, e.sharp === undefined ? '' : e.sharp, String(e.detail || '')];
  }));
}

// 1回の費用の目安（USD）
function kokuinCost_(model, u) {
  const p = KOKUIN_PRICES[model]; if (!p || !u) return 0;
  const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1 + (u.cache_creation_input_tokens || 0) * 1.25;
  return Math.round((inTok * p[0] + (u.output_tokens || 0) * p[1]) / 1e6 * 1e6) / 1e6;
}

// いま入力中のロットの記号と番号の範囲を手がかりとして渡す（画像と合わないときは画像を優先させる）
function kokuinPrompt_(hints, frames) {
  let text = frames > 1
    ? 'この ' + frames + ' 枚は、同じ1本の容器を動画の別々のコマで写したものです。全コマを見比べ、桁ごとに反射の少ないコマで確定して、1本分の刻印を読み取ってください。' +
      'コマどうしで読みが食い違って決められない桁は ? にしてください。'
    : 'この写真の容器刻印を読み取ってください。';
  const list = (Array.isArray(hints) ? hints : []).slice(0, 40).map(function(h) {
    return (String(h.prefix || '') + ' ' + String(h.start || '') + '〜' + String(h.end || '') + (h.kind ? '（' + h.kind + '）' : '')).trim();
  }).filter(String);
  if (list.length) {
    text += '\n参考: いま検査中のロットの容器番号は次の範囲です（記号 番号の範囲）。ただし写真に見える文字を優先し、' +
      '範囲に合わせて読みを変えないでください。\n' + list.join('\n');
  }
  const learned = learnedNotes_();
  if (learned) text += '\n' + learned;
  return text;
}

// ---------- 学習（人が直した読み取りから、この現場で多い読み違いを覚えて、次の読み取りで注意させる） ----------
const LEARN_SHEET = '学習データ';
const LEARN_HEADERS = ['日時', '結果', '読み方', 'AIの記号', 'AIの番号', 'AIのW', '正しい記号', '正しい番号', '正しいW', '違い', '入力者', '容器種別', 'ロットID'];
// 画面から呼ぶ: 一覧から保存した容器の「AIの読み」と「人が確かめた正しい値」を記録する（直さずに保存したものは「一致」）
function recordLearning(req) {
  const items = (req && req.items || []).slice(0, 300);
  if (!items.length) return { ok: true, n: 0 };
  const sh = getSpreadsheet_().getSheetByName(LEARN_SHEET) || (function() {
    const x = getSpreadsheet_().insertSheet(LEARN_SHEET);
    x.getRange(1, 1, 1, LEARN_HEADERS.length).setValues([LEARN_HEADERS]); x.setFrozenRows(1); return x;
  })();
  const now = new Date(), str = function(v) { return v === undefined || v === null ? '' : String(v); };
  const rows = items.map(function(it) {
    const a = it.ai || {}, f = it.fixed || {};
    const diff = learnDiffs_(a, f);
    return [now, diff.length ? '直し' : '一致', str(req.how), str(a.symbol), "'" + str(a.number), str(a.w), str(f.symbol), "'" + str(f.number), str(f.w),
      diff.join(' / '), str(req.worker), str(it.kind), str(it.lotId)];
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { sh.getRange(sh.getLastRow() + 1, 1, rows.length, LEARN_HEADERS.length).setValues(rows); } finally { lock.releaseLock(); }
  try { CacheService.getScriptCache().remove('learnedNotes'); } catch (e) { /* 次の10分で作り直す */ }
  try { writeLearnSummary_(sh); } catch (e) { /* まとめが書けなくても記録は済んでいる */ }
  return { ok: true, n: rows.length };
}
// 「学習のまとめ」シート: 気づきメモの形（管理担当が正式ルール（W判定ルール・共通ルール）へ写せるように、根拠の容器番号つき）
function writeLearnSummary_(sh) {
  const n = sh.getLastRow() - 1; if (n < 1) return;
  const rows = sh.getRange(2, 1, n, LEARN_HEADERS.length).getValues();
  const byKind = {};
  rows.forEach(function(r) {
    const k = String(r[11] || '不明');
    const b = byKind[k] = byKind[k] || { ok: 0, ng: 0, diffs: {}, ws: {} };
    if (r[8] !== '') b.ws[String(r[8])] = (b.ws[String(r[8])] || 0) + 1;
    if (r[1] === '一致') { b.ok++; return; }
    b.ng++;
    String(r[9] || '').split(' / ').filter(String).forEach(function(d) {
      const x = b.diffs[d] = b.diffs[d] || { n: 0, ex: [] };
      x.n++; if (x.ex.length < 3) x.ex.push(String(r[4]).replace(/^'/, '') + '→' + String(r[7]).replace(/^'/, ''));
    });
  });
  const day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const lines = ['# AIkokuin の気づきメモ（自動作成 ' + day + '。学習データ ' + n + ' 本から）', '# 正式ルールへの反映は管理担当が判断する。根拠は「AIの読み→人が直した値」の容器番号', ''];
  Object.keys(byKind).forEach(function(k) {
    const b = byKind[k], tot = b.ok + b.ng;
    lines.push('【' + k + '】 人が確かめた ' + tot + ' 本のうち、AIの読みのまま正しかった ' + b.ok + ' 本（' + Math.round(b.ok * 100 / tot) + '%）、直した ' + b.ng + ' 本');
    Object.keys(b.diffs).sort(function(x, y) { return b.diffs[y].n - b.diffs[x].n; }).slice(0, 10).forEach(function(d) {
      lines.push('・' + d + '  ' + b.diffs[d].n + '回（例: ' + b.diffs[d].ex.join('、') + '）');
    });
    const ws = Object.keys(b.ws).sort().map(function(w) { return 'W' + w + '=' + b.ws[w] + '本'; });
    if (ws.length) lines.push('・Wの内訳（人が確かめた値）: ' + ws.join(' / '));
    lines.push('');
  });
  const ss = getSpreadsheet_();
  const out = ss.getSheetByName('学習のまとめ') || ss.insertSheet('学習のまとめ');
  out.clearContents();
  out.getRange(1, 1, lines.length, 1).setValues(lines.map(function(l) { return [l]; }));
}
// AIの読みと正しい値の違い（桁ごと）。例 ['番号「5」→「6」', 'W 16.8→16.6']
function learnDiffs_(a, f) {
  const out = [], str = function(v) { return v === undefined || v === null ? '' : String(v); };
  const chars = function(label, x, y) {
    x = str(x); y = str(y);
    if (!x || !y || x === y) return;
    if (x.length !== y.length) { out.push(label + 'の桁数 ' + x + '→' + y); return; }
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && x[i] !== '?') out.push(label + '「' + x[i] + '」→「' + y[i] + '」');
  };
  chars('記号', a.symbol, f.symbol);
  chars('番号', a.number, f.number);
  if (str(a.w) && str(f.w) && Number(a.w) !== Number(f.w)) out.push('W ' + a.w + '→' + f.w);
  return out;
}
// 学習データから「この現場で多い読み違い」を作る（新しい300件から、多い順に8つ）。10分は覚えておく
function learnedNotes_() {
  const cache = CacheService.getScriptCache();
  try { const c = cache.get('learnedNotes'); if (c !== null) return c; } catch (e) { /* 作り直す */ }
  let text = '';
  try {
    const sh = getSpreadsheet_().getSheetByName(LEARN_SHEET);
    {
      const n = sh ? Math.min(300, sh.getLastRow() - 1) : 0;
      const rows = n > 0 ? sh.getRange(sh.getLastRow() - n + 1, 1, n, LEARN_HEADERS.length).getValues() : [];
      const count = {}; let ok = 0, ng = 0;
      rows.forEach(function(r) {
        if (r[1] === '一致') { ok++; return; }
        ng++;
        String(r[9] || '').split(' / ').filter(String).forEach(function(d) { count[d] = (count[d] || 0) + 1; });
      });
      // カメラ読み取りの「正解の番号」（後から写真を見て書いたもの）も同じように数える
      try {
        const cs = getSpreadsheet_().getSheetByName('カメラ読み取り');
        if (cs && cs.getLastRow() >= 2 && cs.getLastColumn() >= 28) {
          const k = Math.min(300, cs.getLastRow() - 1);
          cs.getRange(cs.getLastRow() - k + 1, 1, k, 28).getValues().forEach(function(r) {
            const fixNum = String(r[26] || '').replace(/^'/, '');
            if (!/^\d{5}$/.test(fixNum)) return;
            const d = learnDiffs_({ symbol: r[3], number: String(r[4]).replace(/^'/, ''), w: r[5] }, { symbol: r[25], number: fixNum, w: r[27] });
            const aiNum = String(r[4]).replace(/^'/, '');
            if (!d.length && aiNum.indexOf('?') >= 0) { ng++; count['番号の1桁が隠れて読めなかった'] = (count['番号の1桁が隠れて読めなかった'] || 0) + 1; return; }
            if (!d.length) { ok++; return; }
            ng++; d.forEach(function(x) { count[x] = (count[x] || 0) + 1; });
          });
        }
      } catch (e) { /* 学習データだけで作る */ }
      const top = Object.keys(count).sort(function(x, y) { return count[y] - count[x]; }).slice(0, 8);
      if (top.length) {
        text = 'この現場で最近あった読み違い（人が直したもの。AIの読み→正しい字。同じ字形が出たら特に注意して見分けること。ただし写真に見える文字を優先する）:\n' +
          top.map(function(k) { return '・' + k + '（' + count[k] + '回）'; }).join('\n') +
          '\n（最近 ' + (ok + ng) + ' 本のうち、人が直したのは ' + ng + ' 本）';
      }
    }
  } catch (e) { text = ''; }
  try { cache.put('learnedNotes', text, 600); } catch (e) { /* 覚えられなくても読める */ }
  return text;
}

// API呼び出し。混雑（429・529）と一時的な 5xx は少し待って1回だけやり直す
function kokuinFetch_(key, body, fallback) {
  const headers = { 'x-api-key': key, 'anthropic-version': KOKUIN_API_VERSION };
  if (fallback) headers['anthropic-beta'] = KOKUIN_FALLBACK_BETA;
  const opt = {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };
  let code = 0, text = '';
  for (let i = 0; i < 2; i++) {
    const r = UrlFetchApp.fetch(KOKUIN_API_URL, opt);
    code = r.getResponseCode(); text = r.getContentText();
    if (code === 200) return JSON.parse(text);
    if (!(code === 429 || code >= 500) || i === 1) break;
    Utilities.sleep(1500);
  }
  let msg = '';
  try { msg = JSON.parse(text).error.message; } catch (e) { msg = String(text).slice(0, 200); }
  if (code === 401) throw new Error('刻印読み取りのAPIキーが正しくありません（ANTHROPIC_API_KEY を確認してください）');
  if (code === 429 || code === 529) throw new Error('刻印読み取りが混み合っています。少し待ってもう一度読んでください');
  throw new Error('刻印読み取りに失敗しました（' + code + '）: ' + msg);
}

// 返事から結果を取り出す。断られた・途中で切れたときは「読めない」として返す
function parseKokuinResponse_(res) {
  const empty = { readable: false, symbol: '', number: '', volume_l: '', tare_kg: '', seal_kg: '', test_pressure_mpa: '',
    manufactured: '', ym: '', kind: '不明', cap_number: '', group_check: '', other: '', confidence: 'low', note: '', w_check: '', w_from_seal: false };
  if (res.stop_reason === 'refusal') { empty.note = '読み取りを断られました'; return empty; }
  if (res.stop_reason === 'max_tokens') { empty.note = '読み取りが途中で切れました'; return empty; }
  const block = (res.content || []).filter(function(b) { return b.type === 'text'; }).pop();
  if (!block) { empty.note = '読み取り結果がありません'; return empty; }
  let o;
  try { o = JSON.parse(block.text); } catch (e) { empty.note = '読み取り結果の形が違います'; return empty; }
  const s = function(v) { return v === undefined || v === null ? '' : String(v).trim(); };
  // 数字の欄は数字・小数点・?だけ残す（全角は半角に）。読めない桁の ? は消さない
  const num = function(v) { return s(v).replace(/[０-９．？]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/[^0-9.?]/g, ''); };
  const out = {
    readable: o.readable === true,
    symbol: s(o.symbol).toUpperCase().replace(/[^A-Z?]/g, ''),
    number: num(o.number).replace(/\./g, ''),
    volume_l: num(o.volume_l), tare_kg: num(o.tare_kg), seal_kg: num(o.seal_kg), test_pressure_mpa: num(o.test_pressure_mpa),
    manufactured: s(o.manufactured), ym: kokuinYm_(s(o.manufactured)),
    kind: KOKUIN_KINDS.indexOf(o.kind) >= 0 ? o.kind : '不明',
    other: s(o.other),
    confidence: ['high', 'medium', 'low'].indexOf(o.confidence) >= 0 ? o.confidence : 'low',
    note: s(o.note), w_check: '', w_from_seal: false,
    framing: KOKUIN_FRAMING.indexOf(o.framing) >= 0 ? o.framing : '',
    upright: ['0', '90', '180', '270'].indexOf(String(o.upright)) >= 0 ? String(o.upright) : ''
  };
  // 番号は5桁すべて読めたときだけ使う（? が残る・桁が足りないものは入力に使わない）
  if (!/^\d{5,}$/.test(out.number)) out.readable = false;
  if (out.symbol.indexOf('?') >= 0) out.symbol = '';
  out.cap_number = num(o.cap_number).replace(/\./g, '');
  kokuinCheckGroup_(out);
  kokuinCheckW_(out);
  return out;
}

// W検算: 刻印W ＋ 0.5 ＝ 総重量シール。合わなければ確からしさを「低」に。
// Wの末尾が読めず（?）シールが読めたときは、W ＝ シール − 0.5 で確定する（運用ルールで最も確実とされている方法）
function kokuinCheckW_(out) {
  const w = /^\d+\.\d$/.test(out.tare_kg) ? Number(out.tare_kg) : null;
  const seal = /^\d+(\.\d)?$/.test(out.seal_kg) ? Number(out.seal_kg) : null;
  if (w !== null && seal !== null) {
    out.w_check = Math.abs(w + 0.5 - seal) < 0.05 ? 'OK' : 'NG';
    if (out.w_check === 'NG') {
      out.confidence = 'low';
      out.note = (out.note ? out.note + ' / ' : '') + 'W検算が合わない（W' + out.tare_kg + '＋0.5≠シール' + out.seal_kg + '）';
    }
  } else if (w === null && seal !== null && (out.tare_kg === '' || out.tare_kg.indexOf('?') >= 0)) {
    out.tare_kg = (Math.round((seal - 0.5) * 10) / 10).toFixed(1);
    out.w_from_seal = true; out.w_check = 'シールから';
  }
  // 読めないW（? が残る・形が違う）は入力に使わないので空にする
  if (!/^\d+\.\d$/.test(out.tare_kg)) out.tare_kg = '';
}

// グループNo の照合: キャップの手書きの数字 ＝ このアプリのグループNo（groupNoOf_。50kg・30kg系は100本ごと、
// 20kg以下は50本ごと。例 50kg 36815 → 369）。種別が分からないときは照合しない。
// 合わなければ番号の誤読を疑い、確からしさを「中」以下にする
function kokuinCheckGroup_(out) {
  out.group_check = '';
  if (!/^\d{5}$/.test(out.number) || !/^\d{1,4}$/.test(out.cap_number)) return;
  const expect = groupNoOf_(out.kind, out.number);
  if (expect === '') return;
  out.group_check = Number(out.cap_number) === expect ? 'OK' : 'NG';
  if (out.group_check === 'NG') {
    if (out.confidence === 'high') out.confidence = 'medium';
    out.note = (out.note ? out.note + ' / ' : '') + 'キャップのグループNo ' + out.cap_number + ' と番号が合わない（' + out.number + ' なら ' + expect + '）';
  }
}

// 刻印の年月「7-26」（月-年の下2桁）→「2026-07」。形が違えば空
function kokuinYm_(text) {
  const m = String(text || '').match(/^(\d{1,2})\s*[-－.]\s*(\d{2})$/);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return '';
  return '20' + m[2] + '-' + ('0' + m[1]).slice(-2);
}

// 画面から呼ぶ: 入力に使った読み取り結果を記録する
function saveKokuin(rec) {
  rec = rec || {};
  const r = rec.read || {};
  let account = '';
  try { account = Session.getActiveUser().getEmail(); } catch (e) { /* 取れなくても記録する */ }
  const sh = kokuinSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sh.appendRow([new Date(), String(rec.lotId || ''), "'" + String(rec.serial || ''), String(r.symbol || ''), "'" + String(r.number || ''),
      String(r.volume_l || ''), String(r.tare_kg || ''), String(r.test_pressure_mpa || ''), "'" + String(r.ym || ''),
      String(r.other || ''), String(r.confidence || ''), String(rec.how || ''), String(rec.worker || ''), String(rec.device || ''),
      account, String(r.model || ''), String(r.note || ''),
      String(r.seal_kg || ''), String(r.w_check || ''), String(r.kind || ''), "'" + String(r.manufactured || ''),
      "'" + String(r.cap_number || ''), String(r.group_check || '')]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function kokuinSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(KOKUIN_SHEET);
  if (!sh) {
    sh = ss.insertSheet(KOKUIN_SHEET);
    sh.getRange(1, 1, 1, KOKUIN_HEADERS.length).setValues([KOKUIN_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// ---------- LPG刻印カメラの「その場で読む」で読んだ分（gas-api の読み取り口が「カメラ読み取り」シートに書く） ----------
const CAMERA_READ_SHEET = 'カメラ読み取り';
// 画面から呼ぶ: まだ入力していない行（直近2日）を古い順に返す。req.status: '未入力'（自動入力用）／'all'（未入力と要確認）
function cameraReads(req) {
  const want = req && req.status === '未入力' ? ['未入力'] : ['未入力', '要確認'];
  const sh = getSpreadsheet_().getSheetByName(CAMERA_READ_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 24).getValues();
  const since = Date.now() - 2 * 24 * 3600 * 1000, out = [];
  const s = function(v) { return v === null || v === undefined ? '' : String(v); };
  rows.forEach(function(x) {
    const at = x[0] instanceof Date ? x[0] : new Date(x[0]);
    if (want.indexOf(s(x[2])) < 0 || !(at.getTime() >= since)) return;
    const read = {
      readable: /^\d{5,}$/.test(s(x[4])), symbol: s(x[3]), number: s(x[4]), tare_kg: s(x[5]) === '' ? '' : Number(x[5]).toFixed(1),
      volume_l: s(x[6]), test_pressure_mpa: s(x[7]), manufactured: s(x[8]), ym: kokuinYm_(s(x[8])), seal_kg: s(x[9]), w_check: s(x[10]),
      kind: s(x[11]) || '不明', confidence: s(x[12]) || 'low', sure: s(x[13]) === '確定', how: s(x[14]), model: s(x[15]), note: s(x[16]),
      cost_usd: Number(x[19]) || 0, cap_number: s(x[21]), group_check: s(x[22]), w_from_seal: s(x[10]) === 'シールから', other: ''
    };
    if (!read.readable) return;
    out.push({ id: s(x[1]), at: Utilities.formatDate(at, 'Asia/Tokyo', 'HH:mm:ss'), read: read, thumb: s(x[23]), status: s(x[2]) });
  });
  return out;
}
// 画面から呼ぶ: 成績表に入れた行に「入力済み」（自動なら「自動入力」）、入れられなかった行に「要確認」と理由の印をつける
function markCameraReads(req) {
  const ids = (req && req.ids || []).map(String), reasons = req && req.reasons || [];
  const status = ['入力済み', '自動入力', '要確認'].indexOf(req && req.status) >= 0 ? req.status : '入力済み';
  const sh = getSpreadsheet_().getSheetByName(CAMERA_READ_SHEET);
  if (!sh || !ids.length || sh.getLastRow() < 2) return { ok: true, n: 0 };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const col = sh.getRange(2, 2, sh.getLastRow() - 1, 2).getValues();
    let n = 0;
    col.forEach(function(x, i) {
      const k = ids.indexOf(String(x[0]));
      if (k < 0 || !(x[1] === '未入力' || (x[1] === '要確認' && status !== '要確認'))) return;
      sh.getRange(i + 2, 3).setValue(status); n++;
      if (status === '要確認' && reasons[k]) {
        const c = sh.getRange(i + 2, 17); c.setValue((c.getValue() ? c.getValue() + ' / ' : '') + '自動入力できない: ' + reasons[k]);
      }
    });
    return { ok: true, n: n };
  } finally {
    lock.releaseLock();
  }
}
