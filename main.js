const rana = require('./core.js');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const filter_words = require('./filter_words.json');
const Database = require('better-sqlite3'); // SQLiteライブラリ

// SQLiteデータベースの初期化
const db = new Database('bot_data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS replied_ids (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS agreed_users (
        userid TEXT PRIMARY KEY, 
        agreed_at TEXT
    );
`);

const REPLIED_IDS_FILE = path.join(__dirname, 'replied_ids.json');

// --- 設定 ---
const API_DOMAIN = config.host;
const API_TOKEN = config.api_token;
const CHECK_INTERVAL = config.check_interval * 1000;
const RANDOM_UEUSE = config.random_ueuse;
const CORE_LOG = config.rana_core_log;
const IS_FILTER = config.is_filter ?? false;

// 既読チェック
function isReplied(id) {
    const row = db.prepare('SELECT id FROM replied_ids WHERE id = ?').get(id);
    return !!row;
}

// 既読保存
function addReplied(id) {
    db.prepare('INSERT OR IGNORE INTO replied_ids (id) VALUES (?)').run(id);
}

// 同意情報を取得する（日時を含めて返す）
function getAgreement(userId) {
    return db.prepare('SELECT userid, agreed_at FROM agreed_users WHERE userid = ?').get(userId);
}

// 同意保存（現在時刻を記録）
function setAgreed(userId) {
    const now = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO agreed_users (userid, agreed_at) VALUES (?, ?)').run(userId, now);
}

// 同意取り消し
function revokeAgreement(userId) {
    db.prepare('DELETE FROM agreed_users WHERE userid = ?').run(userId);
}

// JSONからSQLiteへの自動移行
function migrateFromJson() {
    if (fs.existsSync(REPLIED_IDS_FILE)) {
        try {
            console.log('JSONファイルからSQLiteへの移行を開始します...');
            const data = JSON.parse(fs.readFileSync(REPLIED_IDS_FILE, 'utf8'));
            const insert = db.prepare('INSERT OR IGNORE INTO replied_ids (id) VALUES (?)');
            const transaction = db.transaction((ids) => {
                for (const id of ids) insert.run(id);
            });
            transaction(data);
            
            // 移行完了後にリネーム（バックアップとして残す）
            fs.renameSync(REPLIED_IDS_FILE, REPLIED_IDS_FILE + '.bak');
            console.log('移行が完了しました。');
        } catch (error) {
            console.error('移行に失敗しました:', error);
        }
    }
}

function generateMaskLabel(length) {
    const label = "自主規制";
    if (length <= 4) return `**[${label.substring(0, length)}]**`;
    const totalPadding = length - label.length;
    const leftPaddingSize = Math.floor(totalPadding / 2);
    const rightPaddingSize = totalPadding - leftPaddingSize;
    return `**[${' '.repeat(leftPaddingSize)}${label}${' '.repeat(rightPaddingSize)}]**`;
}

function SayFilter(input, wordList) {
    if (!input || wordList.length === 0) return input;
    const escapedWords = wordList.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(escapedWords.join('|'), 'g');
    return input.replace(pattern, (match) => generateMaskLabel(match.length));
}

function getRandomInterval() {
    const minMinutes = 3;
    const maxMinutes = 180;
    const interval = Math.random() * (maxMinutes - minMinutes) + minMinutes;
    return interval * 60 * 1000;
}

async function randomPostLoop() {
    console.log(`[${new Date().toLocaleString()}] ランダム投稿を開始します...`);
    let postText = rana.generateRandomText();
    if (IS_FILTER === true) postText = SayFilter(postText, filter_words.forbiddenWords);
    
    const url = `https://${API_DOMAIN}/api/ueuse/create`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN, text: postText })
        });
        const data = await response.json();
        if (data.uniqid) console.log(`成功 ID: ${data.uniqid}`);
    } catch (error) {
        console.error('ランダム投稿エラー:', error);
    }
    setTimeout(randomPostLoop, getRandomInterval());
}

async function getMentions() {
    const url = `https://${API_DOMAIN}/api/ueuse/mentions.php`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN })
        });
        const data = await response.json();
        return data.success ? Object.values(data).filter(item => typeof item === 'object') : [];
    } catch (error) { return []; }
}

async function getReplies() {
    const url = `https://${API_DOMAIN}/api/me/notification/`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN })
        });
        const data = await response.json();
        return data.success ? Object.values(data).filter(item => typeof item === 'object' && item.category === 'reply' && item.valueid !== null) : [];
    } catch (error) { return []; }
}

