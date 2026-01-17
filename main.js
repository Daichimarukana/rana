const rana = require('./core.js');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

// 返信済みIDを保存するファイルパス(いつかはSQLiteとかに移行したほうが良いのかも？)
const REPLIED_IDS_FILE = path.join(__dirname, 'replied_ids.json');

// --- ここを自分の環境に合わせて設定 ---
const API_DOMAIN = config.host;
const API_TOKEN = config.api_token;
const CHECK_INTERVAL = config.check_interval * 1000; // 5分間隔（ミリ秒）
const RANDOM_UEUSE = config.random_ueuse;
const CORE_LOG = config.rana_core_log;
// ------------------------------------

function getRandomInterval() {
    // ミリ秒単位で計算する
    const minMinutes = 3;
    const maxMinutes = 180;
    const interval = Math.random() * (maxMinutes - minMinutes) + minMinutes;
    return interval * 60 * 1000; // 分をミリ秒に変換
}

// 返信済みIDをファイルから読み込む関数
function loadRepliedIds() {
    try {
        if (fs.existsSync(REPLIED_IDS_FILE)) {
            const data = fs.readFileSync(REPLIED_IDS_FILE, 'utf8');
            return new Set(JSON.parse(data));
        }
    } catch (error) {
        console.error('返信済みIDファイルの読み込みに失敗しました:', error);
    }
    return new Set(); // ファイルがない、またはエラーの場合は空のSetを返す
}

// 返信済みIDをファイルに保存する関数
function saveRepliedIds(repliedIds) {
    try {
        fs.writeFileSync(REPLIED_IDS_FILE, JSON.stringify(Array.from(repliedIds)));
    } catch (error) {
        console.error('返信済みIDファイルの保存に失敗しました:', error);
    }
}

// ランダムな投稿処理
async function randomPostLoop() {
    console.log(`[${new Date().toLocaleString()}] ランダム投稿を開始します...`);

    // ランダムなテキストを生成
    const postText = rana.generateRandomText();
    console.log(`投稿テキスト: "${postText}"`);

    // 投稿するAPIを叩く
    const url = `https://${API_DOMAIN}/api/ueuse/create`;
    const params = {
        token: API_TOKEN,
        text: postText
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();
        if (data.uniqid) {
            console.log(`ランダム投稿に成功しました！(投稿ID: ${data.uniqid})`);
        } else {
            console.error('ランダム投稿に失敗しました。');
        }
    } catch (error) {
        console.error('ランダム投稿エラー:', error);
    }

    // 次の投稿までの時間をランダムに決めて、再度この関数を呼び出す
    const nextInterval = getRandomInterval();
    console.log(`次のランダム投稿は ${(nextInterval / 60000).toFixed(2)} 分後です。`);
    setTimeout(randomPostLoop, nextInterval);
}

async function getMentions() {
    const url = `https://${API_DOMAIN}/api/ueuse/mentions.php`;
    const params = { token: API_TOKEN };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();
        // 成功した場合はオブジェクトのキーを配列に変換
        if (data.success) {
            return Object.values(data).filter(item => typeof item === 'object');
        }
        return [];
    } catch (error) {
        console.error('メンション取得エラー:', error);
        return [];
    }
}

async function getReplies() {
    const url = `https://${API_DOMAIN}/api/me/notification/`;
    const params = { token: API_TOKEN };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();

        if (data.success) {
            return Object.values(data)
                .filter(item => typeof item === 'object' && item.category === 'reply' && item.valueid !== null);
        }
        return [];
    } catch (error) {
        console.error('返信通知取得エラー:', error);
        return [];
    }
}


// 返信を投稿するAPIを叩く関数
async function replyToPost(replyId, text) {
    const url = `https://${API_DOMAIN}/api/ueuse/create`;
    const params = {
        token: API_TOKEN,
        text: text,
        replyid: replyId
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('返信投稿エラー:', error);
        return { success: false };
    }
}

