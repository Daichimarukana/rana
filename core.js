// Rana Core
//注意: 結構LLMのみなさんにご協力いただいています。感謝の舞。
//なんかゴニョゴニョしまくってたら自律できるようになったとかなんとか...？

const kuromoji = require('kuromoji');
const Database = require('better-sqlite3');
const path = require('path');
const { EventEmitter } = require('events');
const { actions: defaultActions, actionSeeds, getActionNames } = require('./actions.js');

// -------- 設定 --------
const DB_PATH = path.join(__dirname, './memory.db');
const MARKOV_ORDER = 3;
// TOP_Kは消えた
const SIM_THRESHOLD = 0.5;
const MAX_GENERATE_TOKENS = 600;

// 思考間隔
const THOUGHT_INTERVAL_MS = 250;

// 初期シード独り言
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
    "布教布教..."
];

class RanaOrganism extends EventEmitter {
    constructor(dbPath = DB_PATH, enableLog = false) {
        super();
        this.logEnabled = enableLog;
        this.db = new Database(dbPath);
        this.db.pragma('encoding = "UTF-8"');
        this.tokenizer = null;

        // 無意識・生体パラメータ
        this.energy = 1.0;         // 体力
        this.sleepDrive = 0.0;     // 睡眠圧
        this.dopamine = 0.3;       // 好奇心・探索欲求
        this.noradrenaline = 0.05; // 緊張・危機感・ストレス
        this.speechUrge = 0.0;     // 発話圧
        this.focusDwell = 0;       // 現在の話題に留まっているステップ数
        this.FOCUS_MIN_DWELL = 24; // 最低でも24ステップ（約6秒間）は同じ話題を反芻する

        // 意識状態
        this.isSleeping = false;
        this.isRunning = false;
        this.focusTokens = [];
        this.focusHistory = [];
        this.MAX_FOCUS_HISTORY = 6;
        this.currentThought = '';

        // メモリインデックス
        this.idfMap = new Map();
        this.cachedMemory = [];

        // メタ認知
        this.selfConcept = {
            name: null,          // 呼び名
            fullName: null,      // 本名
            firstPerson: null,   // 一人称
            confidence: 0        // 確信度
        };

        // ユーザー別 深層意識
        // talkId -> { memories: Map(word => { weight, category, lastSeen }), lastInteraction }
        this.userSubconscious = new Map();

        // 対話コンテキスト&割り込みキュー
        this.talkContexts = {};
        this.interruptQueue = [];

        // アクションハンドラ
        this.actionHandlers = { ...defaultActions };
        this.actionCooldowns = new Map();
        this.ACTION_MIN_COOLDOWN_MS = 5 * 60 * 1000;
        this.ACTION_MAX_COOLDOWN_MS = 30 * 60 * 1000;
        
        this.initDatabase();
    }

    ranaLog(label, ...args) {
        if (!this.logEnabled) return;

        const LABEL_WIDTH = 30;
        const PREFIX = "[LOG]";
        const now = new Date();
        const timeStr = now.toLocaleTimeString('ja-JP', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        const formattedTime = `[${timeStr}]`;
        const formattedLabel = `[${label}]`.padEnd(LABEL_WIDTH, " ");
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : arg
        ).join(" ");

        console.log(`${formattedTime}${PREFIX}${formattedLabel}: ${message}`);
    }

    getActionList() {
        return Object.keys(this.actionHandlers);
    }

    registerAction(name, handler) {
        this.actionHandlers[name] = handler;
        this.ranaLog("Action Registered", `アクション「${name}」を追加しました`);
    }

    isActionReady(actionName) {
        const nextAvailable = this.actionCooldowns.get(actionName) || 0;
        return Date.now() >= nextAvailable;
    }

    triggerActionCooldown(actionName) {
        const cooldownMs = this.ACTION_MIN_COOLDOWN_MS +
            Math.random() * (this.ACTION_MAX_COOLDOWN_MS - this.ACTION_MIN_COOLDOWN_MS);
        const nextTime = Date.now() + cooldownMs;
        this.actionCooldowns.set(actionName, nextTime);

        const minutes = (cooldownMs / (60 * 1000)).toFixed(1);
        this.ranaLog("Action Cooldown", `「${actionName}」は次回まで ${minutes} 分間のインターバルに入ります`);
    }

    getReadyActions() {
        return this.getActionList().filter(name => this.isActionReady(name));
    }