async function getUserInfo(userId) {
    const url = `https://${API_DOMAIN}/api/users/`;
    const params = {
        token: API_TOKEN,
        userid: userId
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();
        return data.userid ? data : null; 
    } catch (error) {
        console.error(`ユーザー情報取得エラー (ID: ${userId}):`, error);
        return null;
    }
}

async function replyToPost(replyId, text) {
    const url = `https://${API_DOMAIN}/api/ueuse/create`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN, text, replyid: replyId })
        });
        return await response.json();
    } catch (error) { return { success: false }; }
}

async function getPostById(postId) {
    const url = `https://${API_DOMAIN}/api/ueuse/get`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN, uniqid: postId })
        });
        const data = await response.json();
        if (data.success) {
            const firstKey = Object.keys(data).find(key => key !== "success");
            if (firstKey) return data[firstKey];
        }
        return null;
    } catch (error) { return null; }
}

// --- 同意確認メッセージ ---
const CONSENT_TEXT = `### ちょっとまって！
らなとお話しする前に、以下の内容に同意いただけますか？
- らなとお話するとらなはお話した内容を学んだり覚えたりします。
- らなは嘘をついたり間違えたりすることがあります。
- らなはAIではありません。節度を持って話しかけてください。

同意いただける場合は「同意します」とだけ返信してください！
-# 同意いただけないとお話はできません...！

-# これはシステムによるメッセージです。らなには届いていません。`;

async function processReply(targetId, studyIds) {
    const postData = await getPostById(targetId);
    if (!postData || !postData.text || !postData.account) return;

    const userId = postData.account.userid;
    const cleanedText = postData.text.replace(/@\w+\s/, "").trim();

    let agreement = getAgreement(userId);

    const userInfo = await getUserInfo(userId);
    
    if (agreement && userInfo && userInfo.registered_date) {
        const agreedDate = new Date(agreement.agreed_at);
        const registeredDate = new Date(userInfo.registered_date);

        if (registeredDate > agreedDate) {
            console.log(`ユーザー ${userId} のアカウント再作成を検知。同意をリセットします。`);
            revokeAgreement(userId);
            agreement = null;
        }
    }

    if (!agreement) {
        if (cleanedText === "同意します") {
            setAgreed(userId);
            await replyToPost(targetId, "同意ありがとうございます！話しかけてみてくださいね\n\n-# これはシステムによるメッセージです。らなには届いていません。");
            addReplied(targetId);
        } else {
            await replyToPost(targetId, CONSENT_TEXT);
            addReplied(targetId);
        }
        return;
    }

    let replyText = "";

    if (studyIds.has(postData.replyid)) {
        const QuestionSubData = await getPostById(postData.replyid);
        if (QuestionSubData && QuestionSubData.replyid) {
            const QuestionData = await getPostById(QuestionSubData.replyid);
            replyText = (QuestionData && QuestionData.text) 
                ? rana.studyInputText(QuestionData.text, cleanedText, userId) 
                : rana.generateInputText(cleanedText, userId);
        } else {
            replyText = rana.generateInputText(cleanedText, userId);
        }
        studyIds.delete(postData.replyid);
    } else {
        replyText = rana.generateInputText(cleanedText, userId);
    }

    if (replyText === "ごめんなさい...よくわかりませんでした...") {
        replyText = replyText+"\nなんと答えれば良いか、教えていただけますか？\n```\nらなちゃんにこう答えてほしい！という理想のメッセージを返信してください！\nそれが求められてる回答なんだ！って感じで学習します！\n何も学習させたくなければ、このユーズには返信しないでください！\n```"
        const res = await replyToPost(targetId, replyText);
        if (res.uniqid) studyIds.add(res.uniqid);
    } else {
        if (IS_FILTER === true) replyText = SayFilter(replyText, filter_words.forbiddenWords);
        await replyToPost(targetId, replyText);
    }
    addReplied(targetId);
}

const studyIds = new Set();

async function main() {
    console.log(`[${new Date().toLocaleString()}] チェック開始...`);

    const allMentions = await getMentions();
    const newMentions = allMentions.filter(m => !isReplied(m.uniqid) && m.account && !m.account.is_bot);

    const allReplies = await getReplies();
    const newReplies = allReplies.filter(r => !isReplied(r.valueid));

    for (const mention of newMentions) await processReply(mention.uniqid, studyIds);
    for (const reply of newReplies) await processReply(reply.valueid, studyIds);

    console.log('処理完了。');
}

rana.init(CORE_LOG).then(() => {
    migrateFromJson();
    // 10分ごとにメイン処理を実行
    setInterval(main, CHECK_INTERVAL);
    // 最初に一度実行する
    main();
    if(RANDOM_UEUSE === true){
        randomPostLoop();
    }
}).catch(err => {
    console.error("Initialization failed:", err);
});
