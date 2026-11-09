const RanaOrganism = require('./core.js');
const { setApiBridge } = require('./actions.js');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const filter_words = require('./filter_words.json');
const Database = require('better-sqlite3');

// --- SQLiteデータベースの初期化 ---
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
const CHECK_INTERVAL = (config.check_interval || 10) * 1000;
const CORE_LOG = config.rana_core_log ?? false;
const IS_FILTER = config.is_filter ?? false;

const rana = new RanaOrganism(undefined, CORE_LOG);

function isReplied(id) {
    const row = db.prepare('SELECT id FROM replied_ids WHERE id = ?').get(id);
    return !!row;
}

function addReplied(id) {
    db.prepare('INSERT OR IGNORE INTO replied_ids (id) VALUES (?)').run(id);
}

function getAgreement(userId) {
    return db.prepare('SELECT userid, agreed_at FROM agreed_users WHERE userid = ?').get(userId);
}

function setAgreed(userId) {
    const now = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO agreed_users (userid, agreed_at) VALUES (?, ?)').run(userId, now);
}

function revokeAgreement(userId) {
    db.prepare('DELETE FROM agreed_users WHERE userid = ?').run(userId);
}

function isUserAgreed(userId) {
    return !!getAgreement(userId);
}

// JSONからSQLiteへの移行
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
    if (!IS_FILTER || !input || !wordList || wordList.length === 0) return input;
    const escapedWords = wordList.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(escapedWords.join('|'), 'g');
    return input.replace(pattern, (match) => generateMaskLabel(match.length));
}

async function postUeuse(text, replyId = null) {
    const filteredText = SayFilter(text, filter_words.forbiddenWords);
    const url = `https://${API_DOMAIN}/api/ueuse/create`;
    const payload = { token: API_TOKEN, text: filteredText };
    if (replyId) payload.replyid = replyId;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return await response.json();
}

async function followUser(userId) {
    const url = `https://${API_DOMAIN}/api/users/follow`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN, userid: userId })
        });
        const data = await response.json();
        return data.success ? data : null;
    } catch (e) {
        console.error(`フォローAPI通信エラー (対象: ${userId}):`, e.message);
        return null;
    }
}

async function getTimeline(limit = 30) {
    const url = `https://${API_DOMAIN}/api/ueuse/`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN, limit })
        });
        const data = await response.json();

        if (Array.isArray(data)) {
            return data;
        }

        if (typeof data === 'object' && data !== null) {
            return Object.values(data).filter(item => 
                typeof item === 'object' && item !== null && item.uniqid
            );
        }

        return [];
    } catch (e) {
        console.error("タイムライン取得エラー:", e.message);
        return [];
    }
}

async function getMentions() {
    const url = `https://${API_DOMAIN}/api/ueuse/mentions`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN })
        });
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (error) {
        return [];
    }
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
    } catch (error) {
        return [];
    }
}

async function getUserInfo(userId) {
    const url = `https://${API_DOMAIN}/api/users/`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: API_TOKEN, userid: userId })
        });
        const data = await response.json();
        return data.userid ? data : null;
    } catch (error) {
        return null;
    }
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
    } catch (error) {
        return null;
    }
}

setApiBridge({
    postUeuse: async (text) => {
        return await postUeuse(text);
    },
    fetchAgreedTimeline: async (limit = 30) => {
        const posts = await getTimeline(limit);
        return posts.filter(p => {
            if (!p || !p.text || !p.account) return false;
            if (p.account.is_bot) return false;
            return isUserAgreed(p.account.userid);
        });
    },
    searchAgreedUeuse: async (keyword, limit = 30) => {
        const url = `https://${API_DOMAIN}/api/ueuse/search`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: API_TOKEN, keyword, limit })
            });
            const data = await response.json();

            let posts = [];
            if (Array.isArray(data)) {
                posts = data;
            } else if (typeof data === 'object' && data !== null) {
                posts = Object.values(data).filter(item => 
                    typeof item === 'object' && item !== null && item.uniqid
                );
            }

            return posts.filter(p => {
                if (!p || !p.text || !p.account) return false;
                if (p.account.is_bot) return false;
                return isUserAgreed(p.account.userid);
            });
        } catch (e) {
            console.error("検索API通信エラー:", e.message);
            return [];
        }
    },
    followAgreedUser: async (userId) => {
        if (!isUserAgreed(userId)) {
            console.log(`[フォロースキップ] ユーザー「${userId}」は未同意のためフォローを見送りました。`);
            return null;
        }
        return await followUser(userId);
    }
});

const CONSENT_TEXT = `### ちょっとまって！
らなとお話しする前に、以下の内容に同意いただけますか？
- らなとお話するとらなはお話した内容を学んだり覚えたりします。
- らなは嘘をついたり間違えたりすることがあります。
- らなはAIではありません。節度を持って話しかけてください。

同意いただける場合は「同意します」とだけ返信してください！
-# 同意いただけないとお話はできません...！

-# これはシステムによるメッセージです。らなには届いていません。`;

const pendingTeachMap = new Map();

async function processReply(targetId) {
    const postData = await getPostById(targetId);
    if (!postData || !postData.text || !postData.account) return;

    const userId = postData.account.userid;
    const cleanedText = postData.text.replace(/@\w+\s?/, "").trim();

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
            await postUeuse("同意ありがとうございます！話しかけてみてくださいね\n\n-# これはシステムによるメッセージです。らなには届いていません。", targetId);
            addReplied(targetId);
        } else {
            await postUeuse(CONSENT_TEXT, targetId);
            addReplied(targetId);
        }
        return;
    }

    let replyText = "";

    if (postData.replyid && pendingTeachMap.has(postData.replyid)) {
        const originalQuestion = pendingTeachMap.get(postData.replyid);
        pendingTeachMap.delete(postData.replyid);

        replyText = rana.studyInputText(originalQuestion, cleanedText, userId);

        await postUeuse(replyText, targetId);
        addReplied(targetId);
        return;
    }

    replyText = await rana.interact(cleanedText, userId);

    if (replyText === "ごめんなさい...よくわかりませんでした...") {
        replyText = replyText + "\nなんと答えれば良いか、教えていただけますか？\n```\nらなちゃんにこう答えてほしい！という理想のメッセージを返信してください！\nそれが求められてる回答なんだ！って感じで学習します！\n何も学習させたくなければ、このユーズには返信しないでください！\n```";
        const res = await postUeuse(replyText, targetId);
        if (res && res.uniqid) {
            pendingTeachMap.set(res.uniqid, cleanedText);
        }
    } else {
        await postUeuse(replyText, targetId);
    }

    addReplied(targetId);
}

async function checkMentionsAndReplies() {
    try {
        const allMentions = await getMentions();
        const newMentions = allMentions.filter(m => !isReplied(m.uniqid) && m.account && !m.account.is_bot);

        const allReplies = await getReplies();
        const newReplies = allReplies.filter(r => !isReplied(r.valueid));

        for (const mention of newMentions) await processReply(mention.uniqid);
        for (const reply of newReplies) await processReply(reply.valueid);
    } catch (err) {
        console.error("ポーリング処理エラー:", err.message);
    }
}

async function startSystem() {
    migrateFromJson();

    await rana.init();

    rana.start();

    rana.on('speak', (text) => {
        console.log(`[独り言]: "${text}"`);
    });

    setInterval(checkMentionsAndReplies, CHECK_INTERVAL);
    checkMentionsAndReplies();

    console.log("起きた");
}

startSystem().catch(err => {
    console.error("システム起動失敗:", err);
});