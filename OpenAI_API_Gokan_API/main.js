const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const rana = require('../core.js');
const config = require('../config.json');
const filter_words = require('../filter_words.json');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// APIキーの読み込み
const API_KEYS_FILE = './api_keys.json';

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function initializeApiKeys() {
    if (!fs.existsSync(API_KEYS_FILE)) {
        const newRawKey = `rana-${crypto.randomBytes(16).toString('hex')}`;
        const initialData = {
            keys: [
                {
                    name: "default",
                    hash: hashKey(newRawKey),
                    created_at: new Date().toISOString()
                }
            ]
        };

        fs.writeFileSync(API_KEYS_FILE, JSON.stringify(initialData, null, 2));

        console.log("--------------------------------------------------");
        console.log("【重要】新しいAPIキーファイルを作成しました");
        console.log("初期APIキーを表示します。メモしてください（一度しか表示されません）:");
        console.log(`Key: ${newRawKey}`);
        console.log("--------------------------------------------------");
    }
    return JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8')).keys;
}

let apiKeys = initializeApiKeys();

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Authentication required" });
    }

    const incomingKey = authHeader.split(' ')[1];
    const incomingHash = hashKey(incomingKey);

    const keyInfo = apiKeys.find(k => k.hash === incomingHash);

    if (!keyInfo) {
        return res.status(403).json({ error: "Invalid API Key" });
    }

    req.apiKeyName = keyInfo.name;
    next();
}



function generateMaskLabel(length) {
    const label = "自主規制";
    if (length <= 4) return `**[${label.substring(0, length)}]**`;
    const totalPadding = length - label.length;
    return `**[${' '.repeat(Math.floor(totalPadding / 2))}${label}${' '.repeat(Math.ceil(totalPadding / 2))}]**`;
}

function applyFilter(input) {
    if (!config.is_filter || !input) return input;
    const wordList = filter_words.forbiddenWords;
    const escapedWords = wordList.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(escapedWords.join('|'), 'g');
    return input.replace(pattern, (match) => generateMaskLabel(match.length));
}

// --- OpenAI 互換エンドポイント ---

// app.use('/v1', authenticate);

app.get('/v1/models', (req, res) => {
    res.json({
        object: "list",
        data: [{ id: "rana", object: "model", created: 1743513060, owned_by: "daichimarukana" }]
    });
});

// チャット補完
app.post('/v1/chat/completions', authenticate, async (req, res) => {
    const { messages, user } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Invalid messages format" });
    }

    const rawUserId = user || "user";
    const scopedUserId = `${req.apiKeyName}:${rawUserId}`;

    const lastMessage = messages[messages.length - 1];
    let userMessage = lastMessage && lastMessage.content ? String(lastMessage.content) : "";

    if (!userMessage.trim()) {
        return res.status(400).json({ error: "Message content cannot be empty" });
    }

    try {
        console.log(`[API Key: ${req.apiKeyName}] Scoped User: ${scopedUserId}`);
        let replyText = await rana.generateInputText(userMessage, scopedUserId);

        replyText = applyFilter(replyText);

        const response = {
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "rana",
            choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: replyText
                },
                finish_reason: "stop"
            }],
            usage: {
                prompt_tokens: rana.tokenCounter(userMessage), 
                completion_tokens: rana.tokenCounter(replyText),
                total_tokens: rana.tokenCounter(userMessage + replyText)
            }
        };

        res.json(response);
    } catch (error) {
        console.error("Rana API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// サーバー起動
const PORT = 4010; // 好きなポート番号
rana.init(config.rana_core_log).then(() => {
    const server = app.listen(PORT, () => {
        console.log(`OpenAI API Gokan API is running on http://localhost:${PORT}`);
        console.log(`Base URL for tools: http://localhost:${PORT}/v1`);
    });

    server.timeout = 300000;
});