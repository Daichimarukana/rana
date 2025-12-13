// Rana Core
//注意: 結構LLMのみなさんにご協力いただいています。感謝の舞。
const kuromoji = require('kuromoji');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = './memory.db';
const MARKOV_ORDER = 3;   //n-gramのやつらしい(例外的にお礼メッセージは2か3)
const TOP_K = 5;          //類似上位 K 件をマルコフモデルに使うらしい
const SIM_THRESHOLD = 0.5; //類似度の閾値
const MAX_GENERATE_TOKENS = 600; //生成上限トークン数
let RANA_LOG = false;

// -------- DB 初期化 --------
const db = new Database(DB_PATH);
db.pragma('encoding = "UTF-8"');
db.exec(`
CREATE TABLE IF NOT EXISTS qa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT,
  tokens TEXT,
  vector TEXT,
  answer TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// -------- ログ出力関数 --------
function ranaLog(label, ...args) {
    if (RANA_LOG !== true) return;

    const LABEL_WIDTH = 30;
    const PREFIX = "[LOG]";

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const formattedTime = `[${timeStr}]`;
    const formattedLabel = `[${label}]`;
    const paddedLabel = formattedLabel.padEnd(LABEL_WIDTH, " ");

    const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : arg
    ).join(" ");

    console.log(`${formattedTime}${PREFIX}${paddedLabel}: ${message}`);
}
// -------- kuromoji 初期化 (非同期だが CLI 起動で await) --------
function buildTokenizer() {
    return new Promise((resolve, reject) => {
        const dicPath = path.join(__dirname, 'node_modules', 'kuromoji', 'dict');
        kuromoji.builder({ dicPath }).build((err, tokenizer) => {
            if (err) return reject(err);
            resolve(tokenizer);
        });
    });
}

// -------- トークン化（原形があれば原形を使う） --------
function tokenizeToArray(tokenizer, text) {
    const toks = tokenizer.tokenize(text);
    // basic_form が '*' の場合は surface_form を使う
    const arr = toks.map(t => t.surface_form);
    // フィルタ（空白・記号だけのトークン省く）
    // return arr.filter(tok => tok && tok.trim().length > 0);
    // 英語も使えるようになるはず
    return arr.filter(tok => tok !== "");
}

// -------- 簡易 TF-IDF 実装（バッチで全件再計算） --------
function buildVocabAndDf(tokensList) {
    const df = new Map();
    tokensList.forEach(tokens => {
        const seen = new Set(tokens);
        seen.forEach(t => df.set(t, (df.get(t) || 0) + 1));
    });
    const vocab = Array.from(df.keys());
    return { vocab, df };
}
function computeTfIdfVectors(tokensList, vocab, df) {
    const N = tokensList.length;
    const idf = vocab.map(term => {
        const d = df.get(term) || 0;
        return Math.log((N + 1) / (d + 1)) + 1; // smoothing
    });
    return tokensList.map(tokens => {
        const tf = new Map();
        tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
        return vocab.map((term, i) => {
            const t = tf.get(term) || 0;
            return t * idf[i];
        });
    });
}

// -------- コサイン類似度 --------
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// -------- Markov(n-gram) テーブル構築（形態素単位） --------
function buildMarkovTable(n, sequences) {
    const table = new Map();
    const START = '<START>';
    const END = '<END>';
    sequences.forEach(seq => {
        if (!seq || seq.length === 0) return;
        const padded = [START, ...seq, END];
        for (let i = 0; i <= padded.length - n; i++) {
            const keyArr = padded.slice(i, i + n - 1);
            const next = padded[i + n - 1];
            const key = keyArr.join('\u0001');
            if (!table.has(key)) table.set(key, []);
            table.get(key).push(next);
        }
    });
    return table;
}

function weightedRandomChoice(choices, temperature = 2.0) {
    const counts = {};
    choices.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const entries = Object.entries(counts).map(([tok, count]) =>
        [tok, Math.pow(count, 1 / temperature)]
    );
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let r = Math.random() * total;
    for (const [token, weight] of entries) {
        r -= weight;
        if (r <= 0) return token;
    }
    return entries[0][0];
}

function generateFromMarkov(table, n, startTokens = null, maxTokens = MAX_GENERATE_TOKENS) {
    const keys = Array.from(table.keys());
    if (keys.length === 0) return '';
    ranaLog("Start Tokens", startTokens);
    ranaLog("Keys", keys);
    ranaLog("Markov Table", "=== Markov Table ===");
    for (const [key, values] of table.entries()) {
        ranaLog("Markov Table", `${key} => ${values.join(", ")}`);
    }
    ranaLog("Markov Table", "=== End of Table ===");

    let key;
    if (startTokens && startTokens.length >= n - 1) {
        // startTokensに部分一致するキーを全部探す
        const matchingKeys = keys.filter(k =>
            k.includes(startTokens.slice(0, n - 1).join('\u0001'))
        );
        if (matchingKeys.length > 0) {
            // 複数候補からランダムに開始キーを選ぶ
            key = matchingKeys[Math.floor(Math.random() * matchingKeys.length)];
        }
    }
    if (!key) {
        // 文頭のキーを優先して選ぶ
        const startKeys = keys.filter(k => k.startsWith('<START>'));
        key = startKeys.length > 0 ? startKeys[Math.floor(Math.random() * startKeys.length)] : keys[Math.floor(Math.random() * keys.length)];
    }

    const out = key.split('\u0001').filter(tok => tok !== '<START>');
    let loopcnt = 0; // const から let に変更
    while (out.length < maxTokens) {
        ranaLog("Generating Tokens Count", "token = " + loopcnt);
        ranaLog("Generating N-gram Value", "n = " + n);
        loopcnt++;

        const choices = table.get(key);
        ranaLog("Generating Next Tokens List", choices);
        if (!choices || choices.length === 0) break;
        const next = weightedRandomChoice(choices);
        ranaLog("Generating Next Token Choice", next)
        if (next === '<END>') break;
        out.push(next);
        const nextKeyArr = out.slice(out.length - (n - 1), out.length);
        key = nextKeyArr.join('\u0001');
        if (!table.has(key)) break;
    }

    return out.join('');
}


// -------- DB 操作 --------
const insertStmt = db.prepare('INSERT INTO qa (question, tokens, vector, answer) VALUES (?, ?, ?, ?)');
const selectAllStmt = db.prepare('SELECT id, question, tokens, vector, answer FROM qa ORDER BY created_at DESC');

// 全ベクトルを再計算してDBに保存する（小規模向けバッチ処理）
function rebuildAllVectors() {
    const rows = selectAllStmt.all();
    const tokensList = rows.map(r => JSON.parse(r.tokens || '[]'));
    if (tokensList.length === 0) return { vocab: [], df: new Map() };
    const { vocab, df } = buildVocabAndDf(tokensList);
    const vectors = computeTfIdfVectors(tokensList, vocab, df);
    const updateVec = db.prepare('UPDATE qa SET vector = ? WHERE id = ?');
    rows.forEach((r, idx) => {
        updateVec.run(JSON.stringify(vectors[idx]), r.id);
    });
    return { vocab, df };
}

// getAnswer: 入力文章から最適な応答（Markov生成） or 学習要求を返す
function getAnswerForInput(inputTokens) {
    const allRows = selectAllStmt.all(); // includes answered and unanswered
    const answeredRows = allRows.filter(r => r.answer);
    // tokensList includes ALL answered rows tokens + current input tokens for TF-IDF calc
    const tokensList = answeredRows.map(r => JSON.parse(r.tokens || '[]')).concat([inputTokens]);
    if (tokensList.length === 1) {
        // データが全く無い（最初の1件だけ）：必ず学習フロー
        return { needTeach: true, reason: 'no_data' };
    }
    const { vocab, df } = buildVocabAndDf(tokensList);
    const vectors = computeTfIdfVectors(tokensList, vocab, df);
    const inputVec = vectors[vectors.length - 1];

    // compute score for each answeredRow
    const candidates = answeredRows.map((r, idx) => {
        const vec = vectors[idx];
        const score = cosine(inputVec, vec);
        return { row: r, score };
    }).sort((a, b) => b.score - a.score);

    if (candidates.length === 0 || candidates[0].score < SIM_THRESHOLD) {
        return { needTeach: true, reason: 'low_similarity', bestScore: candidates[0] ? candidates[0].score : 0 };
    }

    const highSimilarityCandidates = candidates.filter(c => c.score >= SIM_THRESHOLD);

    // 閾値を超える候補が3件以下の場合
    if (highSimilarityCandidates.length <= 3) {
        // 2/3の確率で学習モードにすることでもっと頭を良くしようっていう感じ
        if (Math.random() < 2 / 3) {
            return { needTeach: true, reason: 'less_than_3_high_sim_candidates', bestScore: candidates[0].score };
        }
    }

    const top = candidates.slice(0, TOP_K).filter(x => x.row.answer);
    const answerTexts = top.map(x => x.row.answer).filter(Boolean);
    if (answerTexts.length === 0) {
        return { needTeach: true, reason: 'no_answer_text' };
    }

    const sequences = top.map(t => tokenizeToArray(globalTokenizer, t.row.answer));
    const table = buildMarkovTable(MARKOV_ORDER, sequences);
    const generated = generateFromMarkov(table, MARKOV_ORDER, inputTokens);
    const finalReply = (generated && generated.length >= 4) ? generated : top[0].row.answer;

    return {
        needTeach: false,
        reply: finalReply,
        bestScore: candidates[0].score,
        candidates: top.map(t => ({ id: t.row.id, score: t.score }))
    };
}

// 学習はここだけ(重いので非同期)
async function teachAnswer(question, answer, tokens) {
    ranaLog("Teaching Answer", "データベースにデータを保存しました！");
    insertStmt.run(question, JSON.stringify(tokens), JSON.stringify([]), answer);

    setImmediate(() => {
        ranaLog("Rebuild All Vectors", "ベクトルのバックグラウンド再計算を開始");
        const start = Date.now();
        rebuildAllVectors();
        ranaLog("Rebuild All Vectors", `再計算完了 (${Date.now() - start}ms)`);
    });
}

function sampleArray(array, n) {
    const result = [];
    const copy = array.slice();
    const len = Math.min(n, copy.length);
    for (let i = 0; i < len; i++) {
        const idx = Math.floor(Math.random() * copy.length);
        result.push(copy.splice(idx, 1)[0]);
    }
    return result;
}

// あらかじめ用意しておく定型文(たまに呟くときに使う)
const casualMutterings = [
    "お腹すいたなー。",
    "今日の天気バチボコに悪いんだけど",
    "さて、と。",
    "ふぁ〜、ちょっと眠いかも…",
    "何か面白いことないかなぁ。",
    "ふへー...疲れた...",
    "圧倒的疲労感...",
    "眠すぎて死にそうかも",
    "ちょっと暇ですね...",
    "布団から出られないんですが",
    "甘いものしか勝たん",
    "血糖値スパイクで絶体絶命です...",
    "ほら、らなちゃんですよー！",
    "uwuzuってめっちゃ軽いらしいですよ～",
    "布教布教...",
];

let globalTokenizer = null;

async function init(log = false) {
    globalTokenizer = await buildTokenizer();
    if (log === true) {
        RANA_LOG = true;
    }
    ranaLog("Rana Core Start", "初期化完了！");
}

// ここでランダムなテキストを生成する(事前に学習データがある程度ないとうごけないよ)
function generateRandomText() {
    ranaLog("Random Generating Start", "ランダム生成を開始しました！");
    const allRows = selectAllStmt.all();
    if (allRows.length === 0) return "何を話そうかな…";

    // 質問と回答とさっきのcasualMutteringsから学習データを作成
    const filteredQuestions = allRows.filter(r => !r.question.includes("？") && !r.question.includes("?"));
    const sampledQuestions = sampleArray(filteredQuestions, 25);
    const questionSequences = sampledQuestions.map(r => tokenizeToArray(globalTokenizer, r.question));

    const answeredRows = allRows.filter(r => r.answer);
    const sampledAnsweredRows = sampleArray(answeredRows, 25);
    const answerSequences = sampledAnsweredRows.map(r => tokenizeToArray(globalTokenizer, r.answer));

    const casualSequences = casualMutterings.map(text => tokenizeToArray(globalTokenizer, text));

    const sequences = [...questionSequences, ...answerSequences, ...casualSequences].filter(s => s.length > 0);

    // マルコフ連鎖します
    //const n = [2, 3][Math.floor(Math.random() * 2)];
    const table = buildMarkovTable(MARKOV_ORDER, sequences);
    let text = generateFromMarkov(table, MARKOV_ORDER, null, 50);

    // 短すぎたりしたらちょっとだめかも
    if (!text || text.length < 2) {
        if (answeredRows.length > 0) {
            ranaLog("Generate Result(Too short)", answeredRows[0].answer);
            text = answeredRows[0].answer;
        } else {
            ranaLog("Generate Error", "生成できませんでした...");
            text = "うーん、うまく言葉が出てこないかも";
        }
    }else{
        ranaLog("Generate Result", text);
    }

    return text;
}

// これは質問に答えるやつ
function generateInputText(input) {
    ranaLog("Generating Start", "生成を開始しました！");
    ranaLog("Generating Input", input);
    const tokens = tokenizeToArray(globalTokenizer, input);
    const result = getAnswerForInput(tokens);
    ranaLog("Generate Raw Result", result);
    if (result.needTeach) {
        ranaLog("Generate Error", "生成できませんでした...");
        return "ごめんなさい...よくわかりませんでした...";
    } else {
        ranaLog("Generate Result", result.reply);
        return result.reply;
    }
}

function generateThanksText(template) {
    ranaLog("Generate Thanks Start", "生成を開始しました！");

    const thanksKeywords = [
        'ありがとう', 'ありがと', '感謝', '覚えました', '助かり', 'うれしい', '嬉しい',
        '勉強になります', '賢く', '把握', '了解', 'やったー', '最高'
    ];

    const whereClause = thanksKeywords.map(() => "answer LIKE ?").join(" OR ");
    const query = `SELECT answer FROM qa WHERE ${whereClause} LIMIT 50`;

    const params = thanksKeywords.map(k => `%${k}%`);
    let thanksRows = db.prepare(query).all(...params);

    if (template !== null && Array.isArray(template)) {
        const templateRows = template.map(text => ({ answer: text }));
        thanksRows = thanksRows.concat(templateRows);
    }

    if (!thanksRows || thanksRows.length >= 5) {
        const sequences = thanksRows.map(r => tokenizeToArray(globalTokenizer, r.answer));

        // nは結構ランダムに！
        const n = [2, 3][Math.floor(Math.random() * 2)];
        const table = buildMarkovTable(n, sequences);

        const generated = generateFromMarkov(table, n, null, 50);

        if (generated.length > 0) {
            ranaLog("Generate Result", generated);
            return generated;
        }
    } else {
        ranaLog("Generate Error", "生成できませんでした...");
        return null;
    }
}

// お勉強はこちら
function studyInputText(Question, Answer) {
    ranaLog("Learning Start", "学習を開始しました！");
    ranaLog("Learning Question", Question);
    ranaLog("Learning Answer", Answer);

    const tokens = tokenizeToArray(globalTokenizer, Question);
    teachAnswer(Question, Answer, tokens);

    const thanks_to_user = [
        "教えてくださりありがとうございます...！",
        "しっかり覚えました！",
        "また一つ賢くなれました！",
        "次からは自信を持って答えられます！",
        "ありがとうございます！しっかり学びました！"
    ];

    const thanks_message = generateThanksText(thanks_to_user);
    if (thanks_message === null) {
        ranaLog("Learning Reply", "定型文から返します。");
        return thanks_to_user[Math.floor(Math.random() * thanks_to_user.length)];
    } else {
        ranaLog("Learning Reply", thanks_message+"を返します");
        return thanks_message;
    }
}

module.exports = {
    init,
    generateRandomText,
    generateInputText,
    tokenizeToArray,
    getAnswerForInput,
    studyInputText
};