    initDatabase() {
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS qa (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question TEXT,
          tokens TEXT,
          vector TEXT,
          answer TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        `);
        this.insertStmt = this.db.prepare('INSERT INTO qa (question, tokens, vector, answer) VALUES (?, ?, ?, ?)');
        this.selectAllStmt = this.db.prepare('SELECT id, question, tokens, vector, answer FROM qa ORDER BY created_at DESC');
    }

    async init() {
        this.tokenizer = await new Promise((resolve, reject) => {
            const dicPath = path.join(__dirname, 'node_modules', 'kuromoji', 'dict');
            kuromoji.builder({ dicPath }).build((err, tokenizer) => {
                if (err) return reject(err);
                resolve(tokenizer);
            });
        });

        const count = this.db.prepare('SELECT count(*) AS c FROM qa').get().c;
        if (count === 0) {
            this.seedInitialMemory();
        }

        this.rebuildAllVectors();
        this.analyzeSelfIdentity();
        this.syncCircadianToCurrentTime();

        this.focusTokens = this.pickRandomFocusTokens(2);
        this.ranaLog("Initial Focus", `初期フォーカスを記憶からセット: [${this.focusTokens.join(', ')}]`);

        this.log('System', '起動しました。');
    }

    seedInitialMemory() {
        actionSeeds.forEach(s => {
            const tokens = this.tokenizeToArray(s.question);
            this.insertStmt.run(s.question, JSON.stringify(tokens), JSON.stringify([]), s.actionDSL);
        });
        this.rebuildAllVectors();
    }

    analyzeSelfIdentity() {
        this.ranaLog("Self Analysis", "自己紹介・名前に関する記憶からメタ認知を分析中...");

        const rows = this.db.prepare(`
            SELECT question, answer FROM qa 
            WHERE answer IS NOT NULL AND (
                question LIKE '%名前%' OR 
                question LIKE '%自己紹介%'
            )
        `).all();

        const introQuestionRegex = /(お?名前(は|何|を|って|教えて|なん|どう)|自己紹介|だれ|誰)/;
        const validRows = rows.filter(r => introQuestionRegex.test(r.question) && !r.question.includes('呼ばれたい'));

        const nameCounts = new Map();

        validRows.forEach(row => {
            let text = row.answer.trim();
            if (!text) return;

            text = text.replace(/^自己紹介(?:ですか|ですと)?[.・…\s]*/, '');

            const match = text.match(/^([^\s、。!?！？…]+?)(?:と申します|です|だよ|だー|だぞ|$)/);
            if (match && match[1]) {
                const candidate = match[1].trim();
                if (candidate.length >= 2 && !['自分', '名前', 'uwuzu', '公式'].includes(candidate)) {
                    nameCounts.set(candidate, (nameCounts.get(candidate) || 0) + 1);
                }
            }
        });

        if (nameCounts.size > 0) {
            const sortedByCount = Array.from(nameCounts.entries())
                .sort((a, b) => b[1] - a[1]);

            const candidates = sortedByCount.map(([name]) => name);
            const sortedByLen = [...candidates].sort((a, b) => a.length - b.length);

            let shortName = sortedByLen[0];
            let fullName = sortedByLen.slice(1).reverse().find(n => n.includes(shortName));

            if (!fullName && shortName.length > 2) {
                fullName = shortName;
                shortName = fullName.slice(-2);
            }

            this.selfConcept.name = shortName;
            this.selfConcept.fullName = fullName || `${shortName}ちゃん`;
            this.selfConcept.firstPerson = shortName;
            this.selfConcept.confidence = sortedByCount[0][1];

            this.ranaLog("Self Identity Found",
                `自己メタ認知を確立: 名前「${this.selfConcept.name}」 本名「${this.selfConcept.fullName}」 一人称「${this.selfConcept.firstPerson}」 (確信スコア: ${this.selfConcept.confidence})`
            );
        } else {
            this.selfConcept.name = 'らな';
            this.selfConcept.fullName = '柚晴らな';
            this.selfConcept.firstPerson = 'らな';
            this.selfConcept.confidence = 1;
            this.ranaLog("Self Identity Default", "自己紹介レコードが見つからないためデフォルトを適用しました");
        }
    }

    isSelfIntroContext(keyTokens) {
        if (!keyTokens || keyTokens.length === 0) return false;
        const lastWord = keyTokens[keyTokens.length - 1];
        const prevWord = keyTokens.length >= 2 ? keyTokens[keyTokens.length - 2] : '';

        if (lastWord === 'は' && ['私', 'わたし', 'ぼく', '僕', '名前', 'うち'].includes(prevWord)) {
            return true;
        }
        if (['名前', '名乗り'].includes(prevWord) && ['って', '：', ':'].includes(lastWord)) {
            return true;
        }
        if (prevWord === 'ほら' && (lastWord === '、' || lastWord === ',')) {
            return true;
        }

        return false;
    }

    getOrCreateSubconsciousEntry(talkId) {
        if (!this.userSubconscious.has(talkId)) {
            this.userSubconscious.set(talkId, {
                memories: new Map(),
                lastInteraction: Date.now()
            });
        }
        return this.userSubconscious.get(talkId);
    }

    observeSubconscious(talkId, userInput, tokens) {
        const entry = this.getOrCreateSubconsciousEntry(talkId);
        const now = Date.now();
        this.decaySubconscious(talkId, now);

        if (talkId && talkId !== 'default' && !['call', 'search', 'sns'].includes(talkId.toLowerCase())) {
            entry.memories.set(talkId, {
                weight: 1.0,
                category: 'id',
                lastSeen: now
            });
            this.ranaLog("Subconscious Priming", `対話相手のIDを認識しました: "${talkId}"`);
        }

        const mentionMatch = userInput.match(/@([a-zA-Z0-9_-]{3,20})/);
        if (mentionMatch) {
            const mentionedId = mentionMatch[1];
            if (!['call', 'search', 'sns', 'http', 'https', 'uwuzu'].includes(mentionedId.toLowerCase())) {
                entry.memories.set(mentionedId, {
                    weight: 0.9,
                    category: 'id',
                    lastSeen: now
                });
                this.ranaLog("Subconscious Priming", `話題に挙がったIDを認識しました: "${mentionedId}"`);
            }
        }

        tokens.forEach(tok => {
            if (tok.length >= 2 && !['こと', 'もの', 'そう', 'これ', 'それ', 'やつ'].includes(tok)) {
                const current = entry.memories.get(tok) || { weight: 0.2, category: 'noun', lastSeen: now };
                current.weight = Math.min(1.0, current.weight + 0.35);
                current.lastSeen = now;
                entry.memories.set(tok, current);
            }
        });

        entry.lastInteraction = now;
    }

    decaySubconscious(talkId, now = Date.now()) {
        const entry = this.getOrCreateSubconsciousEntry(talkId);
        const hoursPassed = (now - entry.lastInteraction) / (1000 * 60 * 60);
        if (hoursPassed <= 0) return;

        const decayFactor = Math.pow(0.5, hoursPassed / 1.0);
        for (const [key, mem] of entry.memories.entries()) {
            mem.weight *= decayFactor;
            if (mem.weight < 0.05) {
                entry.memories.delete(key);
            }
        }
    }

    getProminentId(talkId) {
        if (!this.userSubconscious.has(talkId)) return null;
        const entry = this.userSubconscious.get(talkId);
        let bestId = null;
        let maxWeight = 0;

        for (const [key, mem] of entry.memories.entries()) {
            if (mem.category === 'id' && mem.weight > maxWeight) {
                maxWeight = mem.weight;
                bestId = key;
            }
        }
        return maxWeight >= 0.3 ? bestId : null;
    }

    getProminentNouns(talkId, limit = 3) {
        if (!this.userSubconscious.has(talkId)) return [];
        const entry = this.userSubconscious.get(talkId);
        return Array.from(entry.memories.entries())
            .filter(([, mem]) => mem.category === 'noun' && mem.weight >= 0.4)
            .sort((a, b) => b[1].weight - a[1].weight)
            .slice(0, limit)
            .map(([word]) => word);
    }

    tokenizeToArray(text) {
        if (!text || !this.tokenizer) return [];
        return this.tokenizer.tokenize(text).map(t => t.surface_form).filter(tok => tok !== "");
    }

    filterNouns(text) {
        if (!text || !this.tokenizer) return [];
        const tokens = this.tokenizer.tokenize(text);
        const excludeDetails = ['非自立', '代名詞', '数', '接尾'];
        return tokens
            .filter(t => t.pos === '名詞' && !excludeDetails.includes(t.pos_detail_1) && t.surface_form.length > 0)
            .map(t => t.surface_form);
    }

    buildVocabAndDf(tokensList) {
        const df = new Map();
        tokensList.forEach(tokens => {
            const seen = new Set(tokens);
            seen.forEach(t => df.set(t, (df.get(t) || 0) + 1));
        });
        const vocab = Array.from(df.keys());
        return { vocab, df };
    }

    computeTfIdfVectors(tokensList, vocab, df) {
        const N = tokensList.length;
        const idf = vocab.map(term => Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1);
        return tokensList.map(tokens => {
            const tf = new Map();
            tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
            return vocab.map((term, i) => (tf.get(term) || 0) * idf[i]);
        });
    }

    cosine(a, b) {
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

    buildMarkovTable(n, sequences) {
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

    weightedRandomChoice(choices, temperature = 2.0, isSelfIntro = false, recentTokens = []) {
        const counts = {};
        choices.forEach(c => counts[c] = (counts[c] || 0) + 1);

        const myName = this.selfConcept?.name;
        const myFullName = this.selfConcept?.fullName;
        let appliedBias = false;

        const entries = Object.entries(counts).map(([tok, count]) => {
            let weight = Math.pow(count, 1 / temperature);

            if (isSelfIntro && myName) {
                if (tok === myName || tok === myFullName) {
                    weight *= 30.0;
                    appliedBias = true;
                } else if (tok !== '<END>') {
                    weight *= 0.1;
                }
            }

            const repeatCount = recentTokens.filter(t => t === tok).length;
            if (repeatCount > 0 && tok !== '<END>') {
                weight *= Math.pow(0.15, repeatCount);
            }

            return [tok, weight];
        });

        if (appliedBias) {
            this.ranaLog("Meta Cognition Bias", `自己言及文脈を検知: 「${myName}」の選択確率を強化しました`);
        }

        const total = entries.reduce((sum, [, w]) => sum + w, 0);
        let r = Math.random() * total;
        for (const [token, weight] of entries) {
            r -= weight;
            if (r <= 0) return token;
        }
        return entries[0][0];
    }


    generateFromMarkov(table, n, startKey = null, maxTokens = MAX_GENERATE_TOKENS) {
        const keys = Array.from(table.keys());
        if (keys.length === 0) return '';

        this.ranaLog("Start Key", startKey);

        let key = null;

        if (startKey && table.has(startKey)) {
            key = startKey;
        } else {
            const startKeys = keys.filter(k => k.startsWith('<START>'));
            if (startKeys.length > 0) {
                key = startKeys[Math.floor(Math.random() * startKeys.length)];
            } else {
                key = keys[Math.floor(Math.random() * keys.length)];
            }
        }

        const out = key.split('\u0001').filter(tok => tok !== '<START>');
        let loopcnt = 0;
        const recentTokens = [];
        const RECENT_WINDOW = 8;

        while (out.length < maxTokens) {
            loopcnt++;
            const choices = table.get(key);
            if (!choices || choices.length === 0) break;

            const currentKeyTokens = key.split('\u0001');
            const isSelfIntro = this.isSelfIntroContext(currentKeyTokens);

            const next = this.weightedRandomChoice(choices, 2.0, isSelfIntro, recentTokens);
            this.ranaLog("Generating Next Token Choice", next);
            if (next === '<END>') break;

            out.push(next);
            recentTokens.push(next);
            if (recentTokens.length > RECENT_WINDOW) recentTokens.shift();

            const nextKeyArr = out.slice(out.length - (n - 1), out.length);
            key = nextKeyArr.join('\u0001');
            if (!table.has(key)) break;
        }

        const result = out.join('');
        this.ranaLog("Generate Result", result);
        return result;
    }

    rebuildAllVectors() {
        this.ranaLog("Memory Consolidation", "記憶の整理とインデックス再構築を開始...");

        const rows = this.selectAllStmt.all().filter(r => r.answer);
        if (rows.length === 0) return;

        const N = rows.length;
        const df = new Map();
        const parsedRows = rows.map(r => {
            const tokens = JSON.parse(r.tokens || '[]');
            const uniqueTokens = new Set(tokens);
            uniqueTokens.forEach(t => df.set(t, (df.get(t) || 0) + 1));
            return { id: r.id, answer: r.answer, tokens };
        });

        this.idfMap.clear();
        for (const [term, freq] of df.entries()) {
            const idf = Math.log((N + 1) / (freq + 1)) + 1.0;
            this.idfMap.set(term, idf);
        }

        const updateVec = this.db.prepare('UPDATE qa SET vector = ? WHERE id = ?');
        this.cachedMemory = [];

        const updateTransaction = this.db.transaction((records) => {
            for (const rec of records) {
                const tf = new Map();
                rec.tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));

                const weights = {};
                let sumSq = 0;

                for (const [t, count] of tf.entries()) {
                    const idf = this.idfMap.get(t) || 1.0;
                    const w = count * idf;
                    weights[t] = w;
                    sumSq += w * w;
                }

                const norm = Math.sqrt(sumSq) || 1.0;
                const sparseVector = { norm, weights };

                updateVec.run(JSON.stringify(sparseVector), rec.id);

                this.cachedMemory.push({
                    id: rec.id,
                    answer: rec.answer,
                    tokens: rec.tokens,
                    norm: norm,
                    weights: weights
                });
            }
        });

        updateTransaction(parsedRows);
        this.ranaLog("Memory Consolidated", `${N} 件の記憶を疎ベクトルとして体系化しました`);
    }

    synthesizeKnowledge(externalText, keyword) {
        this.ranaLog("Synthesize Start", `外部知識「${keyword}」の自己咀嚼を開始`);

        const extTokens = this.tokenizeToArray(externalText);
        if (extTokens.length < 2) return null;

        const myAnswers = this.db.prepare(`
            SELECT answer FROM qa 
            WHERE answer IS NOT NULL ORDER BY RANDOM() LIMIT 30
        `).all();

        const personaEndings = [];
        const personaStarters = [];

        myAnswers.forEach(r => {
            const toks = this.tokenizeToArray(r.answer);
            if (toks.length >= 3) {
                personaEndings.push(toks.slice(-3).join(''));
                personaStarters.push(toks.slice(0, 2).join(''));
            }
        });

        if (personaEndings.length < 5) {
            personaEndings.push('んだよね〜', 'かも…！', 'ってこと！？', 'なんですね…', 'らしいですよ〜');
            personaStarters.push('ふへー、', 'えっ、', 'そういえば', 'やっぱり');
        }

        const baseContent = externalText.replace(/[。！？!?…\s]+$/g, '');
        
        const starter = Math.random() < 0.4 ? personaStarters[Math.floor(Math.random() * personaStarters.length)] : '';
        const ending = personaEndings[Math.floor(Math.random() * personaEndings.length)];

        let blended = `${starter}${baseContent}${ending}`;

        if (this.validateSynthesizedText(blended, keyword)) {
            this.ranaLog("Synthesize Success", `口調ブレンド成功: "${blended}"`);
            return blended;
        }

        const mixedSequences = [extTokens];
        myAnswers.forEach(r => mixedSequences.push(this.tokenizeToArray(r.answer)));
        const table2 = this.buildMarkovTable(2, mixedSequences);

        const matchedKeys = Array.from(table2.keys()).filter(k => k.includes(keyword));
        if (matchedKeys.length > 0) {
            const startKey = matchedKeys[Math.floor(Math.random() * matchedKeys.length)];
            const markovText = this.generateFromMarkov(table2, 2, startKey, 30);
            if (markovText && markovText !== externalText && this.validateSynthesizedText(markovText, keyword)) {
                this.ranaLog("Synthesize Success (Markov)", `マルコフ咀嚼成功: "${markovText}"`);
                return markovText;
            }
        }

        this.ranaLog("Synthesize Skip", "自然な自己咀嚼文が構成できなかったため、今回の学習を見送りました");
        return null;
    }

    validateSynthesizedText(text, keyword) {
        if (!text || text.length < 6 || text.length > 50) return false;

        if (!text.includes(keyword)) return false;

        const tokens = this.tokenizer.tokenize(text);
        if (tokens.length < 3) return false;

        const lastToken = tokens[tokens.length - 1];
        const lastSurface = lastToken.surface_form;

        if (lastToken.pos === '助詞' && !['よ', 'ね', 'わ', 'さ', 'か'].includes(lastSurface)) {
            return false;
        }
        if (['接頭詞', '接続詞'].includes(lastToken.pos)) {
            return false;
        }

        for (let i = 0; i < tokens.length - 1; i++) {
            if (tokens[i].pos === '助詞' && tokens[i + 1].pos === '助詞') {
                if (tokens[i].surface_form === tokens[i + 1].surface_form) {
                    return false;
                }
            }
        }

        if (/(\r\n|\n){2,}/.test(text) || /( |\s){3,}/.test(text)) {
            return false;
        }

        return true;
    }

    recallMemory(currentTokens, talkId = null) {
        if (!currentTokens || currentTokens.length === 0 || this.cachedMemory.length === 0) {
            return null;
        }

        const inputTf = new Map();
        currentTokens.forEach(t => inputTf.set(t, (inputTf.get(t) || 0) + 2.0));

        const inputWeights = {};
        let inputSumSq = 0;
        for (const [t, count] of inputTf.entries()) {
            const idf = this.idfMap.get(t) || 1.5;
            const w = count * idf;
            inputWeights[t] = w;
            inputSumSq += w * w;
        }
        const inputNorm = Math.sqrt(inputSumSq) || 1.0;

        const candidates = [];
        for (const rec of this.cachedMemory) {
            let dot = 0;
            for (const [t, wIn] of Object.entries(inputWeights)) {
                if (rec.weights[t]) {
                    dot += wIn * rec.weights[t];
                }
            }

            if (dot > 0) {
                const score = dot / (inputNorm * rec.norm);
                if (score >= SIM_THRESHOLD) {
                    candidates.push({ row: rec, score });
                }
            }
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => b.score - a.score);
        const topPool = candidates.slice(0, 8);
        const useMarkov = Math.random() < 0.7;

        if (useMarkov && topPool.length >= 2) {
            const sequences = topPool.map(t => this.tokenizeToArray(t.row.answer));

            if (talkId) {
                const prominentId = this.getProminentId(talkId);
                if (prominentId) {
                    sequences.push(['call', ':', 'uwuzu_follow', '(', '"', prominentId, '"', ')']);
                    sequences.push([prominentId, 'さん', 'を', 'フォロー', 'する', 'ね']);
                }
                const prominentNouns = this.getProminentNouns(talkId, 2);
                prominentNouns.forEach(noun => {
                    sequences.push([noun, 'の', 'こと', 'だ', 'よ', 'ね']);
                });
            }

            const table = this.buildMarkovTable(2, sequences);
            const generated = this.generateFromMarkov(table, 2, null, 60);

            if (generated && generated.length >= 3) {
                return generated;
            }
        }

        const chosen = topPool[Math.floor(Math.random() * Math.min(topPool.length, 4))];
        return chosen.row.answer;
    }

    generateRandomSeedText() {
        const allRows = this.selectAllStmt.all();
        const answers = allRows.filter(r => r.answer).map(r => this.tokenizeToArray(r.answer));
        const casuals = casualMutterings.map(t => this.tokenizeToArray(t));
        const seqs = [...answers.slice(0, 20), ...casuals];
        const table = this.buildMarkovTable(MARKOV_ORDER, seqs);
        return this.generateFromMarkov(table, MARKOV_ORDER, null, 40) || "ぼーっと...";
    }

    pulsePhysiology() {
        this.dopamine += (Math.random() - 0.51) * 0.005;
        this.dopamine = Math.min(1.0, Math.max(0.05, this.dopamine));

        this.noradrenaline += (Math.random() - 0.52) * 0.005;
        this.noradrenaline = Math.min(1.0, Math.max(0.01, this.noradrenaline));

        const now = new Date();
        const hour = now.getHours() + now.getMinutes() / 60;

        const circadianSleepiness = 0.5 * (1 + Math.cos((hour - 3) * (2 * Math.PI / 24)));

        this.energy = Math.max(0.0, this.energy - 0.000004);

        this.sleepDrive = Math.min(1.0, this.sleepDrive + 0.000005 + (circadianSleepiness * 0.00001));
    }

    checkSleepCondition() {
        const now = new Date();
        const hour = now.getHours();

        const fatigue = (1.0 - this.energy) * 0.4 + this.sleepDrive * 0.6;

        const stressMask = this.noradrenaline * 0.2;

        const isNightTime = (hour >= 23 || hour < 5);
        const baseThreshold = isNightTime ? 0.65 : 0.88;
        const threshold = baseThreshold + stressMask;

        if (fatigue >= threshold) {
            this.fallAsleep();
        }
    }

    syncCircadianToCurrentTime() {
        const now = new Date();
        const hour = now.getHours() + now.getMinutes() / 60;

        if (hour >= 23 || hour < 5) {
            this.energy = 0.15;
            this.sleepDrive = 0.85
            this.isSleeping = false;
            this.log('System', '深夜帯の起動を検知。まもなく睡眠ルーチンに入ります。');
        } else {
            this.energy = 0.85;
            this.sleepDrive = 0.15;
            this.isSleeping = false;
        }
    }

    getActionThreshold() {
        const baseThreshold = 0.65;
        const driveRatio = (1.0 + this.noradrenaline * 1.5) / (1.0 + this.dopamine * 2.0);
        const fatiguePenalty = (1.0 - this.energy) * 0.5;
        return Math.min(0.95, Math.max(0.1, baseThreshold * driveRatio + fatiguePenalty));
    }

    async dispatchAction(text) {
        const match = text.match(/call:([a-zA-Z0-9_]+)\((.*?)\)/);
        if (!match) return false;

        const [, funcName, rawArgs] = match;
        const arg = rawArgs.replace(/['"]/g, '').trim();

        if (!this.isActionReady(funcName)) {
            const remainingSec = Math.ceil(((this.actionCooldowns.get(funcName) || 0) - Date.now()) / 1000);
            this.ranaLog("Action Skipped", `「${funcName}」はまだ満足しているため実行を見送りました（残り ${remainingSec} 秒）`);
            return false;
        }

        this.emit('action_attempt', { action: funcName, arg });

        const handler = this.actionHandlers[funcName];
        const executeFn = typeof handler === 'function' ? handler : handler?.execute;

        if (typeof executeFn === 'function') {
            try {
                const result = await executeFn(arg, this);
                this.dopamine *= 0.4;

                this.triggerActionCooldown(funcName);

                if (result && result.learnedText) {
                    const digestedThought = this.synthesizeKnowledge(result.learnedText, result.keyword);

                    if (!digestedThought) {
                        this.ranaLog("Learn Skipped", `「${result.keyword}」の自己咀嚼が成立しなかったため、記憶への保存を見送りました`);
                        return true;
                    }

                    this.log('Learn', `新しい知識を自分の言葉で覚えました: [${result.keyword}] -> "${digestedThought}"`);

                    this.teachAnswer(
                        result.keyword,
                        digestedThought,
                        this.tokenizeToArray(result.keyword)
                    );

                    this.focusTokens = [result.keyword];
                    this.focusHistory.push(result.keyword);
                }
                return true;
            } catch (err) {
                this.noradrenaline = Math.min(1.0, this.noradrenaline + 0.15);
            }
        } else {
            this.emit('action_failed', { action: funcName, reason: 'not_implemented' });
            this.noradrenaline = Math.min(1.0, this.noradrenaline + 0.2);
            this.focusTokens = ['できない', funcName];
        }

        return true;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.log('Conscious', '思考を開始しました。');

        while (this.isRunning) {
            try {
                if (this.interruptQueue.length > 0) {
                    const task = this.interruptQueue.shift();
                    await this.processInterrupt(task.input, task.talkId, task.resolve);
                } else if (this.isSleeping) {
                    await this.processDreamStep();
                } else {
                    await this.processThoughtStep();
                }
            } catch (err) {
                this.log('Error', err.message);
            }

            await new Promise(r => setTimeout(r, THOUGHT_INTERVAL_MS));
        }
    }

    stop() {
        this.isRunning = false;
        this.log('Conscious', '思考を停止しました。');
    }

    pickRandomFocusTokens(count = 1) {
        const candidateNouns = [];

        const randomRows = this.db.prepare(`
            SELECT question, answer FROM qa 
            WHERE answer IS NOT NULL 
            ORDER BY RANDOM() LIMIT 10
        `).all();

        for (const row of randomRows) {
            const combinedText = `${row.question} ${row.answer}`.replace(/call:.*?\)/g, '');
            const nouns = this.filterNouns(combinedText).filter(n =>
                n.length >= 2 &&
                !this.focusHistory.includes(n) &&
                !['こと', 'もの', 'そう', 'これ', 'それ', 'やつ', '日常', '何か'].includes(n)
            );
            candidateNouns.push(...nouns);
        }

        for (const entry of this.userSubconscious.values()) {
            for (const [word, mem] of entry.memories.entries()) {
                if (mem.category === 'noun' && mem.weight >= 0.2 && !this.focusHistory.includes(word)) {
                    candidateNouns.push(word);
                }
            }
        }

        if (candidateNouns.length === 0) {
            casualMutterings.forEach(m => {
                candidateNouns.push(...this.filterNouns(m));
            });
        }

        const uniqueNouns = Array.from(new Set(candidateNouns)).filter(n => n && n !== '日常');
        if (uniqueNouns.length > 0) {
            const shuffled = uniqueNouns.sort(() => 0.5 - Math.random());
            return shuffled.slice(0, count);
        }

        const fallbacks = ['好き', '私', '寝る', 'かわいい'];
        return [fallbacks[Math.floor(Math.random() * fallbacks.length)]];
    }

    async processThoughtStep() {
        this.pulsePhysiology();
        this.checkSleepCondition();
        if (this.isSleeping) return;

        let thought = this.recallMemory(this.focusTokens);
        if (!thought) {
            thought = this.generateRandomSeedText();
        }
        this.currentThought = thought;
        
        this.ranaLog("Focus Tokens", this.focusTokens);
        this.ranaLog("current Thought", this.currentThought);

        const nouns = this.filterNouns(thought);
        if (nouns.length >= 3) {
            this.dopamine = Math.min(1.0, this.dopamine + 0.02);
        }

        this.speechUrge += 0.0002;
        if (thought.includes('！') || thought.includes('？')) {
            this.speechUrge += 0.0005;
        }

        const actionThreshold = this.getActionThreshold();
        const hasActionDSL = thought.includes('call:');

        if (this.dopamine > actionThreshold || hasActionDSL) {
            let actionToExecute = thought;

            if (!hasActionDSL) {
                const availableActions = this.getReadyActions();

                if (availableActions.length > 0) {
                    const chosenAction = availableActions[Math.floor(Math.random() * availableActions.length)];
                    const handler = this.actionHandlers[chosenAction];

                    const lastUserEntry = Array.from(this.userSubconscious.values()).pop();
                    const fallbackWord = this.focusTokens[0] || this.pickRandomFocusTokens(1)[0];
                    const actionContext = {
                        target: nouns[0] || fallbackWord,
                        nouns: nouns,
                        thought: this.currentThought,
                        prominentId: lastUserEntry ? this.getProminentId(Array.from(this.userSubconscious.keys()).pop()) : null,
                        prominentNoun: lastUserEntry ? this.getProminentNouns(Array.from(this.userSubconscious.keys()).pop(), 1)[0] : null
                    };

                    let arg = '';
                    if (typeof handler?.buildArg === 'function') {
                        arg = handler.buildArg(actionContext, this);
                    } else if (typeof handler === 'object' && handler.argType === 'none') {
                        arg = '';
                    } else {
                        arg = actionContext.target;
                    }

                    actionToExecute = (arg !== null && arg !== undefined && arg !== '')
                        ? `call:${chosenAction}("${arg}")`
                        : `call:${chosenAction}()`;

                } else {
                    actionToExecute = null;
                }
            }

            if (actionToExecute) {
                const acted = await this.dispatchAction(actionToExecute);
                if (acted) this.speechUrge *= 0.5;
            }
        } else if (this.speechUrge >= 1.0) {
            this.speak(this.currentThought.replace(/call:.*?\)/g, '').trim());
            this.speechUrge = 0.0;
            this.focusDwell = 0; 
        }

        this.focusDwell++;

        const shouldShiftFocus = this.focusDwell >= this.FOCUS_MIN_DWELL && Math.random() < 0.25;

        if (shouldShiftFocus) {
            const freshNouns = nouns.filter(n => !this.focusHistory.includes(n));

            if (freshNouns.length > 0) {
                const chosen = freshNouns[Math.floor(Math.random() * freshNouns.length)];
                this.focusTokens = [chosen];
                this.focusHistory.push(chosen);
                this.focusDwell = 0;
            } else {
                const freshPicks = this.pickRandomFocusTokens(1);
                this.ranaLog("Focus Boredom", `話題が尽きたため、記憶から「${freshPicks[0]}」を思い出しました`);
                this.focusTokens = freshPicks;
                if (freshPicks[0]) this.focusHistory.push(freshPicks[0]);
                this.focusDwell = 0;
            }

            if (this.focusHistory.length > this.MAX_FOCUS_HISTORY) {
                this.focusHistory.shift();
            }
        }

        this.emit('thought', {
            thought: this.currentThought,
            focus: this.focusTokens,
            energy: this.energy,
            dopamine: this.dopamine,
            noradrenaline: this.noradrenaline
        });
    }

    async processDreamStep() {
        const now = new Date();
        const hour = now.getHours();

        this.energy = Math.min(1.0, this.energy + 0.00001);
        this.sleepDrive = Math.max(0.0, this.sleepDrive - 0.000012);
        this.noradrenaline = Math.max(0.01, this.noradrenaline - 0.005);

        if (Math.random() < 0.005) {
            const dreamSeed = this.generateRandomSeedText();
            const nouns = this.filterNouns(dreamSeed);
            if (nouns.length > 0) this.focusTokens = [nouns[0]];
            this.emit('dream', { dream: dreamSeed });
        }

        const isMorning = (hour >= 6 && hour < 23);
        const fullyRested = (this.energy >= 0.95 && this.sleepDrive <= 0.15);

        if (fullyRested && (isMorning || this.energy >= 0.99)) {
            this.wakeUp();
        }
    }

    fallAsleep() {
        this.isSleeping = true;
        this.speechUrge = 0.0;
        this.log('Sleep', '気力・睡眠圧が限界に達しました。睡眠・記憶整理に入ります。');
        this.emit('sleep');

        setTimeout(() => {
            this.rebuildAllVectors();
            this.log('Sleep', '記憶の再インデックスと整理が完了しました。');
        }, 500);
    }

    wakeUp() {
        this.isSleeping = false;
        this.energy = 1.0;
        this.sleepDrive = 0.0;
        this.analyzeSelfIdentity();
        if (!this.focusTokens || this.focusTokens.length === 0 || this.focusTokens.includes('日常')) {
            this.focusTokens = this.pickRandomFocusTokens(1);
        }
        this.log('Wake', `目が覚めました。夢の余韻: [${this.focusTokens.join(', ')}]`);
        this.emit('wake', { focus: this.focusTokens, self: this.selfConcept });
    }

    speak(text) {
        if (!text || text.length === 0) return;
        this.emit('speak', text);
    }

    interact(input, talkId = 'default') {
        return new Promise(resolve => {
            this.interruptQueue.push({ input, talkId, resolve });
        });
    }

    async processInterrupt(input, talkId, resolve) {
        if (this.isSleeping) {
            if (this.energy < 0.4) {
                resolve("...いま寝てるから...あとにして...");
                return;
            }
            this.log('Wake', '話しかけられて目を覚ましました。');
            this.wakeUp();
        }

        const crisisWords = ['死ね', '消えろ', '嫌い', 'ダメ', 'は？', '違う'];
        if (crisisWords.some(w => input.includes(w))) {
            this.noradrenaline = Math.min(1.0, this.noradrenaline + 0.35);
        }

        const inputTokens = this.tokenizeToArray(input);
        const inputNouns = this.filterNouns(input);

        this.observeSubconscious(talkId, input, inputTokens);

        const load = inputTokens.length * 0.003;
        this.energy = Math.max(0.0, this.energy - load);
        this.sleepDrive = Math.min(1.0, this.sleepDrive + load * 1.5);

        // 自動学習判定
        const context = this.getOrCreateContext(talkId);
        if (context.pendingQuestion_token && context.pendingAnswer_token) {
            const score = this.estimateSatisfaction(input, talkId);
            if (score >= 0.75) {
                const combinedTokens = [...context.keywords.slice(-3), ...context.pendingQuestion_token];
                this.teachAnswer(
                    context.pendingQuestion_token.join(''),
                    context.pendingAnswer_token.join(''),
                    combinedTokens
                );
                this.dopamine = Math.min(1.0, this.dopamine + 0.15);
            }
            context.pendingQuestion_token = null;
            context.pendingAnswer_token = null;
        }

        let reply = this.recallMemory(inputTokens, talkId);
        if (!reply) {
            reply = "ごめんなさい...よくわかりませんでした...";
        } else {
            if (reply.includes('call:')) {
                await this.dispatchAction(reply);
                reply = reply.replace(/call:.*?\)/g, '').trim();
            }

            context.pendingQuestion_token = inputTokens;
            context.pendingAnswer_token = this.tokenizeToArray(reply);
        }

        if (inputNouns.length > 0) {
            this.focusTokens = inputNouns.slice(0, 2);
        }
        context.lastSeen = Date.now();
        this.speechUrge = 0.0;

        resolve(reply);
    }

    estimateSatisfaction(userInput, talkId) {
        const tokens = this.tokenizeToArray(userInput);
        const nouns = this.filterNouns(userInput);
        const context = this.getOrCreateContext(talkId);

        const hasQuestion = userInput.includes('？') || userInput.includes('?') ||
            tokens.some(t => ['なぜ', 'どうして', '何で', 'なんで', 'なにゆえ'].includes(t));
        if (hasQuestion) return 0;

        let infoDensityScore = (tokens.length <= 5 && nouns.length === 0) ? 0.8 : 0;
        let consistencyScore = 0;
        if (context.keywords.length > 0) {
            const overlap = nouns.filter(n => context.keywords.includes(n));
            if (nouns.length === 0 || overlap.length > 0) consistencyScore = 0.5;
        }

        const positiveWords = ['なるほど', '納得', 'そうなんだ', 'わかった', 'ありがとう', 'いいね', 'よかった'];
        const negativeWords = ['違う', 'いや', 'は？', '意味わかんない', 'ごめん'];

        let keywordScore = 0;
        if (tokens.some(t => positiveWords.includes(t))) keywordScore += 0.5;
        if (tokens.some(t => negativeWords.includes(t))) return 0;

        return Math.min(1.0, Math.max(infoDensityScore, keywordScore) + consistencyScore);
    }

    teachAnswer(question, answer, tokens) {
        const info = this.insertStmt.run(question, JSON.stringify(tokens), null, answer);
        
        let sumSq = 0;
        const weights = {};
        tokens.forEach(t => {
            const idf = this.idfMap.get(t) || 1.5;
            weights[t] = (weights[t] || 0) + idf;
            sumSq += idf * idf;
        });

        this.cachedMemory.push({
            id: info.lastInsertRowid,
            answer: answer,
            tokens: tokens,
            norm: Math.sqrt(sumSq) || 1.0,
            weights: weights
        });

        this.emit('learn', { question, answer });
    }

    studyInputText(question, answer, talkId = 'default') {
        const qTokens = this.tokenizeToArray(question);

        this.teachAnswer(question, answer, qTokens);

        this.dopamine = Math.min(1.0, this.dopamine + 0.25);
        this.noradrenaline = Math.max(0.01, this.noradrenaline - 0.1);

        const entry = this.getOrCreateSubconsciousEntry(talkId);
        entry.lastInteraction = Date.now();

        const thankSeedsPool = ['ありがとう', '感謝', '覚えた', '嬉しい', 'やったー', '助かる', '賢い', 
                            'ありがと', '覚えました', '助かり', 'うれしい', '嬉しい',
                            '勉強になります', '賢く', '把握', '了解', 'やったー', '最高'];
        const seed1 = thankSeedsPool[Math.floor(Math.random() * thankSeedsPool.length)];
        const seed2 = thankSeedsPool[Math.floor(Math.random() * thankSeedsPool.length)];
        
        let thanks = this.recallMemory([seed1, seed2], talkId);

        if (!thanks || thanks.length < 4) {
            const thankRows = this.db.prepare(`
                SELECT answer FROM qa 
                WHERE answer LIKE '%ありがとう%' OR answer LIKE '%感謝%' OR answer LIKE '%助か%' OR answer LIKE '%覚えた%'
                ORDER BY RANDOM() LIMIT 15
            `).all();

            const seqs = thankRows.map(r => this.tokenizeToArray(r.answer)).filter(s => s.length > 0);
            if (seqs.length >= 2) {
                const table = this.buildMarkovTable(2, seqs);
                thanks = this.generateFromMarkov(table, 2, null, 35);
            }
        }

        if (!thanks || thanks.length < 4) {
            const fallbackThanks = [
                "教えてくださりありがとうございます...！",
                "しっかり覚えました！",
                "また一つ賢くなれました！",
                "次からは自信を持って答えられます！",
                "ありがとうございます！しっかり学びました！"
            ];
            thanks = fallbackThanks[Math.floor(Math.random() * fallbackThanks.length)];
        }

        thanks = thanks.replace(/call:.*?\)/g, '').trim();

        this.focusTokens = ['覚えた', qTokens[0] || 'こと'];
        this.focusDwell = 0;

        return thanks;
    }

    getOrCreateContext(talkId) {
        if (!this.talkContexts[talkId]) {
            this.talkContexts[talkId] = {
                keywords: [],
                lastSeen: Date.now(),
                pendingQuestion_token: null,
                pendingAnswer_token: null
            };
        }
        return this.talkContexts[talkId];
    }

    log(tag, msg) {
        const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
        console.log(`[${time}][${tag.padEnd(9, ' ')}] ${msg}`);
    }
}

module.exports = RanaOrganism;