async function getPostById(postId) {
    const url = `https://${API_DOMAIN}/api/ueuse/get`;
    const params = { token: API_TOKEN, uniqid: postId };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();

        if (data.success) {
            // 数字キーの最初の要素を取得
            const firstKey = Object.keys(data).find(key => key !== "success");
            if (firstKey && data[firstKey] && data[firstKey].text) {
                return data[firstKey]; // 投稿データ全体を返す
            }
        }
        console.warn(`投稿ID ${postId} の本文が取得できませんでした。`);
        return null;
    } catch (error) {
        console.error(`投稿取得エラー (ID: ${postId}):`, error);
        return null;
    }
}

async function processReply(targetId, repliedIds, studyIds) {
    const postData = await getPostById(targetId);
    if (!postData || !postData.text) {
        console.log(`ID: ${targetId} の本文が取得できないためスキップします。`);
        return;
    }

    const cleanedText = postData.text.replace(/@\w+\s/, "");
    console.log(cleanedText)

    let replyResult = null;
    let replyText = "";

    console.log(postData)
    if (studyIds.has(postData.replyid)) {
        const QuestionSubData = await getPostById(postData.replyid);
        
        if (QuestionSubData && QuestionSubData.replyid) {
            const QuestionData = await getPostById(QuestionSubData.replyid);
            
            if (QuestionData && QuestionData.text) {
                replyText = rana.studyInputText(QuestionData.text, cleanedText, postData.account.userid);
            } else {
                console.warn("学習元の投稿(QuestionData)が見つかりませんでした。");
                replyText = rana.generateInputText(cleanedText, postData.account.userid); 
            }
        } else {
            console.warn("学習元の投稿(QuestionSubData)が見つからないか、親IDがありません。");
            replyText = rana.generateInputText(cleanedText, postData.account.userid);
        }
        
        studyIds.delete(QuestionSubData.uniqid);
    } else {
        replyText = rana.generateInputText(cleanedText, postData.account.userid);
    }

    if(replyText == "ごめんなさい...よくわかりませんでした..."){
        replyText = replyText+"\nなんと答えれば良いか、教えていただけますか？\n```\nらなちゃんにこう答えてほしい！という理想のメッセージを返信してください！\nそれが求められてる回答なんだ！って感じで学習します！\n何も学習させたくなければ、このユーズには返信しないでください！\n```"
        replyResult = await replyToPost(targetId, replyText);
        studyIds.add(replyResult.uniqid);
        console.log(studyIds);
    }else{
        replyResult = await replyToPost(targetId, replyText);
    }

    if (replyResult && replyResult.uniqid) {
        console.log(`返信に成功しました！(投稿ID: ${replyResult.uniqid})`);
        repliedIds.add(targetId);
    } else {
        console.error(`ID: ${targetId} への返信に失敗しました。`);
    }
}

const studyIds = new Set();
// メインの処理（メンション＋返信対応）
async function main() {
    console.log(`[${new Date().toLocaleString()}] メンション＆返信のチェックを開始します...`);

    const repliedIds = loadRepliedIds();

    // メンション取得
    const allMentions = await getMentions();
    const newMentions = allMentions.filter(mention =>
        !repliedIds.has(mention.uniqid) &&
        mention.account && !mention.account.is_bot
    );

    // 返信取得
    const allReplies = await getReplies();
    const newReplies = allReplies.filter(reply =>
        !repliedIds.has(reply.valueid) // 通知の valueid が元投稿 ID
    );

    console.log(`新しいメンション: ${newMentions.length} 件, 新しい返信: ${newReplies.length} 件`);

    // メンション処理
    for (const mention of newMentions) {
        await processReply(mention.uniqid, repliedIds, studyIds);
    }

    // 返信処理
    for (const reply of newReplies) {
        await processReply(reply.valueid, repliedIds, studyIds);
    }

    saveRepliedIds(repliedIds);
    console.log('今回の処理が完了しました。');
}

rana.init(CORE_LOG).then(() => {
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
